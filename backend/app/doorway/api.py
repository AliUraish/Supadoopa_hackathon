"""Doorway HTTP API (contract: backend/DOORWAY_API.md) and MCP endpoints.

    from app.doorway.api import install as doorway_install
    doorway_install(app)   # after billing.install(app)

Agent-facing: /doorway/requests, /doorway/mcp, /doorway/sites/{id}/mcp, /doorway/run/{site}/{tool}
(actions paid per call via MPP), /llms.txt. Dashboard: everything else; writes need a
Supabase session (Bearer). Workers (app/doorway/sandbox) consume the jobs queued here.
"""

from __future__ import annotations

import logging
import secrets
import statistics
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from mpp import Challenge, Credential
from mpp.errors import PaymentError
from mpp.server.decorator import make_challenge_response
from pydantic import BaseModel, Field

from ..billing import agents
from ..billing.auth import User, current_user
from ..billing.config import NotConfigured, get_settings
from ..billing.mpp import _claim_reference, get_mpp
from . import broker, demo
from .interfaces import JOB_PRIORITY, DoorwayStore
from .mcp_server import MCPResponse, build_server
from .store import StoreError, get_doorway_store

log = logging.getLogger(__name__)

router = APIRouter(prefix="/doorway", tags=["doorway"])
Store = Depends(get_doorway_store)
DEMO_USER = User(id="00000000-0000-4000-8000-00000000d00a", email="demo@doorway.local")
_bearer = HTTPBearer(auto_error=False)


async def dashboard_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> User:
    """Supabase user from the bearer token; with DOORWAY_DEMO_OPEN=1, no token = demo user."""
    if credentials is None and get_settings().doorway_demo_open:
        await _ensure_demo_user()
        return DEMO_USER
    resolve = request.app.dependency_overrides.get(current_user, current_user)
    if resolve is current_user:
        return await current_user(credentials)
    user = resolve()
    return await user if hasattr(user, "__await__") else user


_demo_user_ready = False


async def _ensure_demo_user() -> None:
    """Profiles/consents reference auth.users, so the shared demo user must exist there."""
    global _demo_user_ready
    settings = get_settings()
    if _demo_user_ready or not (settings.supabase_url and settings.supabase_secret_key):
        return
    import httpx

    key = settings.supabase_secret_key
    headers = {"apikey": key}
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{settings.supabase_url.rstrip('/')}/auth/v1/admin/users",
                headers=headers,
                json={"id": DEMO_USER.id, "email": DEMO_USER.email, "email_confirm": True},
            )
        # 200/201 created; 422 means it already exists.
        _demo_user_ready = r.status_code in (200, 201, 422)
        if not _demo_user_ready:
            log.warning("could not create the demo user: %s %s", r.status_code, r.text[:200])
    except httpx.HTTPError:
        log.warning("could not reach Supabase Auth to create the demo user")


SignedIn = Depends(dashboard_user)
SANDBOX_STALE_SECONDS = 60


# --- shaping rows into the contract's objects --------------------------------------------


def site_out(site: dict, tools: list[dict]) -> dict:
    own = [t for t in tools if t["site_id"] == site["id"]]
    return {
        **site,
        "tools_count": len(own),
        "verified_count": sum(t["status"] == "verified" for t in own),
        "mcp_url": f"{get_settings().public_api_url}/doorway/sites/{site['id']}/mcp",
    }


def tool_out(tool: dict) -> dict:
    spec = tool.get("spec") or {}
    return {
        **{k: v for k, v in tool.items() if k != "spec"},
        "price_cents": broker.price_cents(tool),
        "input_schema": spec.get("input_schema") or {"type": "object", "properties": {}},
        "profile_fields": spec.get("profile_fields") or {},
        "strategies": sorted(spec.get("strategies") or {}),
    }


def capability_out(cap: dict, tools: list[dict]) -> dict:
    tool = next(
        (
            t
            for t in tools
            if t.get("capability_id") == cap["id"]
            or (t["site_id"] == cap["site_id"] and t["name"] == cap["name"])
        ),
        None,
    )
    return {**cap, "tool_id": tool["id"] if tool else None}


async def _site_or_404(store: DoorwayStore, site_id: str) -> dict:
    site = await store.get_site(site_id)
    if site is None:
        raise HTTPException(404, {"error": "unknown_site"})
    return site


def _published_or_404(tool: dict | None) -> dict:
    if tool is None or tool["status"] == "draft" or not tool.get("spec"):
        raise HTTPException(404, {"error": "unknown_tool"})
    return tool


# --- sites ---------------------------------------------------------------------------------


class SiteIn(BaseModel):
    url: str = Field(min_length=4, max_length=500)
    name: str | None = Field(None, max_length=100)
    goal: str | None = Field(None, max_length=500)


@router.get("/sites")
async def list_sites(store: DoorwayStore = Store) -> list[dict]:
    tools = await store.list_tools()
    return [site_out(s, tools) for s in await store.list_sites()]


@router.post("/sites", status_code=202, dependencies=[SignedIn])
async def create_site(body: SiteIn, store: DoorwayStore = Store) -> dict:
    try:
        base_url = broker.normalize_url(body.url)
    except ValueError as error:
        raise HTTPException(422, {"error": "invalid_url", "message": str(error)}) from error
    existing = await broker.find_site_by_url(store, base_url)
    if existing and broker.normalize_url(existing["base_url"]) != base_url:
        existing = None
    known = existing or broker.demo_site(base_url) or {}
    slug = known.get("id") or (
        broker.slugify(body.name) if body.name else broker.slug_for_url(base_url)
    )
    site_id = known["id"] if existing else await broker.free_site_id(store, slug, base_url)
    row = {
        "id": site_id,
        "name": body.name or known.get("name") or site_id,
        "base_url": base_url,
        "goal": body.goal or known.get("goal"),
        "status": "queued",
    }
    if known.get("is_demo"):
        row["is_demo"] = True
    site = await store.upsert_site(row)
    await store.emit(
        site_id,
        "request.received",
        f"Discovery requested for {base_url}",
        {"goal": body.goal, "url": base_url},
    )
    job = await broker.queue_discovery(store, site, site.get("goal"))
    return {"site": site_out(site, await store.list_tools(site_id)), "job_id": job["id"]}


@router.get("/sites/{site_id}")
async def get_site(site_id: str, store: DoorwayStore = Store) -> dict:
    site = await _site_or_404(store, site_id)
    tools = await store.list_tools(site_id)
    return {
        "site": site_out(site, tools),
        "capabilities": [capability_out(c, tools) for c in await store.list_capabilities(site_id)],
        "tools": [tool_out(t) for t in tools],
        "events": await store.list_events(site_id, limit=50),
    }


@router.post("/sites/{site_id}/rediscover", status_code=202, dependencies=[SignedIn])
async def rediscover(site_id: str, store: DoorwayStore = Store) -> dict:
    site = await _site_or_404(store, site_id)
    await store.emit(site_id, "request.received", f"Rediscovery requested for {site['name']}")
    job = await broker.queue_discovery(store, site, site.get("goal"), rediscover=True)
    return {"job_id": job["id"]}


@router.post("/sites/{site_id}/break", dependencies=[SignedIn])
async def break_site(site_id: str, store: DoorwayStore = Store) -> dict:
    return {"version": await demo.break_site(await _site_or_404(store, site_id))}


@router.post("/sites/{site_id}/reset", dependencies=[SignedIn])
async def reset_site(site_id: str, store: DoorwayStore = Store) -> dict:
    return await demo.reset_site(await _site_or_404(store, site_id))


# --- tools -----------------------------------------------------------------------------------


@router.get("/tools")
async def list_tools(site_id: str | None = None, store: DoorwayStore = Store) -> list[dict]:
    return [tool_out(t) for t in await store.list_tools(site_id)]


@router.get("/tools/{tool_id}")
async def get_tool(tool_id: int, store: DoorwayStore = Store) -> dict:
    tool = await store.get_tool(tool_id)
    if tool is None:
        raise HTTPException(404, {"error": "unknown_tool"})
    return {
        "tool": {**tool_out(tool), "spec": tool.get("spec")},
        "versions": await store.list_versions(tool_id),
        "runs": await store.list_runs(tool_id),
    }


class ToolRunIn(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)
    use_profile: bool = False
    remember: bool = False
    pay: Literal["test"] | None = None


@router.post("/tools/{tool_id}/run")
async def run_tool(
    tool_id: int, body: ToolRunIn, user: User = SignedIn, store: DoorwayStore = Store
) -> dict:
    tool = _published_or_404(await store.get_tool(tool_id))
    payment = None
    if body.pay == "test" and tool["kind"] == "action":
        payment = await _test_payment(store, tool)
    outcome = await broker.run_tool(
        store,
        tool,
        body.arguments,
        user=user,
        use_profile=body.use_profile,
        remember=body.remember,
        mode="dashboard",
        paid_reference=payment["reference"] if payment else None,
    )
    result = {
        "ok": outcome.ok,
        "data": outcome.data,
        "error": outcome.error,
        "strategy": outcome.strategy,
        "ms": outcome.ms,
        "healed": outcome.healed,
        "run": outcome.run,
        "filled_from_profile": outcome.filled_from_profile,
    }
    if payment:
        result["payment"] = payment
    return result


# --- paid runs (MPP) ---------------------------------------------------------------------------


async def _charge(store: DoorwayStore, tool: dict, authorization: str | None):
    """Like app/billing/gateway.py: a 402 Response to relay, or (reference, receipt header)."""
    server = get_mpp()
    resource = f"{tool['site_id']}/{tool['name']}"
    amount = broker.price_usd(tool)
    try:
        result = await server.charge(
            authorization=authorization,
            amount=amount,
            description=f"Doorway: {resource}",
            # Bound into the challenge: a credential paid for one tool can't run another.
            extra={"resource": resource},
        )
    except PaymentError as error:
        if isinstance(error.retry_challenge, Challenge):
            return make_challenge_response(error.retry_challenge, server.realm, error)
        raise HTTPException(502, {"error": "payment_outcome_unknown"}) from error
    if isinstance(result, Challenge):
        await store.emit(
            tool["site_id"],
            "payment.challenge",
            f"{tool['name']}: sent a ${amount} payment challenge",
            {"tool_id": tool["id"]},
        )
        return make_challenge_response(result, server.realm)

    _credential, receipt = result
    if not await _claim_reference(
        {"reference": receipt.reference, "amount": amount, "currency": "usd", "resource": resource}
    ):
        raise HTTPException(409, {"error": "payment_already_used"})
    await store.emit(
        tool["site_id"],
        "payment.paid",
        f"Paid ${amount} for {tool['name']} ({receipt.reference})",
        {
            "tool_id": tool["id"],
            "reference": receipt.reference,
            "amount_cents": int(float(amount) * 100),
        },
    )
    return receipt.reference, receipt.to_payment_receipt()


async def _test_payment(store: DoorwayStore, tool: dict) -> dict:
    """Sandbox only: pay for a dashboard run with a freshly minted test SPT, over real MPP."""
    if get_settings().stripe_live:
        raise HTTPException(403, {"error": "sandbox_only"})
    server = get_mpp()  # 503 without STRIPE_SECRET_KEY / STRIPE_PROFILE_ID
    resource = f"{tool['site_id']}/{tool['name']}"
    offer = await server.charge(
        authorization=None,
        amount=broker.price_usd(tool),
        description=f"Doorway: {resource}",
        extra={"resource": resource},
    )
    cents = broker.price_cents(tool)
    token = (await agents.mint_test_token(agents.TestTokenIn(amount=cents)))["shared_payment_token"]
    credential = Credential(challenge=offer.to_echo(), payload={"spt": token})
    paid = await _charge(store, tool, credential.to_authorization())
    if isinstance(paid, Response):
        raise HTTPException(402, {"error": "payment_failed"})
    reference, receipt = paid
    return {"reference": reference, "amount_cents": cents, "receipt": receipt}


@router.post("/run/{site_id}/{tool_name}")
async def run_paid(
    site_id: str,
    tool_name: str,
    request: Request,
    body: dict[str, Any] | None = Body(None),
    store: DoorwayStore = Store,
):
    """Agents' plain-HTTP tool call, and the paymentLink target. Actions: 402 until paid."""
    tool = _published_or_404(await store.find_tool(site_id, tool_name))
    body = body or {}
    args = body["arguments"] if isinstance(body.get("arguments"), dict) else body
    if missing := broker.missing_inputs(tool, args):  # before charging, not after
        raise HTTPException(422, {"error": "missing_inputs", "missing": missing})

    headers, reference = {}, None
    if tool["kind"] == "action":
        paid = await _charge(store, tool, request.headers.get("authorization"))
        if isinstance(paid, Response):
            return paid  # 402 + WWW-Authenticate, verbatim
        reference, headers["Payment-Receipt"] = paid

    outcome = await broker.run_tool(store, tool, args, mode="broker", paid_reference=reference)
    if outcome.ok:
        content = {
            "ok": True,
            "data": outcome.data,
            "strategy": outcome.strategy,
            "ms": outcome.ms,
            "healed": outcome.healed,
        }
        return JSONResponse(content, headers=headers)
    content = {"ok": False, "error": outcome.error, "healed": outcome.healed}
    if reference:
        # Paid but not served: keep the reference so the payment can be refunded.
        log.warning("paid run of %s failed; refund %s", tool["id"], reference)
        content |= {"payment_reference": reference, "refundable": True}
    return JSONResponse(content, status_code=502 if outcome.broken else 400, headers=headers)


# --- agent requests -------------------------------------------------------------------------


class RequestIn(BaseModel):
    website: str = Field(min_length=4, max_length=500)
    task: str = Field(min_length=2, max_length=500)
    inputs: dict[str, Any] = Field(default_factory=dict)


def _request_out(request: dict, tool: dict | None) -> dict:
    result = request.get("result") or {}
    return {
        "request_id": request["id"],
        "site_id": request.get("site_id"),
        "task": request["task"],
        "status": request["status"],
        "result": result.get("data"),
        "error": result.get("error"),
        "healed": result.get("healed", False),
        "tool": tool_out(tool) if tool else None,
        "run": result.get("run"),
    }


@router.post("/requests", status_code=202)
async def create_request(
    body: RequestIn, background: BackgroundTasks, store: DoorwayStore = Store
) -> dict:
    try:
        request, tool = await broker.handle_request(store, body.website, body.task, body.inputs)
    except ValueError as error:
        raise HTTPException(422, {"error": "invalid_url", "message": str(error)}) from error
    if tool is not None and tool["kind"] == "action":
        request = await broker.advance(store, request)  # hands out the paymentLink now
    elif tool is not None:
        background.add_task(broker.advance, store, request)
    return _request_out(request, tool)


@router.get("/requests/{request_id}")
async def get_request(request_id: str, store: DoorwayStore = Store) -> dict:
    request = await store.get_request(request_id)
    if request is None:
        raise HTTPException(404, {"error": "unknown_request"})
    if request["status"] == "discovering":
        request = await broker.advance(store, request)
    tool = await store.get_tool(request["tool_id"]) if request.get("tool_id") else None
    return _request_out(request, tool)


# --- races ----------------------------------------------------------------------------------


class RaceIn(BaseModel):
    site_id: str
    task: str = Field(min_length=2, max_length=500)
    inputs: dict[str, Any] = Field(default_factory=dict)


@router.post("/race", status_code=202, dependencies=[SignedIn])
async def create_race(body: RaceIn, store: DoorwayStore = Store) -> dict:
    await _site_or_404(store, body.site_id)
    race_id = f"race_{secrets.token_hex(4)}"
    site = await store.get_site(body.site_id)
    # doorway_races is publicly readable: it gets input names only. The values go in the
    # private doorway_requests row with the same id, where the race worker reads them.
    await store.create_request(
        {
            "id": race_id,
            "website": site["base_url"],
            "task": body.task,
            "site_id": body.site_id,
            "status": "executing",
            "inputs": body.inputs,
        }
    )
    await store.create_race(
        {
            "id": race_id,
            "site_id": body.site_id,
            "task": body.task,
            "inputs": {name: "[private]" for name in body.inputs},
            "status": "queued",
        }
    )
    await store.enqueue_job(
        {
            "kind": "race",
            "site_id": body.site_id,
            "priority": JOB_PRIORITY["race"],
            "payload": {"race_id": race_id},
        }
    )
    return {"race_id": race_id}


@router.get("/races/{race_id}")
async def get_race(race_id: str, store: DoorwayStore = Store) -> dict:
    race = await store.get_race(race_id)
    if race is None:
        raise HTTPException(404, {"error": "unknown_race"})
    return race


# --- swarm: sandboxes, jobs, patterns, messages, events, graph, metrics -----------------------


@router.get("/sandboxes")
async def list_sandboxes(store: DoorwayStore = Store) -> list[dict]:
    now = datetime.now(UTC)
    sandboxes = await store.list_sandboxes()
    for sandbox in sandboxes:
        try:
            seen = datetime.fromisoformat(str(sandbox["last_heartbeat"]).replace("Z", "+00:00"))
        except ValueError:
            continue
        if (now - seen).total_seconds() > SANDBOX_STALE_SECONDS:
            sandbox["status"] = "offline"  # stopped heartbeating
    return sandboxes


@router.get("/jobs")
async def list_jobs(status: str | None = None, store: DoorwayStore = Store) -> list[dict]:
    return await store.list_jobs(status, 100)


@router.get("/patterns")
async def list_patterns(store: DoorwayStore = Store) -> list[dict]:
    return await store.list_patterns()


@router.get("/messages")
async def list_messages(since: int = 0, store: DoorwayStore = Store) -> list[dict]:
    return await store.list_messages(since)


@router.get("/events")
async def list_events(
    site_id: str | None = None, since: int = 0, store: DoorwayStore = Store
) -> list[dict]:
    return await store.list_events(site_id, since, 200)


@router.get("/graph")
async def graph(store: DoorwayStore = Store) -> dict:
    sites, caps = await store.list_sites(), await store.list_capabilities()
    tools, patterns = await store.list_tools(), await store.list_patterns()
    nodes = [
        {"id": f"site:{s['id']}", "type": "site", "label": s["name"], "status": s["status"]}
        for s in sites
    ]
    nodes += [
        {"id": f"cap:{c['id']}", "type": "capability", "label": c["name"], "status": c["status"]}
        for c in caps
    ]
    nodes += [
        {"id": f"tool:{t['id']}", "type": "tool", "label": t["name"], "status": t["status"]}
        for t in tools
    ]
    nodes += [
        {"id": f"pattern:{p['id']}", "type": "pattern", "label": p["name"], "status": "shared"}
        for p in patterns
    ]
    edges = [{"from": f"site:{c['site_id']}", "to": f"cap:{c['id']}", "type": "has"} for c in caps]
    pattern_ids = {p["id"] for p in patterns}
    for tool in tools:
        cap = next(
            (
                c
                for c in caps
                if c["id"] == tool.get("capability_id")
                or (c["site_id"] == tool["site_id"] and c["name"] == tool["name"])
            ),
            None,
        )
        source = f"cap:{cap['id']}" if cap else f"site:{tool['site_id']}"
        edges.append(
            {"from": source, "to": f"tool:{tool['id']}", "type": "compiled_to" if cap else "has"}
        )
        if tool.get("pattern_id") in pattern_ids:
            edges.append(
                {
                    "from": f"tool:{tool['id']}",
                    "to": f"pattern:{tool['pattern_id']}",
                    "type": "reuses",
                }
            )
    return {"nodes": nodes, "edges": edges}


def _p50(values: list[int]) -> int | None:
    return round(statistics.median(values)) if values else None


@router.get("/metrics")
async def metrics(store: DoorwayStore = Store) -> dict:
    sites, tools = await store.list_sites(), await store.list_tools()
    patterns = await store.list_patterns()
    runs = [r for r in await store.list_runs(None, 1000) if r["mode"] != "verify"]
    prices = {t["id"]: broker.price_cents(t) for t in tools}

    def p50(modes: tuple[str, ...]) -> int | None:
        return _p50(
            [
                r["ms"]
                for r in runs
                if r["mode"] in modes and r["status"] == "success" and r.get("ms") is not None
            ]
        )

    heals = 0
    for tool in tools:
        heals += sum(v["source"] == "heal" for v in await store.list_versions(tool["id"]))
    return {
        "sites": len(sites),
        "tools_verified": sum(t["status"] == "verified" for t in tools),
        "runs": len(runs),
        "success_rate": (
            round(sum(r["status"] == "success" for r in runs) / len(runs), 3) if runs else None
        ),
        "broker_p50_ms": p50(("broker", "dashboard")),
        "browser_p50_ms": p50(("browser_agent",)),
        "heals": heals,
        "revenue_cents": sum(
            prices.get(r.get("tool_id"), broker.ACTION_PRICE_CENTS)
            for r in runs
            if r.get("paid_reference")
        ),
        "patterns": len(patterns),
        "reuse_count": sum(
            len([s for s in p.get("used_by") or [] if s != p.get("source_site_id")])
            for p in patterns
        ),
    }


# --- profile + consent -----------------------------------------------------------------------


class ProfileIn(BaseModel):
    fields: dict[str, Any]


class ConsentIn(BaseModel):
    site_id: str
    fields: list[str] = Field(min_length=1)


@router.get("/profile")
async def get_profile(user: User = SignedIn, store: DoorwayStore = Store) -> dict:
    return await store.get_profile(user.id)


@router.put("/profile")
async def put_profile(body: ProfileIn, user: User = SignedIn, store: DoorwayStore = Store) -> dict:
    return await store.save_profile(user.id, body.fields)


@router.get("/consents")
async def list_consents(user: User = SignedIn, store: DoorwayStore = Store) -> list[dict]:
    return await store.list_consents(user.id)


@router.post("/consents")
async def grant_consent(
    body: ConsentIn, user: User = SignedIn, store: DoorwayStore = Store
) -> dict:
    await _site_or_404(store, body.site_id)
    return await store.grant_consent(user.id, body.site_id, body.fields)


@router.delete("/consents/{consent_id}", status_code=204)
async def revoke_consent(
    consent_id: int, user: User = SignedIn, store: DoorwayStore = Store
) -> Response:
    await store.revoke_consent(user.id, consent_id)
    return Response(status_code=204)


# --- MCP ---------------------------------------------------------------------------------------

# Stateless: POST only. GET (a standalone SSE stream) and DELETE (end a session) get 405.


@router.post("/mcp", include_in_schema=False)
async def mcp_all(request: Request, store: DoorwayStore = Store) -> Response:
    return MCPResponse(build_server(store, pay=_owner_pay(request, store)))


@router.post("/sites/{site_id}/mcp", include_in_schema=False)
async def mcp_site(site_id: str, request: Request, store: DoorwayStore = Store) -> Response:
    await _site_or_404(store, site_id)
    return MCPResponse(build_server(store, site_id, pay=_owner_pay(request, store)))


def _owner_pay(request: Request, store: DoorwayStore):
    """The owner's own Claude (X-Doorway-Key) runs actions directly, paid in Stripe test mode."""
    settings = get_settings()
    key = request.headers.get("x-doorway-key") or ""
    if not settings.doorway_owner_key or settings.stripe_live:
        return None
    if not secrets.compare_digest(key, settings.doorway_owner_key):
        return None

    async def pay(tool: dict) -> dict:
        return await _test_payment(store, tool)

    return pay


# --- /llms.txt + install ------------------------------------------------------------------------


async def llms_txt(request: Request) -> PlainTextResponse:
    """Billing's /llms.txt, plus what agents can call through Doorway."""
    text = await agents.llms_txt(request)
    base = str(request.base_url).rstrip("/")
    try:
        store = request.app.dependency_overrides.get(get_doorway_store, get_doorway_store)()
        tools = [
            t for t in await store.list_tools() if t["status"] in broker.CALLABLE and t.get("spec")
        ]
    except (NotConfigured, StoreError, OSError):
        tools = []
    if tools:
        lines = [
            "",
            "## Website tools (Doorway)",
            f"MCP (streamable HTTP): {base}/doorway/mcp, or {base}/doorway/sites/<site>/mcp",
            f'Ask for a task: POST {base}/doorway/requests {{"website", "task", "inputs"}}',
        ]
        for tool in tools:
            price = (
                f"{broker.price_usd(tool)} USD per call (MPP)"
                if tool["kind"] == "action"
                else "free"
            )
            lines.append(
                f"- POST {base}/doorway/run/{tool['site_id']}/{tool['name']}: {price}. "
                f"{tool.get('description') or ''}".rstrip()
            )
        text += "\n".join(lines) + "\n"
    return PlainTextResponse(text)


def install(app: FastAPI) -> None:
    app.include_router(router)
    # Serve /llms.txt ahead of billing's (which ours extends).
    app.add_api_route("/llms.txt", llms_txt, methods=["GET"], include_in_schema=False)
    app.router.routes.insert(0, app.router.routes.pop())
    getattr(app.router, "_mark_routes_changed", lambda: None)()


async def seed_site(url: str, name: str | None = None, goal: str | None = None) -> dict:
    """Add a site and queue discovery without the HTTP auth layer (local scripts only)."""
    from .store import get_doorway_store

    created = await create_site(SiteIn(url=url, name=name, goal=goal), store=get_doorway_store())
    return {"site_id": created["site"]["id"], "job_id": created["job_id"]}


# --- lessons + OpenAPI (ideas reused from the team's Skeleton Key) ---------------------------


@router.get("/lessons")
async def list_lessons(
    status: str | None = None, scope: str | None = None, store: DoorwayStore = Store
) -> list[dict]:
    """Shared memory of fixed mistakes. Explorers read the approved ones before every site."""
    return await store.list_lessons(status=status, scope=scope)


class LessonStatusIn(BaseModel):
    status: Literal["approved", "rejected", "proposed"]


@router.post("/lessons/{lesson_id}", dependencies=[SignedIn])
async def set_lesson_status(
    lesson_id: int, body: LessonStatusIn, store: DoorwayStore = Store
) -> dict:
    await store.set_lesson_status(lesson_id, body.status)
    return {"id": lesson_id, "status": body.status}


@router.get("/sites/{site_id}/openapi.json")
async def site_openapi(site_id: str, store: DoorwayStore = Store) -> dict:
    """The site's published tools as an OpenAPI 3.1 spec (each tool is POST /doorway/run/...)."""
    site = await _site_or_404(store, site_id)
    tools = [
        t
        for t in await store.list_tools(site_id)
        if t["status"] in ("verified", "repairing") and t.get("spec")
    ]
    paths = {}
    for tool in tools:
        spec, price = tool["spec"], broker.price_cents(tool)
        responses = {
            "200": {"description": "Tool result: {ok, data, strategy, ms, healed}"},
            "400": {"description": "Rejected by the site (bad input, slot taken…)"},
            "422": {"description": "Missing inputs"},
            "502": {"description": "Tool broken and self-healing failed"},
        }
        if price:
            responses["402"] = {
                "description": "Payment required (MPP). Pay with a Stripe SPT and retry with "
                "Authorization: Payment …; the receipt comes back in Payment-Receipt."
            }
        paths[f"/doorway/run/{site_id}/{tool['name']}"] = {
            "post": {
                "operationId": tool["name"],
                "summary": spec.get("description", "")[:120],
                "description": spec.get("description", ""),
                "x-doorway-kind": spec.get("kind") or tool["kind"],
                "x-doorway-side-effect": spec.get("side_effect"),
                "x-price-usd": f"{price / 100:.2f}",
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {"arguments": spec.get("input_schema") or {}},
                                "required": ["arguments"],
                            }
                        }
                    },
                },
                "responses": responses,
            }
        }
    return {
        "openapi": "3.1.0",
        "info": {
            "title": f"{site['name']} (via Doorway)",
            "description": f"Verified tools for {site['base_url']}",
            "x-mcp": f"/doorway/sites/{site_id}/mcp",
            "version": str(max((t["version"] for t in tools), default=0)),
        },
        "servers": [{"url": get_settings().public_api_url}],
        "paths": paths,
    }


@router.get("/live")
async def live_view() -> dict:
    """Where to watch the sandboxes' browsers + workflow (Supabase Compute, public).

    Embed `url` in an iframe; `state_url` is the JSON the page polls.
    """
    settings = get_settings()
    base = settings.doorway_live_url or (
        f"{settings.supabase_url.rstrip('/')}/compute/v1/doorway-sandbox/"
        if settings.supabase_url
        else None
    )
    return {"url": base, "state_url": f"{base}state" if base else None}

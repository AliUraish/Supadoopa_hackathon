"""The broker: runs a verified tool for an agent or the dashboard, and answers agent requests.

run_tool() fills inputs from the user's saved details (consented fields only), executes the
tool's preferred strategy, records the run and, when the site changed underneath the tool,
asks a sandbox to heal it, waits, and retries once. handle_request()/advance() serve
POST /doorway/requests: look up a verified tool for the task, or queue discovery.

Input values can be personal details (a patient's name, a phone number): events, runs and
messages only ever carry input NAMES.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import statistics
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from ..billing.auth import User
from ..billing.config import get_settings
from . import executor
from .interfaces import JOB_PRIORITY, DoorwayStore, ExecResult

log = logging.getLogger(__name__)

HEAL_TIMEOUT = 60.0  # seconds a call waits for a sandbox to repair its tool
HEAL_POLL = 0.5
# Serverless hosts (Vercel) have no browser: calls there run the api strategy only, and
# form/browser strategies run in the sandboxes (which also heal a broken api strategy).
HAS_BROWSER = not os.environ.get("VERCEL") and os.environ.get("DOORWAY_BROWSER") != "0"
ACTION_PRICE_CENTS = 50  # Stripe's card minimum for Shared Payment Tokens
STATS_WINDOW = 50  # runs behind a tool's success_rate / p50_ms
# Tools that run. "repairing": the preferred strategy broke but a fallback still works.
CALLABLE = ("verified", "repairing")
MODE_LABEL = {"broker": "Agent", "dashboard": "Dashboard", "browser_agent": "Browser agent"}


@dataclass
class Outcome:
    ok: bool
    data: Any = None
    error: str | None = None
    strategy: str | None = None
    ms: int = 0
    steps: int = 0
    healed: bool = False
    broken: bool = False
    run: dict | None = None
    filled_from_profile: list[str] = field(default_factory=list)


# --- prices and payment links ------------------------------------------------------------


def price_cents(tool: dict) -> int:
    """Reads are free; actions cost their price, at least the card minimum."""
    if tool.get("kind") != "action":
        return 0
    return max(tool.get("price_cents") or 0, ACTION_PRICE_CENTS)


def price_usd(tool: dict) -> str:
    return f"{price_cents(tool) / 100:.2f}"


def run_url(tool: dict) -> str:
    return f"{get_settings().public_api_url}/doorway/run/{tool['site_id']}/{tool['name']}"


def payment_link(tool: dict, arguments: dict | None = None) -> dict:
    """What a paid action returns instead of running (Stripe's MCP pattern: JSON-RPC can't 402)."""
    network = get_settings().stripe_profile_id or "the networkId in the 402 challenge"
    return {
        "payment_required": True,
        "paymentLink": run_url(tool),
        "amount": f"{price_usd(tool)} USD",
        "method": "POST",
        "body": {"arguments": arguments or {}},
        "instructions": {
            "agent": (
                "POST {arguments} to paymentLink; on 402 pay with an SPT (link-cli) for "
                f"networkId {network} and retry"
            ),
        },
    }


def missing_inputs(tool: dict, arguments: dict) -> list[str]:
    schema = (tool.get("spec") or {}).get("input_schema") or {}
    return [name for name in schema.get("required", []) if _blank(arguments.get(name))]


def _blank(value: Any) -> bool:
    return value is None or value == ""


def _scrub(text: str | None, args: dict) -> str | None:
    """Site errors can echo the inputs; events, runs and messages never keep the values."""
    for value in args.values():
        if text and isinstance(value, str | int | float) and len(str(value)) >= 3:
            text = text.replace(str(value), "[redacted]")
    return text


# --- running a tool ----------------------------------------------------------------------


async def run_tool(
    store: DoorwayStore,
    tool: dict,
    arguments: dict | None,
    *,
    user: User | None = None,
    use_profile: bool = False,
    remember: bool = False,
    mode: str = "broker",
    paid_reference: str | None = None,
) -> Outcome:
    submitted = dict(arguments or {})
    args = dict(submitted)
    filled = await _fill_from_profile(store, tool, args, user) if use_profile and user else []

    site = await store.get_site(tool["site_id"])
    if site is None or not tool.get("spec") or tool["status"] == "draft":
        return Outcome(ok=False, error=f"{tool['name']} is not published yet")

    started = time.monotonic()
    healed = False
    result = await _execute(tool, args, site) if tool["status"] in CALLABLE else None
    if result is None or (not result.ok and result.broken):
        error = _scrub(result.error, args) if result else f"{tool['name']} is being repaired"
        repaired = await heal(store, tool, site, error or "tool no longer matches the site")
        if repaired is not None:
            healed = True
            tool = repaired
            result = await _execute(repaired, args, site)
        else:
            result = result or ExecResult(ok=False, broken=True)
            result.error = f"{error} (self-healing did not finish; try again shortly)"
    elif result.ok and tool["status"] == "verified" and _fell_back(tool, result):
        # Served by a slower strategy: repair the fast path in the background, don't wait.
        preferred = tool["spec"]["preferred"]
        await report_broken(
            store,
            tool,
            site,
            f"{tool['name']}: {preferred} strategy broke; serving via {result.strategy} "
            "while a sandbox repairs it",
            error=_scrub(result.error, args) or f"{preferred} strategy failed",
            status="repairing",
        )

    run = await store.record_run(
        {
            "tool_id": tool["id"],
            "site_id": tool["site_id"],
            "mode": mode,
            "strategy": result.strategy,
            "status": "success" if result.ok else "failure",
            "ms": result.ms,
            "steps": result.steps,
            "tokens": 0,
            "paid_reference": paid_reference,
            "error": None if result.ok else _scrub(result.error, args),
        }
    )
    await _update_stats(store, tool["id"])
    detail = (
        f"{result.strategy}, {result.ms} ms"
        if result.ok
        else _scrub(result.error, args) or "failed"
    )
    await store.emit(
        tool["site_id"],
        "execute.call",
        f"{MODE_LABEL.get(mode, mode)} called {tool['name']}: "
        f"{'ok' if result.ok else 'failed'} ({detail})" + (" after healing" if healed else ""),
        {
            "tool_id": tool["id"],
            "tool": tool["name"],
            "mode": mode,
            "inputs": sorted(args),
            "run_id": run["id"],
            "ok": result.ok,
            "healed": healed,
            "total_ms": round((time.monotonic() - started) * 1000),
        },
    )
    if remember and user:
        await _remember(store, tool, submitted, user)
    return Outcome(
        ok=result.ok,
        data=result.data,
        error=None if result.ok else result.error,
        strategy=result.strategy,
        ms=result.ms,
        steps=result.steps,
        healed=healed,
        broken=not result.ok and result.broken,
        run=run,
        filled_from_profile=filled,
    )


async def _execute(tool: dict, args: dict, site: dict) -> ExecResult:
    spec = tool["spec"]
    try:
        if not HAS_BROWSER:
            if "api" not in (spec.get("strategies") or {}):
                return ExecResult(ok=False, error=f"{tool['name']} needs a browser sandbox")
            return await executor.execute(spec, args, site["base_url"], strategy="api")
        # strategy=None: the spec's preferred strategy, falling back across the others.
        return await executor.execute(spec, args, site["base_url"])
    except Exception as error:  # an executor bug must not take the API down
        log.exception("executor failed for tool %s", tool["id"])
        return ExecResult(ok=False, error=f"executor error: {type(error).__name__}")


def _fell_back(tool: dict, result: ExecResult) -> bool:
    preferred = (tool.get("spec") or {}).get("preferred")
    if not HAS_BROWSER:  # api was chosen for us, not a fallback
        return False
    return bool(preferred) and result.strategy is not None and result.strategy != preferred


async def report_broken(
    store: DoorwayStore, tool: dict, site: dict, message: str, *, error: str, status: str
) -> dict:
    """Flag the tool (broken, or repairing while a fallback works), tell the sandboxes, and
    make sure exactly one heal job is open for it. Returns that job."""
    tool_id = tool["id"]
    if tool["status"] == "verified" or (status == "broken" and tool["status"] == "repairing"):
        await store.set_tool_status(tool_id, status)
        if status == "broken":
            await store.set_site_status(site["id"], "healing")
        await store.emit(site["id"], "tool.broken", message, {"tool_id": tool_id, "status": status})
        await store.post_message(
            {
                "from_sandbox": "broker",
                "kind": "broken",
                "body": {
                    "tool_id": tool_id,
                    "site_id": site["id"],
                    "tool": tool["name"],
                    "status": status,
                    "error": error,
                },
            }
        )
    return await _open_heal_job(store, tool_id) or await store.enqueue_job(
        {
            "kind": "heal",
            "site_id": site["id"],
            "tool_id": tool_id,
            "priority": JOB_PRIORITY["heal"],
            "payload": {"tool_id": tool_id, "error": error},
        }
    )


async def heal(store: DoorwayStore, tool: dict, site: dict, error: str) -> dict | None:
    """Mark the tool broken, queue a heal job, wait for a sandbox to republish it.

    Returns the repaired tool row, or None if it wasn't repaired within HEAL_TIMEOUT.
    """
    started = time.monotonic()
    tool_id, name = tool["id"], tool["name"]
    message = f"{name} broke: {error}"
    job = await report_broken(store, tool, site, message, error=error, status="broken")

    repaired = None
    while time.monotonic() - started < HEAL_TIMEOUT:
        current = await store.get_tool(tool_id)
        if current and current["status"] == "verified":
            repaired = current
            break
        if await _job_failed(store, job["id"]):
            break
        await asyncio.sleep(HEAL_POLL)

    seconds = round(time.monotonic() - started, 1)
    if repaired is None:
        await store.emit(
            site["id"], "heal.fail", f"Could not heal {name} ({seconds} s)", {"tool_id": tool_id}
        )
        return None
    await store.set_site_status(site["id"], "ready")
    await store.emit(
        site["id"],
        "heal.done",
        f"Healed {name} in {seconds} s (v{repaired['version']}); retrying the call",
        {"tool_id": tool_id, "version": repaired["version"], "seconds": seconds},
    )
    return repaired


async def _open_heal_job(store: DoorwayStore, tool_id: int) -> dict | None:
    for status in ("queued", "running"):
        for job in await store.list_jobs(status):
            if job["kind"] == "heal" and job.get("tool_id") == tool_id:
                return job
    return None


async def _job_failed(store: DoorwayStore, job_id: int) -> bool:
    return any(job["id"] == job_id for job in await store.list_jobs("failed"))


async def _update_stats(store: DoorwayStore, tool_id: int) -> None:
    tool = await store.get_tool(tool_id)
    runs = [r for r in await store.list_runs(tool_id, STATS_WINDOW) if r["mode"] != "verify"]
    if tool is None or not runs:
        return
    fields: dict[str, Any] = {
        "runs_count": (tool.get("runs_count") or 0) + 1,
        "success_rate": round(sum(r["status"] == "success" for r in runs) / len(runs), 3),
    }
    times = [r["ms"] for r in runs if r["status"] == "success" and r.get("ms") is not None]
    if times:
        fields["p50_ms"] = round(statistics.median(times))
    await store.update_tool_stats(tool_id, fields)


# --- saved details (profile + consent) ---------------------------------------------------


async def _fill_from_profile(store: DoorwayStore, tool: dict, args: dict, user: User) -> list[str]:
    """Fill blank inputs from the profile, only with fields consented to for this site."""
    mapping = (tool.get("spec") or {}).get("profile_fields") or {}
    if not mapping:
        return []
    consented = {
        name
        for consent in await store.list_consents(user.id)
        if consent["site_id"] == tool["site_id"]
        for name in consent["fields"]
    }
    profile = (await store.get_profile(user.id)).get("fields") or {}
    filled = []
    for input_name, profile_field in mapping.items():
        value = profile.get(profile_field)
        if _blank(args.get(input_name)) and profile_field in consented and not _blank(value):
            args[input_name] = value
            filled.append(input_name)
    return filled


async def _remember(store: DoorwayStore, tool: dict, submitted: dict, user: User) -> list[str]:
    """Save the inputs the user typed back to their profile (via tool.profile_fields)."""
    mapping = (tool.get("spec") or {}).get("profile_fields") or {}
    updates = {
        profile_field: submitted[input_name]
        for input_name, profile_field in mapping.items()
        if not _blank(submitted.get(input_name))
    }
    if updates:
        profile = (await store.get_profile(user.id)).get("fields") or {}
        await store.save_profile(user.id, {**profile, **updates})
    return sorted(updates)


# --- sites by URL ------------------------------------------------------------------------


def normalize_url(url: str) -> str:
    """http(s)://host[:port]/path/ — the form base_url is stored in. ValueError if not a URL."""
    url = url.strip()
    if "://" not in url:
        url = f"https://{url}"
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("url must be an http(s) URL")
    path = parts.path if parts.path.endswith("/") else f"{parts.path}/"
    return f"{parts.scheme}://{parts.netloc.lower()}{path}"


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc.lower()}"


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40].strip("-")
    return slug if len(slug) >= 2 else f"site-{slug}".strip("-")


def slug_for_url(base_url: str) -> str:
    parts = urlsplit(base_url)
    host = (parts.hostname or "").removeprefix("www.")
    if host in ("localhost", "127.0.0.1", "0.0.0.0") and parts.port:
        host = f"{host}-{parts.port}"  # local demo sites differ only by port
    else:
        host = re.sub(r"\.(com|org|net|io|dev|app|co)$", "", host)
    return slugify(f"{host}{parts.path}")


def demo_site(base_url: str) -> dict | None:
    """The demo site (backend/demo_sites) served at this URL, if any."""
    try:
        from demo_sites.registry import demo_sites
    except ImportError:
        return None
    return next((s for s in demo_sites() if normalize_url(s["base_url"]) == base_url), None)


async def find_site_by_url(store: DoorwayStore, url: str) -> dict | None:
    """Same base_url wins; otherwise the only site on that origin."""
    base_url = normalize_url(url)
    sites = await store.list_sites()
    for site in sites:
        if normalize_url(site["base_url"]) == base_url:
            return site
    same_origin = [s for s in sites if _origin(s["base_url"]) == _origin(base_url)]
    return same_origin[0] if len(same_origin) == 1 else None


async def free_site_id(store: DoorwayStore, slug: str, base_url: str) -> str:
    """slug, or slug-2, slug-3… if another site already uses it."""
    candidate, n = slug, 1
    while (existing := await store.get_site(candidate)) is not None:
        if normalize_url(existing["base_url"]) == base_url:
            return candidate
        n += 1
        candidate = f"{slug[: 40 - len(str(n)) - 1]}-{n}"
    return candidate


async def queue_discovery(store: DoorwayStore, site: dict, goal: str | None, **payload) -> dict:
    """Queue a discover job unless one is already waiting or running for the site."""
    for status in ("queued", "running"):
        for job in await store.list_jobs(status):
            if job["kind"] == "discover" and job.get("site_id") == site["id"]:
                return job
    if site["status"] not in ("discovering", "verifying"):
        await store.set_site_status(site["id"], "queued")
    return await store.enqueue_job(
        {
            "kind": "discover",
            "site_id": site["id"],
            "priority": JOB_PRIORITY["discover"],
            "payload": {"goal": goal, **payload},
        }
    )


# --- agent requests (lookup → execute, or discover) --------------------------------------

_STOPWORDS = set(
    "a an the to for of my me on at in with and or please i want would like can you some any "
    "is are be from this that it get do make need we our your".split()
)
_SYNONYMS = [
    {"book", "reserve", "reservation", "schedule", "booking"},
    {"list", "search", "find", "show", "browse", "available", "availability", "open", "lookup"},
    {"cancel", "cancellation", "delete", "remove"},
    {"slot", "time", "opening"},
    {"contact", "message", "ask", "inquiry", "enquiry", "question"},
]


def _stem(word: str) -> str:
    if len(word) > 5 and word.endswith("ing"):
        word = word[:-3]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        word = word[:-1]
    return word


def _tokens(text: str | None) -> set[str]:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return {_stem(w) for w in words if w not in _STOPWORDS}


def _related(a: str, b: str) -> bool:
    if a == b or (len(a) >= 5 and len(b) >= 5 and a[:5] == b[:5]):
        return True
    return any(a in group and b in group for group in _SYNONYMS)


def _score(task_tokens: set[str], tool: dict, pattern_name: str | None) -> int:
    name = _tokens(tool["name"].replace("_", " "))
    other = _tokens(f"{tool.get('description')} {(pattern_name or '').replace('_', ' ')}")
    score = 0
    for token in task_tokens:
        if any(_related(token, n) for n in name):
            score += 2
        elif any(_related(token, o) for o in other):
            score += 1
    return score


async def lookup(store: DoorwayStore, site_id: str, task: str) -> dict | None:
    """The verified tool whose name/description/pattern best matches the task's words."""
    tools = [
        t for t in await store.list_tools(site_id) if t["status"] in CALLABLE and t.get("spec")
    ]
    if not tools:
        return None
    patterns = {p["id"]: p["name"] for p in await store.list_patterns()}
    words = _tokens(task)
    scored = [(_score(words, t, patterns.get(t.get("pattern_id"))), t) for t in tools]
    # Ties go to reads: they are free and change nothing.
    best_score, best = max(scored, key=lambda st: (st[0], st[1]["kind"] == "read"))
    return best if best_score > 0 else None


async def handle_request(
    store: DoorwayStore, website: str, task: str, inputs: dict | None = None
) -> tuple[dict, dict | None]:
    """Create a request: lookup hit → executing (tool returned), miss → discovering."""
    inputs = inputs or {}
    # Agents may name a known site by id or name instead of its URL.
    named = website.strip().lower()
    site = next(
        (s for s in await store.list_sites() if named in (s["id"], s["name"].lower())), None
    )
    base_url = site["base_url"] if site else normalize_url(website)
    site = site or await find_site_by_url(store, base_url)
    if site is None:
        demo = demo_site(base_url) or {}
        slug = demo.get("id") or slug_for_url(base_url)
        site = await store.upsert_site(
            {
                "id": await free_site_id(store, slug, base_url),
                "name": demo.get("name") or urlsplit(base_url).netloc,
                "base_url": base_url,
                "goal": demo.get("goal") or task,
                "status": "new",
                "is_demo": bool(demo),
            }
        )
    request_id = f"req_{secrets.token_hex(6)}"
    await store.emit(
        site["id"],
        "request.received",
        f"Agent request: {task}",
        {"request_id": request_id, "website": base_url, "inputs": sorted(inputs)},
    )
    tool = await lookup(store, site["id"], task)
    request = await store.create_request(
        {
            "id": request_id,
            "website": base_url,
            "task": task,
            "site_id": site["id"],
            "tool_id": tool["id"] if tool else None,
            "status": "executing" if tool else "discovering",
            "inputs": inputs,
        }
    )
    if tool:
        await store.emit(
            site["id"], "lookup.hit", f"Found {tool['name']} for: {task}", {"tool_id": tool["id"]}
        )
    else:
        await store.emit(site["id"], "lookup.miss", f"No verified tool yet for: {task}")
        await queue_discovery(store, site, task, request_id=request_id)
    return request, tool


async def advance(store: DoorwayStore, request: dict) -> dict:
    """Move a request forward: re-check discovery, run a read, or hand out a payment link."""
    if request["status"] in ("done", "failed"):
        return request
    fields: dict[str, Any] = {}
    tool = await store.get_tool(request["tool_id"]) if request.get("tool_id") else None
    if request["status"] == "discovering":
        tool = await lookup(store, request["site_id"], request["task"])
        site = await store.get_site(request["site_id"])
        if tool is None:
            if site is None or site["status"] == "failed":
                fields = {"status": "failed", "result": {"error": "could not discover this site"}}
            elif site["status"] == "ready":  # discovered, but nothing fits the task
                fields = {"status": "failed", "result": {"error": "no tool matches this task"}}
        else:
            fields = {"status": "executing", "tool_id": tool["id"]}
            await store.emit(
                tool["site_id"], "lookup.hit", f"Found {tool['name']}", {"tool_id": tool["id"]}
            )
    if tool is not None and fields.get("status", request["status"]) == "executing":
        if tool["kind"] == "action":
            # Agents pay for actions: the broker hands out the paid run URL instead of acting.
            fields = {
                "status": "done",
                "tool_id": tool["id"],
                "result": {"data": payment_link(tool, request.get("inputs"))},
            }
        else:
            outcome = await run_tool(store, tool, request.get("inputs") or {}, mode="broker")
            fields = {
                "status": "done" if outcome.ok else "failed",
                "tool_id": tool["id"],
                "result": {
                    "data": outcome.data,
                    "error": outcome.error,
                    "strategy": outcome.strategy,
                    "ms": outcome.ms,
                    "healed": outcome.healed,
                    "run": outcome.run,
                },
            }
    if fields:
        await store.update_request(request["id"], fields)
        request = {**request, **fields}
    return request

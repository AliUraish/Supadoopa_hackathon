"""Doorway HTTP API, broker, MCP server and paid runs. MemoryStore + a fake executor/site."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mpp import Challenge, Credential, Receipt
from test_mpp import mpp_env, payments  # noqa: F401  (fixtures)

from app.billing import agents
from app.doorway import broker, demo, executor
from app.doorway.interfaces import ExecResult
from app.doorway.store import MemoryStore, get_doorway_store
from app.main import app

SITE = "sunrise-clinic"
LIST_SPEC = {
    "name": "list_open_slots",
    "description": "List open appointment slots",
    "kind": "read",
    "input_schema": {"type": "object", "properties": {"day": {"type": "string"}}},
    "strategies": {"api": {"request": {"method": "GET", "path": "api/slots"}}},
    "preferred": "api",
}
BOOK_SPEC = {
    "name": "book_appointment",
    "description": "Book an appointment slot for a patient",
    "kind": "action",
    "input_schema": {
        "type": "object",
        "properties": {
            "slot_id": {"type": "integer"},
            "patient_name": {"type": "string"},
            "phone": {"type": "string"},
        },
        "required": ["slot_id"],
    },
    "profile_fields": {"patient_name": "full_name", "phone": "phone"},
    "strategies": {"api": {"request": {"method": "POST", "path": "api/appointments"}}},
    "preferred": "api",
}
SECRET_VALUES = ("Ada Lovelace", "555-0100", "Grace Hopper", "555-0199")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def store():
    memory = MemoryStore()
    app.dependency_overrides[get_doorway_store] = lambda: memory
    return memory


class FakeSite:
    """Stands in for executor.execute: the clinic's API, which can switch to v2 (break)."""

    def __init__(self) -> None:
        self.version = "v1"
        self.fallback = False  # api broke, but the form strategy still works
        self.reject: str | None = None  # the site refuses the input (not broken)
        self.calls: list[dict] = []

    async def execute(self, spec, inputs, base_url, *, strategy=None, browser=None):
        self.calls.append({"tool": spec["name"], "inputs": dict(inputs), "base_url": base_url})
        if self.reject:
            return ExecResult(ok=False, strategy="api", ms=8, error=self.reject.format(**inputs))
        if self.fallback:
            return ExecResult(ok=True, strategy="form", ms=600, data=[], error="api: retired")
        if spec.get("api_version", "v1") != self.version:
            return ExecResult(ok=False, broken=True, strategy="api", status=410, ms=4, error="410")
        if spec["name"] == "list_open_slots":
            return ExecResult(ok=True, strategy="api", ms=12, data=[{"id": 7, "time": "09:00"}])
        return ExecResult(ok=True, strategy="api", ms=30, data={"booking_id": 1})


@pytest.fixture
def site(monkeypatch):
    fake = FakeSite()
    monkeypatch.setattr(executor, "execute", fake.execute)
    return fake


@pytest.fixture
def clinic(store, site):
    """A ready demo clinic with a free read and a paid action (via a shared pattern)."""

    async def seed():
        await store.upsert_site(
            {
                "id": SITE,
                "name": "Sunrise Family Clinic",
                "base_url": "http://clinic.test/",
                "goal": "Book a doctor's appointment",
                "status": "ready",
                "is_demo": True,
            }
        )
        pattern = await store.create_pattern(
            {
                "name": "slot_booking",
                "description": "list slots → book slot",
                "template": {"roles": {}},
                "source_site_id": SITE,
                "used_by": [SITE],
            }
        )
        cap = await store.upsert_capability(
            {"site_id": SITE, "name": "book_appointment", "description": "Book", "kind": "action"}
        )
        ids = {}
        for spec, extra in (
            (LIST_SPEC, {}),
            (BOOK_SPEC, {"capability_id": cap["id"], "pattern_id": pattern["id"]}),
        ):
            tool = await store.upsert_tool(
                {
                    "site_id": SITE,
                    "name": spec["name"],
                    "description": spec["description"],
                    "kind": spec["kind"],
                    "price_cents": 50 if spec["kind"] == "action" else 0,
                    **extra,
                }
            )
            await store.publish_version(
                tool["id"], spec, source="discover", verified_by="sandbox-1", strategies={}
            )
            ids[spec["name"]] = tool["id"]
        return SimpleNamespace(list_id=ids["list_open_slots"], book_id=ids["book_appointment"])

    return run(seed())


def worker_heals(store, monkeypatch, *, api_version="v2"):
    """Simulate a sandbox: a heal job republishes the tool for the site's new API."""
    enqueue = store.enqueue_job

    async def enqueue_and_heal(job):
        row = await enqueue(job)
        if job["kind"] == "heal":
            tool = await store.get_tool(job["tool_id"])
            await store.publish_version(
                tool["id"],
                {**tool["spec"], "api_version": api_version},
                source="heal",
                verified_by="sandbox-2",
                strategies={"api": {"ms": 9, "passed": True}},
            )
            await store.finish_job(row["id"], ok=True)
        return row

    monkeypatch.setattr(store, "enqueue_job", enqueue_and_heal)


def events(store, kind=None):
    rows = list(store.tables["doorway_events"].values())
    return [e for e in rows if kind is None or e["kind"] == kind]


def assert_no_personal_values(store):
    for table in ("doorway_events", "doorway_runs", "doorway_messages"):
        dumped = json.dumps(list(store.tables[table].values()))
        for value in SECRET_VALUES:
            assert value not in dumped, f"{value!r} leaked into {table}"


# --- auth ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/doorway/sites"),
        ("post", "/doorway/sites/x/rediscover"),
        ("post", "/doorway/sites/x/break"),
        ("post", "/doorway/sites/x/reset"),
        ("post", "/doorway/tools/1/run"),
        ("post", "/doorway/race"),
        ("get", "/doorway/profile"),
        ("put", "/doorway/profile"),
        ("get", "/doorway/consents"),
        ("post", "/doorway/consents"),
        ("delete", "/doorway/consents/1"),
    ],
)
def test_dashboard_writes_need_a_session(client, store, method, path):
    response = client.request(method.upper(), path, json={})
    assert response.status_code == 401


# --- sites -------------------------------------------------------------------------------------


def test_adding_a_site_queues_discovery(client, store, signed_in):
    body = {"url": "http://localhost:4101", "name": "Bella Bistro", "goal": "Reserve a table"}
    response = client.post("/doorway/sites", json=body)
    assert response.status_code == 202, response.text
    site = response.json()["site"]
    assert site["id"] == "bella-bistro" and site["status"] == "queued"
    assert site["base_url"] == "http://localhost:4101/" and site["tools_count"] == 0
    job = store.tables["doorway_jobs"][response.json()["job_id"]]
    assert job["kind"] == "discover" and job["site_id"] == "bella-bistro"
    assert job["priority"] == 10 and job["payload"]["goal"] == "Reserve a table"
    assert [e["kind"] for e in events(store)] == ["request.received"]

    again = client.post("/doorway/sites", json=body).json()
    assert again["site"]["id"] == "bella-bistro" and again["job_id"] == job["id"]  # no duplicate

    named = client.post("/doorway/sites", json={"url": "https://www.example.com/shop"})
    assert named.json()["site"]["id"] == "example-shop"
    local = client.post("/doorway/sites", json={"url": "http://localhost:4999/"})
    assert local.json()["site"]["id"] == "localhost-4999"
    assert local.json()["site"]["is_demo"] is False
    vet = client.post("/doorway/sites", json={"url": "http://localhost:4102"}).json()["site"]
    assert vet["id"] == "pawsome-vet" and vet["is_demo"] is True and vet["name"] == "Pawsome Vet"
    assert client.post("/doorway/sites", json={"url": "ftp://x.example"}).status_code == 422


def test_site_reads(client, clinic):
    sites = client.get("/doorway/sites").json()
    assert [(s["id"], s["tools_count"], s["verified_count"]) for s in sites] == [(SITE, 2, 2)]
    assert sites[0]["mcp_url"].endswith(f"/doorway/sites/{SITE}/mcp")

    detail = client.get(f"/doorway/sites/{SITE}").json()
    assert detail["site"]["name"] == "Sunrise Family Clinic"
    assert detail["capabilities"][0]["tool_id"] == clinic.book_id
    assert {t["name"] for t in detail["tools"]} == {"list_open_slots", "book_appointment"}
    assert isinstance(detail["events"], list)
    assert client.get("/doorway/sites/nope").status_code == 404


def test_rediscover(client, clinic, signed_in, store):
    response = client.post(f"/doorway/sites/{SITE}/rediscover")
    assert response.status_code == 202
    job = store.tables["doorway_jobs"][response.json()["job_id"]]
    assert job["kind"] == "discover" and job["payload"]["rediscover"] is True
    assert client.post("/doorway/sites/nope/rediscover").status_code == 404


def test_break_and_reset_demo_site(client, clinic, signed_in, store, configure, monkeypatch):
    assert client.post(f"/doorway/sites/{SITE}/break").status_code == 503  # no admin token
    configure(DEMO_ADMIN_TOKEN="demo-secret")
    state = {"version": "v1"}
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-admin-token"] == "demo-secret"
        seen.append((request.method, request.url.path))
        if request.url.path == "/admin/state":
            return httpx.Response(200, json=state)
        if request.url.path == "/admin/version":
            state["version"] = json.loads(request.content)["version"]
            return httpx.Response(200, json=state)
        state["version"] = "v1"
        return httpx.Response(200, json={"version": "v1", "bookings": 0})

    monkeypatch.setattr(demo, "transport", httpx.MockTransport(handler))
    assert client.post(f"/doorway/sites/{SITE}/break").json() == {"version": "v2"}
    assert client.post(f"/doorway/sites/{SITE}/break").json() == {"version": "v1"}  # toggles
    assert client.post(f"/doorway/sites/{SITE}/reset").json()["version"] == "v1"
    assert ("POST", "/admin/reset") in seen

    run(store.upsert_site({"id": "plain", "name": "Plain", "base_url": "http://plain.test/"}))
    response = client.post("/doorway/sites/plain/break")
    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "not_a_demo_site"


# --- tools + dashboard runs --------------------------------------------------------------------


def test_tool_reads(client, clinic):
    tools = client.get("/doorway/tools", params={"site_id": SITE}).json()
    book = next(t for t in tools if t["name"] == "book_appointment")
    assert book["price_cents"] == 50 and book["status"] == "verified" and book["version"] == 1
    assert book["input_schema"]["required"] == ["slot_id"]
    assert book["profile_fields"] == {"patient_name": "full_name", "phone": "phone"}
    assert "spec" not in book

    detail = client.get(f"/doorway/tools/{clinic.list_id}").json()
    assert detail["tool"]["price_cents"] == 0 and detail["versions"][0]["source"] == "discover"
    assert detail["runs"] == []
    assert client.get("/doorway/tools/999").status_code == 404


def test_dashboard_run_records_the_run(client, clinic, signed_in, site, store):
    response = client.post(
        f"/doorway/tools/{clinic.list_id}/run", json={"arguments": {"day": "2026-10-04"}}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] and body["data"] == [{"id": 7, "time": "09:00"}]
    assert body["run"]["mode"] == "dashboard" and body["run"]["strategy"] == "api"
    assert body["filled_from_profile"] == [] and "payment" not in body
    assert site.calls[0]["base_url"] == "http://clinic.test/"

    tool = run(store.get_tool(clinic.list_id))
    assert tool["runs_count"] == 1 and tool["success_rate"] == 1.0 and tool["p50_ms"] == 12
    call = events(store, "execute.call")[-1]
    assert call["data"]["inputs"] == ["day"] and "2026-10-04" not in json.dumps(call)


def test_profile_and_consent(client, clinic, signed_in, site, store):
    assert client.get("/doorway/profile").json() == {"fields": {}}
    fields = {"full_name": "Ada Lovelace", "phone": "555-0100", "email": "ada@example.com"}
    assert client.put("/doorway/profile", json={"fields": fields}).json() == {"fields": fields}

    consent = client.post("/doorway/consents", json={"site_id": SITE, "fields": ["phone"]}).json()
    assert consent["fields"] == ["phone"] and consent["site_id"] == SITE
    assert [c["id"] for c in client.get("/doorway/consents").json()] == [consent["id"]]
    assert (
        client.post("/doorway/consents", json={"site_id": "x", "fields": ["a"]}).status_code == 404
    )

    # Only the consented field (phone) is filled; the name stays blank.
    body = client.post(
        f"/doorway/tools/{clinic.book_id}/run",
        json={"arguments": {"slot_id": 7}, "use_profile": True},
    ).json()
    assert body["ok"] and body["filled_from_profile"] == ["phone"]
    assert site.calls[-1]["inputs"] == {"slot_id": 7, "phone": "555-0100"}

    # Without use_profile nothing is filled.
    client.post(f"/doorway/tools/{clinic.book_id}/run", json={"arguments": {"slot_id": 8}})
    assert site.calls[-1]["inputs"] == {"slot_id": 8}

    # remember saves what the user typed (mapped to profile fields), keeping the rest.
    args = {"slot_id": 9, "patient_name": "Grace Hopper", "phone": "555-0199"}
    client.post(f"/doorway/tools/{clinic.book_id}/run", json={"arguments": args, "remember": True})
    saved = client.get("/doorway/profile").json()["fields"]
    assert saved == {"full_name": "Grace Hopper", "phone": "555-0199", "email": "ada@example.com"}

    assert client.delete(f"/doorway/consents/{consent['id']}").status_code == 204
    assert client.get("/doorway/consents").json() == []
    assert_no_personal_values(store)


def test_errors_never_store_input_values(client, clinic, signed_in, site, store):
    site.reject = "slot {slot_id} is taken (patient {patient_name})"
    args = {"slot_id": 7, "patient_name": "Ada Lovelace"}
    body = client.post(f"/doorway/tools/{clinic.book_id}/run", json={"arguments": args}).json()
    assert body["ok"] is False and "Ada Lovelace" in body["error"]  # the caller sees it
    assert body["run"]["error"] == "slot 7 is taken (patient [redacted])"
    assert run(store.get_tool(clinic.book_id))["status"] == "verified"  # not broken
    assert_no_personal_values(store)


def test_broken_tool_is_healed_and_retried(client, clinic, signed_in, site, store, monkeypatch):
    worker_heals(store, monkeypatch)
    monkeypatch.setattr(broker, "HEAL_POLL", 0.01)
    site.version = "v2"  # the clinic shipped a new private API

    body = client.post(f"/doorway/tools/{clinic.list_id}/run", json={"arguments": {}}).json()
    assert body["ok"] and body["healed"] is True and body["data"][0]["id"] == 7
    assert len(site.calls) == 2  # failed once, retried once after the heal

    tool = run(store.get_tool(clinic.list_id))
    assert tool["status"] == "verified" and tool["version"] == 2
    job = next(j for j in store.tables["doorway_jobs"].values() if j["kind"] == "heal")
    assert job["tool_id"] == clinic.list_id and job["priority"] == 100
    assert job["payload"]["tool_id"] == clinic.list_id and job["payload"]["error"]
    message = next(iter(store.tables["doorway_messages"].values()))
    assert message["from_sandbox"] == "broker" and message["kind"] == "broken"
    kinds = [e["kind"] for e in events(store)]
    assert kinds.index("tool.broken") < kinds.index("heal.done") < kinds.index("execute.call")
    assert run(store.get_site(SITE))["status"] == "ready"
    assert client.get("/doorway/metrics").json()["heals"] == 1


def test_fallback_success_repairs_the_fast_path_in_the_background(client, clinic, site, store):
    site.fallback = True
    response = client.post(f"/doorway/run/{SITE}/list_open_slots", json={})
    assert response.status_code == 200 and response.json()["strategy"] == "form"
    assert run(store.get_tool(clinic.list_id))["status"] == "repairing"
    heal_jobs = [j for j in store.tables["doorway_jobs"].values() if j["kind"] == "heal"]
    assert len(heal_jobs) == 1 and heal_jobs[0]["payload"]["error"] == "api: retired"
    assert events(store, "tool.broken")[0]["data"]["status"] == "repairing"
    # Still callable (and listed) while repairing; no second heal job.
    assert client.post(f"/doorway/run/{SITE}/list_open_slots", json={}).status_code == 200
    assert len([j for j in store.tables["doorway_jobs"].values() if j["kind"] == "heal"]) == 1


def test_heal_gives_up_after_the_timeout(client, clinic, site, store, monkeypatch):
    monkeypatch.setattr(broker, "HEAL_TIMEOUT", 0.1)
    monkeypatch.setattr(broker, "HEAL_POLL", 0.01)
    site.version = "v2"
    response = client.post(f"/doorway/run/{SITE}/list_open_slots", json={"arguments": {}})
    assert response.status_code == 502
    assert response.json()["ok"] is False and "self-healing" in response.json()["error"]
    assert events(store, "heal.fail")
    assert run(store.get_tool(clinic.list_id))["status"] == "broken"
    # A second call waits on the same heal job rather than queueing another.
    client.post(f"/doorway/run/{SITE}/list_open_slots", json={})
    heal_jobs = [j for j in store.tables["doorway_jobs"].values() if j["kind"] == "heal"]
    assert len(heal_jobs) == 1


# --- paid runs -------------------------------------------------------------------------------


def pay(client, path, challenge_response, arguments, spt="spt_test_123"):
    challenge = Challenge.from_www_authenticate(challenge_response.headers["www-authenticate"])
    credential = Credential(challenge=challenge.to_echo(), payload={"spt": spt})
    return client.post(
        path,
        json={"arguments": arguments},
        headers={"Authorization": credential.to_authorization()},
    )


def test_reads_are_free_over_http(client, clinic):
    response = client.post(f"/doorway/run/{SITE}/list_open_slots", json={"arguments": {}})
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": [{"id": 7, "time": "09:00"}],
        "strategy": "api",
        "ms": 12,
        "healed": False,
    }
    assert client.post(f"/doorway/run/{SITE}/nope", json={}).status_code == 404


def test_actions_need_payment(client, clinic, payments, store):  # noqa: F811
    path = f"/doorway/run/{SITE}/book_appointment"
    args = {"slot_id": 7, "patient_name": "Ada Lovelace", "phone": "555-0100"}
    assert client.post(path, json={"arguments": {}}).status_code == 422  # checked before charging

    challenge = client.post(path, json={"arguments": args})
    assert challenge.status_code == 402
    assert challenge.headers["content-type"].startswith("application/problem+json")
    offer = Challenge.from_www_authenticate(challenge.headers["www-authenticate"])
    assert offer.request["amount"] == "50"
    assert offer.request["extra"] == {"resource": f"{SITE}/book_appointment"}
    assert events(store, "payment.challenge")

    paid = pay(client, path, challenge, args)
    assert paid.status_code == 200, paid.text
    assert paid.json()["ok"] and paid.json()["data"] == {"booking_id": 1}
    assert Receipt.from_payment_receipt(paid.headers["payment-receipt"]).reference == "pi_1"
    assert payments.created[0]["params"]["amount"] == 50
    assert payments.store.mpp_payments["pi_1"]["resource"] == f"{SITE}/book_appointment"
    runs = run(store.list_runs(clinic.book_id))
    assert runs[0]["paid_reference"] == "pi_1" and runs[0]["mode"] == "broker"
    assert events(store, "payment.paid")

    assert pay(client, path, challenge, args).status_code == 409  # replay
    metrics = client.get("/doorway/metrics").json()
    assert metrics["revenue_cents"] == 50
    assert_no_personal_values(store)


def test_payment_for_one_tool_cannot_run_another(client, clinic, payments, store):  # noqa: F811
    run(
        store.upsert_tool(
            {
                "site_id": SITE,
                "name": "cancel_appointment",
                "description": "Cancel",
                "kind": "action",
            }
        )
    )
    cancel = run(store.find_tool(SITE, "cancel_appointment"))
    run(
        store.publish_version(
            cancel["id"],
            {**BOOK_SPEC, "name": "cancel_appointment"},
            source="discover",
            verified_by="sandbox-1",
            strategies={},
        )
    )
    challenge = client.post(f"/doorway/run/{SITE}/book_appointment", json={"slot_id": 7})
    other = pay(client, f"/doorway/run/{SITE}/cancel_appointment", challenge, {"slot_id": 7})
    assert other.status_code == 402 and payments.created == []


def test_paid_run_that_fails_keeps_the_reference(client, clinic, payments, site, monkeypatch):  # noqa: F811
    monkeypatch.setattr(broker, "HEAL_TIMEOUT", 0.05)
    monkeypatch.setattr(broker, "HEAL_POLL", 0.01)
    site.version = "v2"
    path = f"/doorway/run/{SITE}/book_appointment"
    response = pay(client, path, client.post(path, json={"slot_id": 7}), {"slot_id": 7})
    assert response.status_code == 502
    assert response.json()["payment_reference"] == "pi_1" and response.json()["refundable"]
    assert "payment-receipt" in response.headers


def test_paid_runs_need_stripe(client, clinic, configure):
    configure(STRIPE_SECRET_KEY="sk_test_123")
    response = client.post(f"/doorway/run/{SITE}/book_appointment", json={"slot_id": 7})
    assert response.status_code == 503
    assert response.json()["detail"]["missing"] == ["STRIPE_PROFILE_ID"]


def test_dashboard_test_payment(client, clinic, signed_in, payments, monkeypatch, store):  # noqa: F811
    minted = []

    async def mint(body):
        minted.append(body.amount)
        return {"shared_payment_token": "spt_test_dashboard"}

    monkeypatch.setattr(agents, "mint_test_token", mint)
    body = client.post(
        f"/doorway/tools/{clinic.book_id}/run", json={"arguments": {"slot_id": 7}, "pay": "test"}
    ).json()
    assert body["ok"], body
    assert body["payment"]["reference"] == "pi_1" and body["payment"]["amount_cents"] == 50
    assert Receipt.from_payment_receipt(body["payment"]["receipt"]).reference == "pi_1"
    assert body["run"]["paid_reference"] == "pi_1" and minted == [50]
    params = payments.created[0]["params"]
    assert params["shared_payment_granted_token"] == "spt_test_dashboard"

    # Reads are free even with pay: "test".
    read = client.post(f"/doorway/tools/{clinic.list_id}/run", json={"pay": "test"}).json()
    assert "payment" not in read and len(payments.created) == 1


def test_dashboard_test_payment_is_sandbox_only(client, clinic, signed_in, configure):
    configure(STRIPE_SECRET_KEY="sk_test_123")
    response = client.post(f"/doorway/tools/{clinic.book_id}/run", json={"pay": "test"})
    assert response.status_code == 503  # STRIPE_PROFILE_ID missing
    configure(STRIPE_SECRET_KEY="sk_live_123", STRIPE_PROFILE_ID="profile_123")
    response = client.post(f"/doorway/tools/{clinic.book_id}/run", json={"pay": "test"})
    assert response.status_code == 403


# --- agent requests ----------------------------------------------------------------------------


def test_request_for_a_known_read_runs_it(client, clinic, store):
    response = client.post(
        "/doorway/requests",
        json={"website": "http://clinic.test", "task": "Show me open slots", "inputs": {}},
    )
    assert response.status_code == 202
    body = response.json()
    assert body["site_id"] == SITE and body["status"] == "executing"
    assert body["tool"]["name"] == "list_open_slots"
    done = client.get(f"/doorway/requests/{body['request_id']}").json()
    assert done["status"] == "done" and done["result"] == [{"id": 7, "time": "09:00"}]
    assert done["run"]["mode"] == "broker"
    kinds = [e["kind"] for e in events(store)]
    assert "request.received" in kinds and "lookup.hit" in kinds


def test_request_for_an_action_returns_a_payment_link(client, clinic, configure):
    configure(STRIPE_PROFILE_ID="profile_test_123", API_URL="https://api.doorway.test")
    body = client.post(
        "/doorway/requests",
        json={"website": "http://clinic.test/", "task": "Book the earliest appointment"},
    ).json()
    assert body["tool"]["name"] == "book_appointment" and body["status"] == "done"
    link = body["result"]
    assert link["paymentLink"] == f"https://api.doorway.test/doorway/run/{SITE}/book_appointment"
    assert link["amount"] == "0.50 USD" and "profile_test_123" in link["instructions"]["agent"]


def test_request_for_an_unknown_site_discovers_it(client, store, site):
    body = client.post(
        "/doorway/requests",
        json={"website": "https://city-library.example.org/", "task": "Search the catalog"},
    ).json()
    assert body["status"] == "discovering" and body["tool"] is None
    site_id = body["site_id"]
    assert site_id == "city-library-example"
    job = next(j for j in store.tables["doorway_jobs"].values() if j["kind"] == "discover")
    assert job["site_id"] == site_id and job["payload"]["request_id"] == body["request_id"]
    assert events(store, "lookup.miss")
    poll = client.get(f"/doorway/requests/{body['request_id']}").json()
    assert poll["status"] == "discovering"

    async def discovered():
        tool = await store.upsert_tool(
            {
                "site_id": site_id,
                "name": "search_catalog",
                "description": "Search books",
                "kind": "read",
            }
        )
        spec = {**LIST_SPEC, "name": "search_catalog", "description": "Search books"}
        await store.publish_version(
            tool["id"], spec, source="discover", verified_by="sandbox-1", strategies={}
        )
        await store.set_site_status(site_id, "ready")

    run(discovered())
    done = client.get(f"/doorway/requests/{body['request_id']}").json()
    assert done["status"] == "done" and done["tool"]["name"] == "search_catalog"
    assert client.get("/doorway/requests/req_nope").status_code == 404


# --- races, swarm views, graph, metrics, llms.txt ------------------------------------------------


def test_race(client, clinic, signed_in, store):
    response = client.post(
        "/doorway/race", json={"site_id": SITE, "task": "Book the earliest appointment"}
    )
    assert response.status_code == 202
    race_id = response.json()["race_id"]
    assert race_id.startswith("race_")
    race = client.get(f"/doorway/races/{race_id}").json()
    assert race["status"] == "queued" and race["task"] == "Book the earliest appointment"
    job = next(j for j in store.tables["doorway_jobs"].values() if j["kind"] == "race")
    assert job["payload"] == {"race_id": race_id} and job["priority"] == 80
    assert client.post("/doorway/race", json={"site_id": "nope", "task": "x y"}).status_code == 404
    assert client.get("/doorway/races/race_nope").status_code == 404


def test_swarm_views(client, clinic, store):
    async def activity():
        await store.heartbeat({"id": "sandbox-1", "status": "busy", "site_id": SITE})
        await store.post_message({"from_sandbox": "sandbox-1", "kind": "hello"})
        await store.emit(SITE, "verify.pass", "list_open_slots passed")

    run(activity())
    assert client.get("/doorway/sandboxes").json()[0]["status"] == "busy"
    assert client.get("/doorway/jobs").json() == []
    assert client.get("/doorway/patterns").json()[0]["name"] == "slot_booking"
    messages = client.get("/doorway/messages").json()
    assert messages[0]["kind"] == "hello"
    assert client.get("/doorway/messages", params={"since": messages[0]["id"]}).json() == []
    feed = client.get("/doorway/events", params={"site_id": SITE}).json()
    assert feed[0]["kind"] == "verify.pass"
    assert client.get("/doorway/events", params={"since": feed[0]["id"]}).json() == []


def test_graph(client, clinic):
    graph = client.get("/doorway/graph").json()
    ids = {n["id"]: n for n in graph["nodes"]}
    assert ids[f"site:{SITE}"]["type"] == "site"
    assert ids[f"tool:{clinic.book_id}"]["status"] == "verified"
    assert {n["type"] for n in graph["nodes"]} == {"site", "capability", "tool", "pattern"}
    edges = {(e["from"], e["to"], e["type"]) for e in graph["edges"]}
    assert (f"site:{SITE}", "cap:1", "has") in edges
    assert ("cap:1", f"tool:{clinic.book_id}", "compiled_to") in edges
    assert (f"site:{SITE}", f"tool:{clinic.list_id}", "has") in edges
    assert (f"tool:{clinic.book_id}", "pattern:1", "reuses") in edges


def test_metrics(client, clinic, store):
    async def runs():
        for mode, ms in (
            ("broker", 80),
            ("broker", 100),
            ("dashboard", 90),
            ("browser_agent", 5000),
        ):
            await store.record_run(
                {
                    "tool_id": clinic.list_id,
                    "site_id": SITE,
                    "mode": mode,
                    "status": "success",
                    "ms": ms,
                }
            )
        await store.record_run({"site_id": SITE, "mode": "broker", "status": "failure", "ms": 3})
        await store.pattern_used(1, "bella-bistro", True)

    run(runs())
    metrics = client.get("/doorway/metrics").json()
    assert metrics == {
        "sites": 1,
        "tools_verified": 2,
        "runs": 5,
        "success_rate": 0.8,
        "broker_p50_ms": 90,
        "browser_p50_ms": 5000,
        "heals": 0,
        "revenue_cents": 0,
        "patterns": 1,
        "reuse_count": 1,
    }


def test_llms_txt_lists_doorway_tools(client, clinic):
    text = client.get("/llms.txt").text
    assert "credits_100" in text  # billing's part is still there
    assert f"/doorway/run/{SITE}/book_appointment: 0.50 USD per call (MPP)" in text
    assert f"/doorway/run/{SITE}/list_open_slots: free" in text


# --- MCP -----------------------------------------------------------------------------------------


def mcp_client(path: str, mode: str = "auto") -> Client:
    http = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://testserver", timeout=10
    )
    return Client(streamable_http_client(f"http://testserver{path}", http_client=http), mode=mode)


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_mcp_lists_and_calls_tools(clinic, site, store, configure, mode):
    configure(API_URL="https://api.doorway.test")
    async with mcp_client("/doorway/mcp", mode) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
        assert set(tools) == {f"{SITE}__list_open_slots", f"{SITE}__book_appointment"}
        book = tools[f"{SITE}__book_appointment"]
        assert book.input_schema["required"] == ["slot_id"] and "$0.50" in book.description

        result = await client.call_tool(f"{SITE}__list_open_slots", {"day": "2026-10-04"})
        assert not result.is_error and json.loads(result.content[0].text)[0]["id"] == 7

        paid = await client.call_tool(f"{SITE}__book_appointment", {"slot_id": 7})
        link = json.loads(paid.content[0].text)
        assert (
            link["paymentLink"] == f"https://api.doorway.test/doorway/run/{SITE}/book_appointment"
        )
        assert link["amount"] == "0.50 USD" and link["body"] == {"arguments": {"slot_id": 7}}
        assert [c["tool"] for c in site.calls] == ["list_open_slots"]  # the action didn't run

        missing = await client.call_tool(f"{SITE}__book_appointment", {})
        assert missing.is_error
        unknown = await client.call_tool("nope__tool", {})
        assert unknown.is_error
    assert len(events(store, "execute.call")) == 2


@pytest.mark.anyio
async def test_site_mcp_uses_plain_names(clinic, site, store, monkeypatch):
    worker_heals(store, monkeypatch)
    monkeypatch.setattr(broker, "HEAL_POLL", 0.01)
    site.version = "v2"
    async with mcp_client(f"/doorway/sites/{SITE}/mcp") as client:
        names = {t.name for t in (await client.list_tools()).tools}
        assert names == {"list_open_slots", "book_appointment"}
        result = await client.call_tool("list_open_slots", {})
        assert not result.is_error and "repaired this tool" in result.content[0].text


def test_mcp_is_post_only(client, store):
    assert client.get("/doorway/mcp", headers={"accept": "text/event-stream"}).status_code == 405
    assert client.delete("/doorway/mcp").status_code == 405


def test_unknown_site_mcp_is_404(client, store):
    response = client.post(
        "/doorway/sites/nope/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"accept": "application/json, text/event-stream"},
    )
    assert response.status_code == 404


def test_demo_open_mode_lets_tokenless_dashboard_actions_through(client, configure, monkeypatch):
    from app.doorway import api as doorway_api
    from app.doorway.store import MemoryStore, get_doorway_store
    from app.main import app

    memory = MemoryStore()
    app.dependency_overrides[get_doorway_store] = lambda: memory
    assert client.get("/doorway/profile").status_code == 401  # off by default
    configure(DOORWAY_DEMO_OPEN="1")
    saved = client.put("/doorway/profile", json={"fields": {"full_name": "Demo"}})
    assert saved.status_code == 200
    assert client.get("/doorway/profile").json() == {"fields": {"full_name": "Demo"}}
    assert doorway_api.DEMO_USER.id.startswith("00000000-")

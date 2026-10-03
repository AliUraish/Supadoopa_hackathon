"""DoorwayStore: MemoryStore and SupabaseStore (real Postgres + PostgREST) behave the same."""

import asyncio
import subprocess
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from conftest import OTHER_USER_ID, USER_ID, make_jwt

from app.billing.config import NotConfigured
from app.doorway.store import (
    MemoryStore,
    StoreError,
    SupabaseStore,
    doorway_store_cache_clear,
    get_doorway_store,
)

pytestmark = pytest.mark.anyio

TABLES = (
    "doorway_sites, doorway_patterns, doorway_capabilities, doorway_tools, "
    "doorway_tool_versions, doorway_sandboxes, doorway_jobs, doorway_messages, doorway_runs, "
    "doorway_races, doorway_requests, doorway_events, doorway_profiles, doorway_consents"
)
SITE = {"id": "sunrise-clinic", "name": "Sunrise Family Clinic", "base_url": "http://x.test/"}
SPEC = {"name": "book_appointment", "kind": "action", "strategies": {"api": {}}}


def _psql(postgrest, sql: str) -> None:
    subprocess.run([*postgrest["psql"], "-c", sql], check=True, stdout=subprocess.DEVNULL)


@pytest.fixture(params=["memory", "supabase"])
def store(request):
    if request.param == "memory":
        return MemoryStore()
    postgrest = request.getfixturevalue("postgrest")
    _psql(
        postgrest,
        f"truncate {TABLES} restart identity cascade; "
        f"insert into auth.users (id, email) values ('{USER_ID}', 'dev@example.com'), "
        f"('{OTHER_USER_ID}', 'other@example.com') on conflict (id) do nothing;",
    )
    return SupabaseStore(postgrest["url"], make_jwt({"role": "service_role"}))


@pytest.fixture
def backdate(store, request):
    """Make a sandbox's last heartbeat `seconds` old."""

    def _backdate(sandbox_id: str, seconds: int) -> None:
        if isinstance(store, MemoryStore):
            when = datetime.now(UTC) - timedelta(seconds=seconds)
            store.tables["doorway_sandboxes"][sandbox_id]["last_heartbeat"] = when.isoformat()
        else:
            _psql(
                request.getfixturevalue("postgrest"),
                f"update doorway_sandboxes set last_heartbeat = now() - interval '{seconds} "
                f"seconds' where id = '{sandbox_id}'",
            )

    return _backdate


async def _tool(store, name="book_appointment", **extra):
    await store.upsert_site(SITE)
    return await store.upsert_tool(
        {"site_id": SITE["id"], "name": name, "description": "Book", "kind": "action", **extra}
    )


async def test_site_upsert_merges_and_status(store):
    site = await store.upsert_site({**SITE, "tools_count": 3})  # computed keys are ignored
    assert site["status"] == "new" and site["is_demo"] is False and site["created_at"]
    await store.set_site_status(SITE["id"], "ready")
    again = await store.upsert_site({**SITE, "name": "Sunrise"})
    assert again["name"] == "Sunrise" and again["status"] == "ready"
    assert (await store.get_site(SITE["id"]))["name"] == "Sunrise"
    assert await store.get_site("nope") is None
    await store.upsert_site({**SITE, "id": "city-library"})
    assert [s["id"] for s in await store.list_sites()] == ["city-library", "sunrise-clinic"]
    with pytest.raises(StoreError):
        await store.set_site_status(SITE["id"], "sleeping")
    with pytest.raises(StoreError):
        await store.upsert_site({**SITE, "id": "Not A Slug"})
    with pytest.raises(StoreError):  # Postgres checks NOT NULL before resolving the conflict
        await store.upsert_site({"id": SITE["id"], "status": "ready"})


async def test_capability_and_tool_upserts_are_unique_per_site(store):
    await store.upsert_site(SITE)
    cap = {"site_id": SITE["id"], "name": "book", "description": "Book", "kind": "action"}
    first = await store.upsert_capability(cap)
    second = await store.upsert_capability({**first, "description": "Book a slot"})
    assert second["id"] == first["id"] and second["description"] == "Book a slot"
    assert second["status"] == "discovered" and second["evidence"] == {}
    assert len(await store.list_capabilities(SITE["id"])) == 1
    assert await store.list_capabilities("other-site") == []

    tool = await _tool(store, capability_id=first["id"])
    assert (tool["status"], tool["version"], tool["runs_count"]) == ("draft", 0, 0)
    same = await store.upsert_tool({**tool, "description": "Book an appointment"})
    assert same["id"] == tool["id"] and same["description"] == "Book an appointment"
    await _tool(store, name="list_open_slots", kind="read")
    assert [t["name"] for t in await store.list_tools(SITE["id"])] == [
        "book_appointment",
        "list_open_slots",
    ]
    assert (await store.find_tool(SITE["id"], "book_appointment"))["id"] == tool["id"]
    assert await store.find_tool(SITE["id"], "missing") is None
    await store.set_tool_status(tool["id"], "broken")
    await store.update_tool_stats(tool["id"], {"p50_ms": 84, "success_rate": 0.5, "runs_count": 2})
    got = await store.get_tool(tool["id"])
    assert (got["status"], got["p50_ms"], got["success_rate"], got["runs_count"]) == (
        "broken",
        84,
        0.5,
        2,
    )
    assert await store.get_tool(999999) is None
    with pytest.raises(StoreError):
        await _tool(store, name="Bad-Name")
    with pytest.raises(StoreError):  # unknown site
        await store.upsert_capability({**cap, "site_id": "ghost-site"})


async def test_publish_version_increments_and_updates_tool(store):
    tool = await _tool(store)
    v1 = await store.publish_version(
        tool["id"], SPEC, source="discover", verified_by="sandbox-2", strategies={"api": {}}
    )
    assert (v1["version"], v1["status"], v1["source"], v1["verified_by"]) == (
        1,
        "verified",
        "discover",
        "sandbox-2",
    )
    spec2 = {**SPEC, "preferred": "api"}
    v2 = await store.publish_version(
        tool["id"], spec2, source="heal", verified_by=None, strategies={"api": {"ms": 84}}
    )
    assert v2["version"] == 2 and v2["strategies"] == {"api": {"ms": 84}}
    got = await store.get_tool(tool["id"])
    assert (got["version"], got["status"], got["spec"]) == (2, "verified", spec2)
    assert [v["version"] for v in await store.list_versions(tool["id"])] == [2, 1]
    with pytest.raises(StoreError):
        await store.publish_version(999999, SPEC, source="seed", verified_by=None, strategies={})


async def test_jobs_claim_by_priority_then_age(store):
    await store.upsert_site(SITE)
    discover = await store.enqueue_job({"kind": "discover", "site_id": SITE["id"]})
    verify = await store.enqueue_job({"kind": "verify", "site_id": SITE["id"]})
    heal = await store.enqueue_job({"kind": "heal", "site_id": SITE["id"]})
    verify2 = await store.enqueue_job({"kind": "verify", "site_id": SITE["id"]})
    custom = await store.enqueue_job({"kind": "discover", "priority": 60})
    assert (discover["priority"], verify["priority"], heal["priority"]) == (10, 50, 100)
    assert discover["status"] == "queued" and discover["payload"] == {}
    assert (await store.claim_job("sb-1", ["discover"]))["id"] == custom["id"]
    order = [(await store.claim_job("sb-1"))["id"] for _ in range(4)]
    assert order == [heal["id"], verify["id"], verify2["id"], discover["id"]]
    assert await store.claim_job("sb-1") is None
    assert await store.claim_job("sb-1", []) is None


async def test_claim_respects_not_sandbox(store):
    job = await store.enqueue_job({"kind": "verify", "not_sandbox": "sb-1"})
    assert await store.claim_job("sb-1") is None
    claimed = await store.claim_job("sb-2")
    assert claimed["id"] == job["id"] and claimed["claimed_by"] == "sb-2"
    assert claimed["status"] == "running" and claimed["attempts"] == 1 and claimed["started_at"]


async def test_concurrent_claims_never_share_a_job(store):
    jobs = [await store.enqueue_job({"kind": "discover"}) for _ in range(10)]
    claims = await asyncio.gather(*(store.claim_job(f"sb-{i % 2}") for i in range(14)))
    claimed = [c for c in claims if c is not None]
    assert len(claimed) == 10
    assert sorted(c["id"] for c in claimed) == sorted(j["id"] for j in jobs)
    assert all(c["attempts"] == 1 and c["claimed_by"] in ("sb-0", "sb-1") for c in claimed)
    assert await store.list_jobs(status="queued") == []


async def test_requeue_stale_and_finish(store, backdate):
    await store.heartbeat({"id": "sb-a", "status": "busy"})
    await store.heartbeat({"id": "sb-b", "status": "busy"})
    a = await store.enqueue_job({"kind": "discover"})
    b = await store.enqueue_job({"kind": "discover"})
    assert (await store.claim_job("sb-a"))["id"] == a["id"]
    assert (await store.claim_job("sb-b"))["id"] == b["id"]
    assert await store.requeue_stale(60) == 0
    backdate("sb-a", 120)
    assert await store.requeue_stale(60) == 1
    jobs = {j["id"]: j for j in await store.list_jobs()}
    assert (jobs[a["id"]]["status"], jobs[a["id"]]["claimed_by"]) == ("queued", None)
    assert jobs[a["id"]]["started_at"] is None and jobs[b["id"]]["status"] == "running"
    again = await store.claim_job("sb-b")
    assert again["id"] == a["id"] and again["attempts"] == 2

    await store.finish_job(a["id"], ok=True, result={"tools": 3})
    await store.finish_job(b["id"], ok=False, error="boom")
    jobs = {j["id"]: j for j in await store.list_jobs()}
    assert (jobs[a["id"]]["status"], jobs[a["id"]]["result"]) == ("done", {"tools": 3})
    assert (jobs[b["id"]]["status"], jobs[b["id"]]["error"]) == ("failed", "boom")
    assert jobs[a["id"]]["finished_at"] and jobs[b["id"]]["finished_at"]
    assert [j["id"] for j in await store.list_jobs(status="done")] == [a["id"]]
    assert [j["id"] for j in await store.list_jobs(limit=1)] == [b["id"]]


async def test_heartbeat_upserts_sandbox(store, backdate):
    await store.heartbeat({"id": "sb-1", "status": "idle"})
    backdate("sb-1", 300)
    before = (await store.list_sandboxes())[0]["last_heartbeat"]
    await store.heartbeat({"id": "sb-1", "status": "busy", "current_job_id": 7, "jobs_done": 4})
    await store.heartbeat({"id": "sb-0"})
    sandboxes = await store.list_sandboxes()
    assert [s["id"] for s in sandboxes] == ["sb-0", "sb-1"]
    sb1 = sandboxes[1]
    assert (sb1["status"], sb1["current_job_id"], sb1["jobs_done"]) == ("busy", 7, 4)
    assert datetime.fromisoformat(sb1["last_heartbeat"]) > datetime.fromisoformat(before)


async def test_patterns_create_or_get_and_bookkeeping(store):
    await store.upsert_site(SITE)
    row = {
        "name": "slot_booking",
        "description": "list slots then book",
        "template": {"roles": {}},
        "created_by": "sb-1",
        "source_site_id": SITE["id"],
    }
    first = await store.create_pattern(row)
    assert (first["used_by"], first["success_count"], first["failure_count"]) == ([], 0, 0)
    again = await store.create_pattern({**row, "description": "different"})
    assert again["id"] == first["id"] and again["description"] == "list slots then book"
    await store.pattern_used(first["id"], "bella-bistro", True)
    await store.pattern_used(first["id"], "bella-bistro", True)
    await store.pattern_used(first["id"], "pawsome-vet", False)
    [pattern] = await store.list_patterns()
    assert pattern["used_by"] == ["bella-bistro", "pawsome-vet"]
    assert (pattern["success_count"], pattern["failure_count"]) == (2, 1)


async def test_messages_since_and_recipient(store):
    m1 = await store.post_message({"from_sandbox": "sb-1", "kind": "hello"})
    m2 = await store.post_message(
        {"from_sandbox": "sb-1", "to_sandbox": "sb-2", "kind": "need_tool", "body": {"x": 1}}
    )
    m3 = await store.post_message({"from_sandbox": "sb-2", "to_sandbox": "sb-3", "kind": "broken"})
    assert m1["to_sandbox"] is None and m1["body"] == {} and m2["body"] == {"x": 1}
    assert [m["id"] for m in await store.list_messages()] == [m3["id"], m2["id"], m1["id"]]
    assert [m["id"] for m in await store.list_messages(since=m1["id"])] == [m2["id"], m3["id"]]
    assert [m["id"] for m in await store.list_messages(to="sb-2")] == [m2["id"], m1["id"]]
    assert [m["id"] for m in await store.list_messages(since=m2["id"], to="sb-2")] == []
    with pytest.raises(StoreError):
        await store.post_message({"from_sandbox": "sb-1", "kind": "gossip"})


async def test_events_since_and_site_filter(store):
    await store.upsert_site(SITE)
    e1 = await store.emit(SITE["id"], "discover.start", "Exploring", sandbox_id="sb-1")
    e2 = await store.emit(None, "sandbox.online", "sb-2 up", {"region": "local"})
    e3 = await store.emit(SITE["id"], "verify.pass", "ok", {"ms": 84})
    assert (e1["data"], e1["sandbox_id"], e2["site_id"]) == ({}, "sb-1", None)
    assert e3["data"] == {"ms": 84} and e3["created_at"]
    assert [e["id"] for e in await store.list_events()] == [e3["id"], e2["id"], e1["id"]]
    assert [e["id"] for e in await store.list_events(since=e1["id"])] == [e2["id"], e3["id"]]
    assert [e["id"] for e in await store.list_events(site_id=SITE["id"])] == [e3["id"], e1["id"]]
    assert [e["id"] for e in await store.list_events(SITE["id"], since=e1["id"])] == [e3["id"]]
    assert [e["id"] for e in await store.list_events(limit=1)] == [e3["id"]]
    with pytest.raises(StoreError):  # site_id is a foreign key
        await store.emit("ghost-site", "lookup.miss", "unknown")


async def test_runs_races_and_requests(store):
    tool = await _tool(store)
    r1 = await store.record_run(
        {"tool_id": tool["id"], "site_id": SITE["id"], "mode": "broker", "status": "success"}
    )
    r2 = await store.record_run({"tool_id": tool["id"], "mode": "dashboard", "status": "failure"})
    await store.record_run({"mode": "browser_agent", "status": "success", "tokens": 18400})
    assert [r["id"] for r in await store.list_runs(tool["id"])] == [r2["id"], r1["id"]]
    assert len(await store.list_runs()) == 3 and len(await store.list_runs(limit=1)) == 1

    race = await store.create_race({"id": "race_1", "site_id": SITE["id"], "task": "Book"})
    assert (race["status"], race["browser"], race["inputs"]) == ("queued", {}, {})
    await store.update_race("race_1", {"status": "running", "broker": {"ms": 310}})
    got = await store.get_race("race_1")
    assert (got["status"], got["broker"]) == ("running", {"ms": 310})
    assert await store.get_race("race_x") is None

    req = await store.create_request({"id": "req_1", "website": "http://x.test/", "task": "Book"})
    assert req["status"] == "discovering" and req["result"] is None
    await store.update_request(
        "req_1", {"status": "done", "site_id": SITE["id"], "result": {"ok": True}}
    )
    got = await store.get_request("req_1")
    assert (got["status"], got["site_id"], got["result"]) == ("done", SITE["id"], {"ok": True})
    with pytest.raises(StoreError):
        await store.create_request({"id": "req_1", "website": "http://x.test/", "task": "Again"})


async def test_profile_save_and_get(store):
    assert await store.get_profile(USER_ID) == {"fields": {}}
    fields = {"full_name": "Ada Lovelace", "phone": "555-0100"}
    assert await store.save_profile(USER_ID, fields) == {"fields": fields}
    assert await store.get_profile(USER_ID) == {"fields": fields}
    assert await store.save_profile(USER_ID, {"email": "a@x.test"}) == {
        "fields": {"email": "a@x.test"}
    }
    assert await store.get_profile(OTHER_USER_ID) == {"fields": {}}


async def test_consents_grant_list_and_revoke_only_own(store):
    await store.upsert_site(SITE)
    await store.upsert_site({**SITE, "id": "city-library"})
    mine = await store.grant_consent(USER_ID, SITE["id"], ["full_name"])
    updated = await store.grant_consent(USER_ID, SITE["id"], ["full_name", "phone"])
    assert updated["id"] == mine["id"] and updated["fields"] == ["full_name", "phone"]
    library = await store.grant_consent(USER_ID, "city-library", ["email"])
    theirs = await store.grant_consent(OTHER_USER_ID, SITE["id"], ["phone"])
    listed = await store.list_consents(USER_ID)
    assert [c["id"] for c in listed] == [library["id"], mine["id"]]
    assert listed[1]["site_id"] == SITE["id"] and listed[1]["granted_at"]

    await store.revoke_consent(OTHER_USER_ID, mine["id"])  # not theirs: no effect
    assert len(await store.list_consents(USER_ID)) == 2
    await store.revoke_consent(USER_ID, mine["id"])
    assert [c["id"] for c in await store.list_consents(USER_ID)] == [library["id"]]
    assert [c["id"] for c in await store.list_consents(OTHER_USER_ID)] == [theirs["id"]]


async def test_rls_public_tables_read_only_and_private_tables_hidden(postgrest):
    service = SupabaseStore(postgrest["url"], make_jwt({"role": "service_role"}))
    _psql(
        postgrest,
        f"truncate {TABLES} restart identity cascade; "
        f"insert into auth.users (id, email) values ('{USER_ID}', 'dev@example.com'), "
        f"('{OTHER_USER_ID}', 'other@example.com') on conflict (id) do nothing;",
    )
    await _tool(service)
    await service.save_profile(USER_ID, {"phone": "555"})
    await service.save_profile(OTHER_USER_ID, {"phone": "666"})
    await service.create_request({"id": "req_1", "website": "http://x.test/", "task": "t"})
    url = postgrest["url"]
    user = {"Authorization": f"Bearer {make_jwt({'role': 'authenticated', 'sub': USER_ID})}"}
    async with httpx.AsyncClient() as http:
        tools = await http.get(f"{url}/doorway_tools")
        assert tools.status_code == 200 and [t["name"] for t in tools.json()] == [
            "book_appointment"
        ]
        insert = await http.post(
            f"{url}/doorway_tools",
            json={"site_id": SITE["id"], "name": "evil", "description": "x", "kind": "read"},
        )
        assert insert.status_code in (401, 403)
        assert (await http.get(f"{url}/doorway_profiles")).status_code in (401, 403)
        assert (await http.get(f"{url}/doorway_requests")).status_code in (401, 403)
        claim = await http.post(f"{url}/rpc/doorway_claim_job", json={"p_sandbox": "x"})
        assert claim.status_code in (401, 403, 404)

        own = await http.get(f"{url}/doorway_profiles", headers=user)
        assert own.status_code == 200 and [p["user_id"] for p in own.json()] == [USER_ID]
        patch = await http.patch(
            f"{url}/doorway_tools", params={"name": "eq.book_appointment"},
            json={"status": "broken"}, headers=user,
        )  # fmt: skip
        assert patch.status_code in (401, 403)
    assert (await service.find_tool(SITE["id"], "book_appointment"))["status"] == "draft"


async def test_get_doorway_store_reads_settings(configure):
    doorway_store_cache_clear()
    with pytest.raises(NotConfigured):
        get_doorway_store()
    configure(SUPABASE_URL="https://ref.supabase.co/", SUPABASE_SECRET_KEY="sb_secret_x")
    doorway_store_cache_clear()
    built = get_doorway_store()
    assert built._url == "https://ref.supabase.co/rest/v1" and "Authorization" not in built._headers
    assert get_doorway_store() is built
    configure(SUPABASE_REST_URL="http://127.0.0.1:1/")
    doorway_store_cache_clear()
    assert get_doorway_store()._url == "http://127.0.0.1:1"
    doorway_store_cache_clear()

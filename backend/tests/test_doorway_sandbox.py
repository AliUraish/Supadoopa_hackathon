"""Sandboxes end to end: heuristic discovery, independent verification on another sandbox,
shared patterns, healing after the site's API changes, and the browser-vs-broker race.

Runs against the real demo clinic (Node, skipped without `node`) and Bella Bistro (in
process), headless Chromium and MemoryStore. Never calls Anthropic: the LLM key is cleared.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from app.billing import config
from app.doorway import executor, explorer, patterns
from app.doorway.browser import close_browser, get_browser
from app.doorway.sandbox import JobContext, jobs, run_workers
from app.doorway.sandbox.browser_agent import artifacts_dir
from app.doorway.store import MemoryStore

ROOT = Path(__file__).resolve().parents[2]
CLINIC = ROOT / "supabase" / "compute" / "clinic" / "dev.mjs"
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "clinic_v1_tools.json").read_text())
TOKEN = "sandbox-test-admin"
SITE = "sunrise-clinic"
PRIVATE = ("000-0000", "Doorway Verifier")  # test identity: must never reach events/races

pytestmark = pytest.mark.anyio


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"  # one loop for the module, so one shared Chromium


@pytest.fixture(autouse=True)
def no_llm(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DOORWAY_MODEL", raising=False)
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def clinic_server():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    port = _free_port()
    env = {**os.environ, "PORT": str(port), "CLINIC_ADMIN_TOKEN": TOKEN}
    proc = subprocess.Popen(
        [node, str(CLINIC)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    base = f"http://127.0.0.1:{port}/"
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                httpx.get(base, timeout=1.0)
                break
            except httpx.HTTPError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        yield base
    finally:
        proc.terminate()
        proc.wait(timeout=10)


@pytest.fixture
def clinic(clinic_server):
    admin(clinic_server, "reset")
    return clinic_server


@pytest.fixture(scope="module")
async def browser():
    try:
        shared = await get_browser()
    except Exception as exc:  # Chromium not installed
        pytest.skip(f"chromium unavailable: {exc}")
    yield shared
    await close_browser()


@pytest.fixture(scope="module")
def bistro_url():
    try:
        from demo_sites import create_app
        from demo_sites.common import start_server
    except ImportError:
        pytest.skip("demo_sites not available")
    running = start_server(create_app("bella-bistro"))
    yield running.url
    running.stop()


def admin(base: str, path: str, body: dict | None = None) -> dict:
    res = httpx.post(f"{base}admin/{path}", json=body or {}, headers={"x-admin-token": TOKEN})
    res.raise_for_status()
    return res.json()


async def new_store(
    base: str, site_id: str = SITE, name: str = "Sunrise Family Clinic"
) -> MemoryStore:
    store = MemoryStore()
    await store.upsert_site(
        {"id": site_id, "name": name, "base_url": base, "goal": "Book an appointment",
         "is_demo": True}
    )  # fmt: skip
    return store


async def run_until(store, ids, done, limit: float = 120.0) -> None:
    """Run sandboxes `ids` in-process until `done()` (async) is true, then stop them."""
    stop = asyncio.Event()
    task = asyncio.create_task(run_workers(store, ids, stop=stop, poll=0.05, heartbeat=0.5))
    try:
        deadline = time.monotonic() + limit
        while not await done():
            assert not task.done(), task.exception()
            assert time.monotonic() < deadline, "timed out waiting for the sandboxes"
            await asyncio.sleep(0.1)
    finally:
        stop.set()
        await asyncio.wait_for(task, 30)


def job_done(store, kind: str, site_id: str = SITE):
    async def check() -> bool:
        return any(
            j["kind"] == kind and j["site_id"] == site_id and j["status"] in ("done", "failed")
            for j in await store.list_jobs()
        )

    return check


async def seed_clinic(store) -> None:
    """discover on sandbox-a, verify on sandbox-b, called directly (no worker loop)."""
    a, b = JobContext(store, "sandbox-a"), JobContext(store, "sandbox-b")
    await jobs.discover({"kind": "discover", "site_id": SITE, "payload": {}}, a)
    assert await store.claim_job("sandbox-a", ["verify"]) is None  # not on the compiler
    verify_job = await store.claim_job("sandbox-b", ["verify"])
    await store.finish_job(verify_job["id"], ok=True, result=await jobs.verify(verify_job, b))
    optimize_job = await store.claim_job("sandbox-b", ["optimize"])  # not needed here
    await store.finish_job(optimize_job["id"], ok=True, result={"skipped": "test"})


def bookings(base: str) -> list:
    res = httpx.get(f"{base}admin/state", headers={"x-admin-token": TOKEN})
    return res.json()["bookings"]


def public_text(rows) -> str:
    return json.dumps(rows, default=str)


# --- patterns (no site needed) ---------------------------------------------------------------


def test_slot_booking_pattern_is_derived_matched_and_adopted():
    pattern = patterns.derive_pattern(SITE, FIXTURE)
    assert pattern["name"] == "slot_booking"
    assert pattern["signature"]["example"] == {
        "list_slots": "list_open_slots", "book_slot": "book_appointment",
        "list_resources": "list_doctors",
    }  # fmt: skip
    mapping = patterns.match(pattern, FIXTURE)
    assert mapping["book_slot"]["inputs"] == {
        "slot_id": "slot_id", "name": "patient_name", "phone": "phone"
    }  # fmt: skip
    adopted = {s["name"]: s for s in patterns.adopt(pattern, mapping, FIXTURE)}
    assert set(adopted) == {"list_resources", "list_slots", "book_slot"}
    book = adopted["book_slot"]
    assert set(book["input_schema"]["properties"]) == {"slot_id", "name", "phone"}
    assert book["test"]["input"]["slot_id"] == "{{from:list_slots:0.id}}"
    assert book["strategies"]["api"]["request"]["body"]["patient_name"] == "{{name}}"
    # |filters survive renaming (the form path gets the doctor from the slot id)
    assert book["strategies"]["form"]["fields"][0]["value"] == "{{slot_id|split:-:0}}"
    assert adopted["list_slots"]["strategies"]["api"]["request"]["query"] == {
        "doctor": "{{resource_id}}", "date": "{{date}}"
    }  # fmt: skip
    assert book["profile_fields"] == {"name": "full_name", "phone": "phone"}


def test_pet_names_are_not_person_names():
    assert patterns.input_kind("owner_name") == "name"
    assert patterns.input_kind("fullName") == "name"
    assert patterns.input_kind("pet_name") == "other"
    assert patterns.input_kind("phoneNumber") == "phone"


async def test_worker_lifecycle_heartbeats_and_messages():
    store = MemoryStore()
    stop = asyncio.Event()
    task = asyncio.create_task(run_workers(store, ["sandbox-9"], stop=stop, poll=0.05))
    await asyncio.sleep(0.3)
    assert (await store.list_sandboxes())[0]["status"] == "idle"
    stop.set()
    await asyncio.wait_for(task, 10)
    sandbox = (await store.list_sandboxes())[0]
    assert sandbox["id"] == "sandbox-9" and sandbox["status"] == "offline"
    assert [m["kind"] for m in await store.list_messages()] == ["hello"]
    kinds = {e["kind"] for e in await store.list_events()}
    assert {"sandbox.online", "sandbox.offline"} <= kinds


# --- the live clinic --------------------------------------------------------------------------


async def test_heuristic_discover_on_clinic_yields_verified_tools(clinic, browser):
    site = {"id": SITE, "name": "Sunrise Family Clinic", "base_url": clinic, "is_demo": True}
    events = []
    out = await explorer.discover(site, patterns=[], on_event=lambda *e: events.append(e))
    specs = {s["name"]: s for s in out["tools"]}
    assert list(specs) == ["list_doctors", "list_slots", "book_appointment"]
    assert out["explorer"] == "heuristic" and out["pattern_id"] is None
    book = specs["book_appointment"]
    assert set(book["strategies"]) == {"api", "form", "browser"}
    assert book["strategies"]["api"]["request"]["path"] == "api/appointments"
    assert book["test"]["input"]["slot_id"] == "{{from:list_slots:0.id}}"
    assert specs["list_slots"]["input_schema"]["required"] == ["doctor_id", "date"]
    assert [s["side_effect"] for s in specs.values()] == ["read", "read", "irreversible_write"]
    assert {"explore.api", "explore.action"} <= {e[0] for e in events}
    assert not any(p in public_text(events) for p in PRIVATE[:1])  # typed values never logged

    results, _, held = await jobs.verify_specs(out["tools"], clinic, allow_irreversible=True)
    assert held == [] and all(r.passed for r in results), results
    assert {s for r in results for s, v in r.by_strategy.items() if v["passed"]} == {
        "api", "form", "browser"
    }  # fmt: skip


async def test_real_sites_hold_irreversible_writes_for_a_person(clinic, browser):
    results, _, held = await jobs.verify_specs(FIXTURE, clinic, allow_irreversible=False)
    assert held == ["book_appointment"]
    assert [r.name for r in results] == ["list_doctors", "list_open_slots"]
    assert all(r.passed for r in results)
    assert bookings(clinic) == []  # nothing was booked


async def test_pipeline_two_sandboxes_verify_independently(clinic, browser):
    store = await new_store(clinic)
    await store.enqueue_job({"kind": "discover", "site_id": SITE})
    await run_until(store, ["sandbox-1", "sandbox-2"], job_done(store, "optimize"))

    by_kind = {j["kind"]: j for j in await store.list_jobs()}
    assert {k: j["status"] for k, j in by_kind.items()} == {
        "discover": "done", "verify": "done", "optimize": "done"
    }  # fmt: skip
    compiled_by = by_kind["discover"]["claimed_by"]
    assert by_kind["verify"]["not_sandbox"] == compiled_by
    assert by_kind["verify"]["claimed_by"] not in (None, compiled_by)  # a different sandbox
    verified_by = by_kind["verify"]["claimed_by"]

    tools = await store.list_tools(SITE)
    assert [t["name"] for t in tools] == ["list_doctors", "list_slots", "book_appointment"]
    assert {t["status"] for t in tools} == {"verified"}
    assert [t["price_cents"] for t in tools] == [0, 0, 50]
    for tool in tools:
        (version,) = await store.list_versions(tool["id"])
        assert version["verified_by"] == verified_by and version["source"] == "discover"
        assert tool["best_strategy"] == "api" and tool["p50_ms"] is not None  # optimizer ran
    assert (await store.get_site(SITE))["status"] == "ready"
    assert {c["status"] for c in await store.list_capabilities(SITE)} == {"verified"}

    (pattern,) = await store.list_patterns()
    assert pattern["name"] == "slot_booking" and pattern["created_by"] == verified_by
    assert pattern["source_site_id"] == SITE

    messages = await store.list_messages()
    assert sorted(m["kind"] for m in messages) == sorted(
        ["hello", "hello", "tool_published", "validated", "pattern_published"]
    )
    events = await store.list_events(limit=1000)
    kinds = {e["kind"] for e in events}
    assert {"sandbox.online", "discover.start", "observe.capability", "compile.tool",
            "verify.start", "verify.pass", "publish.tool", "optimize.result"} <= kinds  # fmt: skip
    assert "000-0000" not in public_text(events) + public_text(messages)
    assert {s["status"] for s in await store.list_sandboxes()} == {"offline"}


async def test_heal_after_the_site_changes_keeps_names(clinic, browser):
    store = await new_store(clinic)
    await seed_clinic(store)
    before = {t["name"]: t for t in await store.list_tools(SITE)}
    admin(clinic, "version", {"version": "v2"})
    args = {"doctor_id": "khan", "date": "2030-01-15"}
    broken = await executor.execute(before["list_slots"]["spec"], args, clinic, strategy="api")
    assert not broken.ok and broken.broken

    tool = before["list_slots"]
    await store.enqueue_job(
        {"kind": "heal", "site_id": SITE, "tool_id": tool["id"],
         "payload": {"tool_id": tool["id"], "error": broken.error}}
    )  # fmt: skip
    await run_until(store, ["sandbox-3"], job_done(store, "heal"))

    (heal_job,) = [j for j in await store.list_jobs() if j["kind"] == "heal"]
    assert heal_job["status"] == "done", heal_job["error"]
    after = {t["name"]: t for t in await store.list_tools(SITE)}
    assert list(after) == list(before)
    for name, t in after.items():
        assert t["status"] == "verified" and t["version"] == 2
        assert t["spec"]["input_schema"] == before[name]["spec"]["input_schema"]
        assert t["spec"]["strategies"]["api"]["request"]["path"].startswith("api/v2/")
        assert [v["source"] for v in await store.list_versions(t["id"])] == ["heal", "discover"]
    slots = await executor.execute(after["list_slots"]["spec"], args, clinic, strategy="api")
    assert slots.ok and slots.data, slots.error
    kinds = [e["kind"] for e in await store.list_events(limit=1000)]
    assert "heal.start" in kinds and "heal.done" in kinds and "heal.fail" not in kinds
    assert (await store.get_site(SITE))["status"] == "ready"
    assert "broken" in [m["kind"] for m in await store.list_messages()]


async def test_race_broker_beats_the_browser_agent(clinic, browser):
    store = await new_store(clinic)
    await seed_clinic(store)
    race_id = "race_test1"
    await store.create_race(
        {"id": race_id, "site_id": SITE, "task": "Book the earliest available appointment"}
    )
    await store.enqueue_job({"kind": "race", "site_id": SITE, "payload": {"race_id": race_id}})
    await run_until(store, ["sandbox-4"], job_done(store, "race"))

    race = await store.get_race(race_id)
    assert race["status"] == "done"
    broker, browser_side = race["broker"], race["browser"]
    assert broker["success"] is True and browser_side["success"] is True, race
    assert broker["ms"] < browser_side["ms"]
    assert broker["tokens"] == 0 and browser_side["tokens"] == 0  # no LLM key: never faked
    assert browser_side["agent"] == "scripted (no LLM key)"
    assert broker["log"][-1]["detail"].startswith("book_appointment(")
    shots = [s["screenshot"] for s in browser_side["log"] if s.get("screenshot")]
    assert shots and all((artifacts_dir() / name).exists() for name in shots)
    assert not any(p in public_text(race) for p in PRIVATE)
    runs = await store.list_runs()
    assert sorted(r["mode"] for r in runs) == ["broker", "browser_agent"]
    assert {r["status"] for r in runs} == {"success"}
    assert len(bookings(clinic)) >= 2


async def test_second_booking_site_reuses_the_clinic_pattern(clinic, bistro_url, browser):
    store = await new_store(clinic)
    await seed_clinic(store)
    (pattern,) = await store.list_patterns()
    await store.upsert_site(
        {"id": "bella-bistro", "name": "Bella Bistro", "base_url": bistro_url,
         "goal": "Reserve a table", "is_demo": True}
    )  # fmt: skip
    a, b = JobContext(store, "sandbox-a"), JobContext(store, "sandbox-b")
    result = await jobs.discover({"kind": "discover", "site_id": "bella-bistro"}, b)
    assert result["pattern_id"] == pattern["id"]
    events = await store.list_events("bella-bistro", limit=500)
    reuse = [e for e in events if e["kind"] == "reuse.pattern"]
    assert reuse and reuse[0]["data"]["roles"] == {
        "list_slots": "list_times", "book_slot": "book_reservation", "list_resources": "list_areas"
    }  # fmt: skip

    verify_job = next(
        j
        for j in await store.list_jobs()
        if j["kind"] == "verify" and j["site_id"] == "bella-bistro"
    )
    assert verify_job["not_sandbox"] == "sandbox-b"
    await jobs.verify(verify_job, a)
    tools = {t["name"]: t for t in await store.list_tools("bella-bistro")}
    assert set(tools) == {"list_resources", "list_slots", "book_slot"}
    assert {t["status"] for t in tools.values()} == {"verified"}
    assert {t["pattern_id"] for t in tools.values()} == {pattern["id"]}
    book = tools["book_slot"]["spec"]
    assert set(book["input_schema"]["properties"]) == {"slot_id", "name", "phone", "party_size"}
    assert (await store.list_versions(tools["book_slot"]["id"]))[0]["source"] == "reuse"
    (pattern,) = await store.list_patterns()  # still one shared pattern, now used twice
    assert pattern["used_by"] == ["bella-bistro"] and pattern["success_count"] == 1

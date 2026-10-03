"""Doorway spec + executor against the real demo clinic (Node) and headless Chromium.

Skipped when `node` is missing; browser tests skip when Chromium can't launch.
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

from app.doorway import executor, spec
from app.doorway.browser import close_browser, get_browser

ROOT = Path(__file__).resolve().parents[2]
CLINIC = ROOT / "supabase" / "compute" / "clinic" / "dev.mjs"
SEED = json.loads((ROOT / "supabase/compute/doorway/seed/sunrise-clinic.v1.json").read_text())
TOOLS = json.loads((Path(__file__).parent / "fixtures" / "clinic_v1_tools.json").read_text())
LIST_DOCTORS, LIST_SLOTS, BOOK = TOOLS
TOKEN = "doorway-test-admin"
PATIENT = {"patient_name": "Ada Lovelace", "phone": "555-0100"}

pytestmark = pytest.mark.anyio


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"  # module scope: one event loop, so one shared Chromium for the module


@pytest.fixture(scope="session")
def clinic_server():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
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
    httpx.post(f"{clinic_server}admin/reset", headers={"x-admin-token": TOKEN}).raise_for_status()
    return clinic_server


@pytest.fixture(scope="module")
async def browser():
    try:
        shared = await get_browser()
    except Exception as exc:  # Chromium not installed
        pytest.skip(f"chromium unavailable: {exc}")
    yield shared
    await close_browser()


async def admin(base: str, method: str, path: str, body: dict | None = None) -> dict:
    async with httpx.AsyncClient() as client:
        res = await client.request(
            method, f"{base}admin/{path}", json=body, headers={"x-admin-token": TOKEN}
        )
        res.raise_for_status()
        return res.json()


async def fresh_slot(base: str, doctor: str = "ortega", date: str = "2026-12-03") -> str:
    r = await executor.execute(LIST_SLOTS, {"doctor_id": doctor, "date": date}, base)
    assert r.ok, r.error
    return r.data[0]["id"]


# --- spec (no site needed) -------------------------------------------------------------


def test_legacy_spec_normalizes_and_everything_validates():
    doctors, slots, book = (spec.normalize(s) for s in SEED)
    assert "request" not in doctors and doctors["strategies"]["api"]["response"] == {
        "select": "doctors"
    }
    assert (doctors["kind"], slots["kind"], book["kind"]) == ("read", "read", "action")
    assert book["preferred"] == "api" and spec.available(book) == ["api"]
    assert SEED[0]["request"]["path"] == "api/doctors"  # input untouched
    assert all(spec.validate(s) == [] for s in [*SEED, *TOOLS])
    assert spec.available({**LIST_DOCTORS, "preferred": "form"}) == ["form", "api", "browser"]
    assert spec.depends_on(BOOK) == ["list_open_slots"]


def test_validate_rejects_unsafe_or_incomplete_specs():
    base = {"name": "t_tool", "description": "x", "input_schema": {"type": "object"}}
    assert "at least one strategy (api, form, browser) required" in spec.validate(base)
    bad_api = {
        **base,
        "request": {"method": "TRACE", "path": "http://evil.example/x", "headers": {"Cookie": "a"}},
    }
    errors = spec.validate(bad_api)
    assert {"api.request.method invalid", "api.request.path must be relative"} <= set(errors)
    assert "header Cookie not allowed" in errors
    bad_pages = {
        **base,
        "name": "Bad-Name",
        "strategies": {
            "form": {"fields": [{"action": "fill", "value": "x"}], "result": {}},
            "browser": {
                "steps": [{"action": "hover", "selector": "#a"}],
                "result": {"selector": "#r"},
            },
        },
    }
    errors = spec.validate(bad_pages)
    assert "name must be snake_case" in errors
    assert "form.fields[0].selector required" in errors
    assert "form.result.selector required" in errors
    assert "browser.steps[0].action invalid" in errors


def test_render_keeps_types_and_splits_ids():
    inputs = {"n": 3, "flag": True, "slot": "khan-2026-12-01-0900", "obj": {"a": 1}}
    out = spec.render(
        {"n": "{{n}}", "s": "n={{ n }} f={{flag}}", "o": "{{obj}}", "missing": "{{nope}}",
         "doc": "{{slot|split:-:0}}", "day": "{{slot|split:-:1:4}}", "list": ["{{n}}", 1]},
        inputs.get,
    )  # fmt: skip
    assert out == {
        "n": 3, "s": "n=3 f=true", "o": {"a": 1}, "missing": None,
        "doc": "khan", "day": "2026-12-01", "list": [3, 1],
    }  # fmt: skip
    assert spec.get_path({"a": [{"b": 2}]}, "a.0.b") == 2
    assert spec.get_path({"a": []}, "a.0.b") is None
    assert spec.resolve_test_inputs(BOOK, {"list_open_slots": [{"id": "s1"}]})["slot_id"] == "s1"
    with pytest.raises(ValueError, match="no output"):
        spec.resolve_test_inputs(BOOK, {})


def test_resolve_url_refuses_anything_outside_the_site():
    base = "http://clinic.test/app/"
    assert spec.resolve_url(base, "/api/slots", {"d": "x y", "n": None}) == (
        "http://clinic.test/app/api/slots?d=x+y"
    )
    assert spec.resolve_url("http://clinic.test/app", "") == "http://clinic.test/app/"
    for path in (
        "http://evil.example/",
        "https://clinic.test/app/x",
        "javascript:alert(1)",
        "../admin/version",
        "%2e%2e/admin",
        "a/..%2f../admin",
    ):
        with pytest.raises(ValueError, match="refusing|outside"):
            spec.resolve_url(base, path)


async def test_ssrf_guard_in_execute_is_a_broken_spec():
    evil = {**SEED[0], "request": {"method": "GET", "path": "{{target}}"}}
    r = await executor.execute(evil, {"target": "http://169.254.169.254/latest"}, "http://x.test/")
    assert not r.ok and r.broken and "refusing" in r.error


# --- live clinic ---------------------------------------------------------------------------


async def test_legacy_seed_passes_verify_via_api(clinic):
    results = await executor.verify(SEED, clinic)
    assert [(r.name, r.passed, r.strategy) for r in results] == [
        ("list_doctors", True, "api"),
        ("list_open_slots", True, "api"),
        ("book_appointment", True, "api"),
    ]
    assert "apt_" in results[2].sample and results[2].status == 201
    assert set(results[2].by_strategy) == {"api"}


async def test_all_three_strategies_verify_and_api_is_fastest(clinic, browser):
    results = await executor.verify(TOOLS, clinic, browser=browser)
    for r in results:
        assert r.passed and r.strategy == "api", (r.name, r.error, r.by_strategy)
        assert {s: v["passed"] for s, v in r.by_strategy.items()} == {
            "api": True, "form": True, "browser": True,
        }, r.by_strategy  # fmt: skip
        page_ms = min(r.by_strategy["form"]["ms"], r.by_strategy["browser"]["ms"])
        assert r.by_strategy["api"]["ms"] < page_ms, r.by_strategy
    # Every strategy booked its own fresh slot (the producer was re-run between them).
    booked = (await admin(clinic, "GET", "state"))["bookings"]
    assert sorted(b["slotId"] for b in booked) == [
        "khan-2026-12-01-0900", "khan-2026-12-01-0930", "khan-2026-12-01-1000",
    ]  # fmt: skip
    form = await executor.execute(LIST_SLOTS, {"doctor_id": "khan", "date": "2026-12-01"}, clinic,
                                  strategy="form")  # fmt: skip
    assert form.ok and form.data[0] == {"id": "khan-2026-12-01-1030", "time": "10:30"}
    assert form.steps == 4  # goto, select, fill, submit


async def test_shared_browser_serves_concurrent_tasks(clinic, browser):
    first, second = await asyncio.gather(get_browser(), get_browser())
    assert first is second is browser
    runs = await asyncio.gather(
        *(executor.execute(LIST_DOCTORS, {}, clinic, strategy=s) for s in ("form", "browser") * 2)
    )
    assert all(r.ok and r.data[0]["id"] == "khan" for r in runs), [r.error for r in runs]


async def test_v2_breaks_api_but_page_strategies_heal_by_fallback(clinic, browser):
    await admin(clinic, "POST", "version", {"version": "v2"})

    api = await executor.execute(LIST_DOCTORS, {}, clinic, strategy="api")
    assert not api.ok and api.broken and api.status == 410 and "retired" in api.error
    for strategy in ("form", "browser"):
        r = await executor.execute(LIST_DOCTORS, {}, clinic, strategy=strategy, browser=browser)
        assert r.ok and r.data[0]["id"] == "khan", (strategy, r.error)

    fallback = await executor.execute(LIST_DOCTORS, {}, clinic)
    assert fallback.ok and fallback.strategy == "form" and not fallback.broken
    assert "410" in fallback.error or "retired" in fallback.error

    slot = "chen-2026-12-02-0900"
    booked = await executor.execute(BOOK, {"slot_id": slot, **PATIENT}, clinic)
    assert booked.ok and booked.strategy == "form", booked.error
    assert booked.data.startswith("Booked! Dr. Mei Chen, 2026-12-02 09:00. Reference apt_")

    results = await executor.verify(TOOLS, clinic, browser=browser)
    for r in results:
        assert r.passed and r.strategy == "form", (r.name, r.error)
        assert r.by_strategy["api"]["broken"] and not r.by_strategy["api"]["passed"]
        assert r.by_strategy["browser"]["passed"]


async def test_input_errors_are_not_broken_and_do_not_fall_back(clinic, browser):
    missing = await executor.execute(BOOK, {"slot_id": "khan-2026-12-01-0900"}, clinic)
    assert not missing.ok and not missing.broken and missing.steps == 0
    assert missing.error == "missing input: patient_name, phone"

    slot = await fresh_slot(clinic)
    assert (await executor.execute(BOOK, {"slot_id": slot, **PATIENT}, clinic)).ok
    taken = await executor.execute(BOOK, {"slot_id": slot, **PATIENT}, clinic)
    assert (taken.ok, taken.broken, taken.status, taken.strategy) == (False, False, 409, "api")
    assert taken.error == "slot_taken" and taken.data == {"error": "slot_taken"}

    for strategy in ("form", "browser"):
        r = await executor.execute(BOOK, {"slot_id": slot, **PATIENT}, clinic, strategy=strategy)
        assert not r.ok and not r.broken and r.error == f"slot {slot} is not open", r.error
    assert len((await admin(clinic, "GET", "state"))["bookings"]) == 1


async def test_form_reports_the_sites_own_error_as_input_error(clinic, browser):
    slot = await fresh_slot(clinic)
    blank = await executor.execute(
        BOOK, {"slot_id": slot, "patient_name": " ", "phone": "1"}, clinic, strategy="form"
    )
    assert not blank.ok and not blank.broken
    assert blank.error == "Could not book: name_and_phone_required"


async def test_missing_selector_means_broken(clinic, browser, monkeypatch):
    monkeypatch.setattr(executor, "ACTION_TIMEOUT_MS", 1_000)
    renamed = json.loads(json.dumps(LIST_SLOTS).replace("#find", "#search"))
    r = await executor.execute(renamed, {"doctor_id": "khan", "date": "2026-12-01"}, clinic,
                               strategy="form")  # fmt: skip
    assert not r.ok and r.broken and "#search" in r.error and r.steps == 3


async def test_benchmark_reports_p50_per_strategy(clinic, browser):
    report = await executor.benchmark(LIST_DOCTORS, {}, clinic, browser=browser, runs=3)
    assert set(report) == {"api", "form", "browser"}
    assert all(v["passed"] and v["p50_ms"] >= 0 and v["runs"] == 3 for v in report.values())
    assert report["api"]["p50_ms"] < min(report["form"]["p50_ms"], report["browser"]["p50_ms"])

    async def new_booking() -> dict:
        return {"slot_id": await fresh_slot(clinic, "chen"), **PATIENT}

    actions = await executor.benchmark(
        BOOK, {}, clinic, browser=browser, runs=2, inputs_factory=new_booking
    )
    assert all(v["passed"] for v in actions.values()), actions
    assert actions["api"]["p50_ms"] < min(actions["form"]["p50_ms"], actions["browser"]["p50_ms"])
    assert len((await admin(clinic, "GET", "state"))["bookings"]) == 6

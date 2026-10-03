"""Demo sites: the private API (v1, v2, 410 after a switch), admin endpoints, and a real
browser clicking through each page under both versions."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from demo_sites import SITES, create_app, registry
from demo_sites.common import start_server

TOKEN = "demo-test-token"
DAY = "2030-01-15"
ADMIN = {"x-admin-token": TOKEN}

PAGE_IDS = {
    "bella-bistro": ["area", "date", "party", "find", "slots", "name", "phone", "book", "result"],
    "pawsome-vet": ["vet", "date", "find", "slots", "pet", "name", "phone", "book", "result"],
    "city-library": ["q", "search", "books", "name", "card", "email", "confirm-hold", "result",
                     "contact-name", "contact-email", "contact-message", "send", "contact-result"],
}  # fmt: skip
LABELLED = {"area", "date", "party", "vet", "pet", "name", "phone", "q", "card", "email"}
# One v1 and one v2 read endpoint per site, to check the switch.
PROBES = {
    "bella-bistro": ("api/areas", "api/v2/sections"),
    "pawsome-vet": ("api/vets", "api/v2/clinicians"),
    "city-library": ("api/books?q=emma", "api/v2/catalog/search?query=emma"),
}


@pytest.fixture(autouse=True)
def admin_token(monkeypatch):
    monkeypatch.setenv("DEMO_ADMIN_TOKEN", TOKEN)
    monkeypatch.delenv("CLINIC_ADMIN_TOKEN", raising=False)


def site(site_id: str) -> TestClient:
    return TestClient(create_app(site_id))


def switch(c: TestClient, version: str) -> None:
    assert c.post("/admin/version", json={"version": version}, headers=ADMIN).json() == {
        "version": version
    }


# --- every site --------------------------------------------------------------------------


@pytest.mark.parametrize("site_id", SITES)
def test_page_has_stable_ids_and_ships_matching_client(site_id):
    c = site(site_id)
    v1_path, v2_path = PROBES[site_id]
    for version, ships, hides in (("v1", v1_path, v2_path), ("v2", v2_path, v1_path)):
        switch(c, version)
        r = c.get("/")
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        for element in PAGE_IDS[site_id]:
            assert f'id="{element}"' in r.text, element
            if element in LABELLED:
                assert f'<label for="{element}"' in r.text, element
        assert f"'{ships.split('?')[0]}" in r.text
        assert f"'{hides.split('?')[0]}" not in r.text
    assert c.get("/openapi.json").status_code == 404  # no public API docs


@pytest.mark.parametrize("site_id", SITES)
def test_version_switch_retires_the_other_api(site_id):
    c = site(site_id)
    v1_path, v2_path = PROBES[site_id]
    assert c.get(v1_path).status_code == 200
    assert c.get(v2_path).status_code == 410
    switch(c, "v2")
    assert c.get(v2_path).status_code == 200
    r = c.get(v1_path)
    assert r.status_code == 410 and "retired" in r.json()["error"]
    assert c.get("api/unknown").status_code == 404


@pytest.mark.parametrize("site_id", SITES)
def test_admin_requires_the_token(site_id, monkeypatch):
    c = site(site_id)
    bad = {"x-admin-token": "wrong"}
    assert c.get("/admin/state").status_code == 401
    assert c.get("/admin/state", headers=bad).status_code == 401
    assert c.post("/admin/version", json={"version": "v2"}, headers=bad).status_code == 401
    assert c.post("/admin/reset", headers=bad).status_code == 401
    assert c.get("/admin/state", headers=ADMIN).json()["version"] == "v1"
    assert c.post("/admin/version", json={"version": "v3"}, headers=ADMIN).status_code == 400

    monkeypatch.delenv("DEMO_ADMIN_TOKEN")
    assert c.get("/admin/state", headers={"x-admin-token": ""}).status_code == 401
    monkeypatch.setenv("CLINIC_ADMIN_TOKEN", "clinic-token")  # fallback
    assert c.get("/admin/state", headers={"x-admin-token": "clinic-token"}).status_code == 200


@pytest.mark.parametrize("site_id", SITES)
def test_reset_restores_v1_and_clears_state(site_id):
    c = site(site_id)
    switch(c, "v2")
    v1_path, _ = PROBES[site_id]
    assert c.get(v1_path).status_code == 410
    assert c.post("/admin/reset", headers=ADMIN).json() == {"version": "v1"}
    assert c.get(v1_path).status_code == 200
    state = c.get("/admin/state", headers=ADMIN).json()
    assert state["version"] == "v1"
    assert all(rows == [] for key, rows in state.items() if key != "version")


# --- Bella Bistro ------------------------------------------------------------------------


def test_bistro_v1_flow():
    c = site("bella-bistro")
    areas = c.get("api/areas").json()["areas"]
    assert {a["id"] for a in areas} == {"dining", "patio", "counter"}

    times = c.get("api/times", params={"area": "patio", "date": DAY, "party": 2}).json()["times"]
    slot = times[0]
    assert slot == {"id": f"patio-{DAY}-1200", "time": "12:00"}
    book = {"time_id": slot["id"], "guest_name": "Ada Lovelace", "phone": "555-0100"}
    r = c.post("api/reservations", json={**book, "party_size": 2})
    assert r.status_code == 201
    reservation = r.json()["reservation"]
    assert reservation["id"].startswith("res_")
    assert reservation | {"id": "x"} == {
        "id": "x", "time_id": slot["id"], "area": "Garden Patio", "date": DAY, "time": "12:00",
        "guest_name": "Ada Lovelace", "party_size": 2,
    }  # fmt: skip

    again = c.get("api/times", params={"area": "patio", "date": DAY, "party": 2}).json()["times"]
    assert slot["id"] not in {t["id"] for t in again} and len(again) == len(times) - 1
    assert c.post("api/reservations", json={**book, "party_size": 2}).status_code == 409

    other = times[1]["id"]
    unknown = c.post("api/reservations", json={**book, "time_id": f"cellar-{DAY}-1200"})
    assert unknown.status_code == 404
    missing = c.post("api/reservations", json={"time_id": other, "guest_name": "Ada"})
    assert missing.status_code == 422
    assert missing.json() == {"error": "missing_fields", "fields": ["phone", "party_size"]}
    too_big = c.post("api/reservations", json={**book, "time_id": other, "party_size": 7})
    assert too_big.status_code == 422 and too_big.json()["error"] == "invalid_party_size"
    params = {"area": "patio", "date": DAY, "party": 7}
    assert c.get("api/times", params=params).json() == {"times": []}
    assert c.get("api/times", params={"area": "patio", "date": "soon"}).status_code == 400

    state = c.get("/admin/state", headers=ADMIN).json()
    assert [b["slot_id"] for b in state["bookings"]] == [slot["id"]]


def test_bistro_v2_flow():
    c = site("bella-bistro")
    switch(c, "v2")
    assert c.get("api/times", params={"area": "patio", "date": DAY, "party": 2}).status_code == 410
    assert c.post("api/reservations", json={}).status_code == 410

    sections = c.get("api/v2/sections").json()["sections"]
    assert sections[1] == {
        "sectionId": "patio", "label": "Garden Patio",
        "blurb": "A heated terrace under the olive trees", "maxCovers": 6,
    }  # fmt: skip
    query = {"sectionId": "counter", "day": DAY, "covers": 3}
    openings = c.get("api/v2/availability", params=query).json()["data"]["openings"]
    first = openings[0]
    assert first["slotId"] == f"counter-{DAY}-1200" and first["startsAt"] == f"{DAY}T12:00:00"

    guest = {"fullName": "Grace Hopper", "phoneNumber": "555-0199"}
    body = {"slotId": first["slotId"], "guest": guest, "covers": 3}
    r = c.post("api/v2/bookings", json=body)
    assert r.status_code == 201
    booking = r.json()["booking"]
    assert booking["bookingId"].startswith("res_")
    assert booking["section"] == "Chef's Counter" and booking["covers"] == 3
    assert booking["guest"] == {"fullName": "Grace Hopper"}
    after = c.get("api/v2/availability", params=query).json()["data"]["openings"]
    assert first["slotId"] not in {o["slotId"] for o in after}
    assert c.post("api/v2/bookings", json=body).status_code == 409
    missing = c.post("api/v2/bookings", json={"slotId": openings[1]["slotId"], "covers": 2})
    assert missing.status_code == 422
    assert missing.json()["fields"] == ["guest.fullName", "guest.phoneNumber"]


# --- Pawsome Vet -------------------------------------------------------------------------


def test_vet_v1_flow():
    c = site("pawsome-vet")
    vets = c.get("api/vets").json()["vets"]
    assert [v["id"] for v in vets] == ["patel", "nguyen", "brooks"]

    slots = c.get("api/slots", params={"vet": "nguyen", "date": DAY}).json()["slots"]
    slot = slots[0]
    assert slot == {"id": f"nguyen-{DAY}-0830", "time": "08:30"}
    body = {"slot_id": slot["id"], "pet_name": "Biscuit", "owner_name": "Sam Rivera",
            "phone": "555-0142"}  # fmt: skip
    r = c.post("api/appointments", json=body)
    assert r.status_code == 201
    appointment = r.json()["appointment"]
    assert appointment["id"].startswith("vis_")
    assert appointment["vet"] == "Dr. Sam Nguyen" and appointment["pet_name"] == "Biscuit"
    assert (appointment["date"], appointment["time"]) == (DAY, "08:30")

    again = c.get("api/slots", params={"vet": "nguyen", "date": DAY}).json()["slots"]
    assert slot["id"] not in {s["id"] for s in again}
    assert c.post("api/appointments", json=body).status_code == 409
    assert (
        c.post("api/appointments", json={**body, "slot_id": "nobody-2030-01-15-0830"}).status_code
        == 404
    )
    assert (
        c.post("api/appointments", json={**body, "slot_id": f"patel-{DAY}-0315"}).status_code == 404
    )
    missing = c.post("api/appointments", json={"slot_id": slots[1]["id"], "phone": "1"})
    assert missing.status_code == 422
    assert missing.json()["fields"] == ["pet_name", "owner_name"]
    assert c.get("api/slots", params={"vet": "patel"}).status_code == 400


def test_vet_v2_flow():
    c = site("pawsome-vet")
    switch(c, "v2")
    assert c.get("api/vets").status_code == 410
    assert c.post("api/appointments", json={}).status_code == 410

    clinicians = c.get("api/v2/clinicians").json()["clinicians"]
    assert clinicians[0] == {"clinicianId": "patel", "displayName": "Dr. Priya Patel",
                             "focus": "Dogs & cats"}  # fmt: skip
    query = {"clinicianId": "patel", "on": DAY}
    openings = c.get("api/v2/openings", params=query).json()["data"]["openings"]
    first = openings[0]
    assert first["startsAt"] == f"{DAY}T08:30:00"

    body = {"slotId": first["slotId"], "pet": {"name": "Mochi"},
            "owner": {"fullName": "Kim Lee", "phoneNumber": "555-0177"}}  # fmt: skip
    r = c.post("api/v2/visits", json=body)
    assert r.status_code == 201
    visit = r.json()["visit"]
    assert visit["visitId"].startswith("vis_") and visit["clinician"] == "Dr. Priya Patel"
    assert visit["pet"] == {"name": "Mochi"} and visit["startsAt"] == f"{DAY}T08:30:00"
    after = c.get("api/v2/openings", params=query).json()["data"]["openings"]
    assert first["slotId"] not in {o["slotId"] for o in after}
    assert c.post("api/v2/visits", json=body).status_code == 409
    missing = c.post("api/v2/visits", json={"slotId": openings[1]["slotId"], "pet": {"name": "X"}})
    assert missing.status_code == 422
    assert missing.json()["fields"] == ["owner.fullName", "owner.phoneNumber"]


# --- City Library ------------------------------------------------------------------------


def test_library_v1_flow():
    c = site("city-library")
    assert len(c.get("api/books").json()["books"]) == 12  # empty query lists everything
    austen = c.get("api/books", params={"q": "austen"}).json()["books"]
    assert [b["title"] for b in austen] == ["Pride and Prejudice", "Emma"]
    assert c.get("api/books", params={"q": "bronte"}).json()["books"][0]["title"] == "Jane Eyre"

    middlemarch = c.get("api/books", params={"q": "middlemarch"}).json()["books"][0]
    assert (middlemarch["available"], middlemarch["copies"]) == (1, 1)
    patron = {"name": "Ada Lovelace", "card_number": "2900123", "email": "ada@example.com"}
    r = c.post("api/holds", json={"book_id": middlemarch["id"], **patron})
    assert r.status_code == 201
    hold = r.json()["hold"]
    assert hold["id"].startswith("hold_") and hold["title"] == "Middlemarch" and hold["pickup_by"]

    after = c.get("api/books", params={"q": "eliot"}).json()["books"][0]
    assert after["available"] == 0
    assert c.post("api/holds", json={"book_id": middlemarch["id"], **patron}).status_code == 409
    assert c.post("api/holds", json={"book_id": "b999", **patron}).status_code == 404
    missing = c.post("api/holds", json={"book_id": "b112", "name": "Ada"})
    assert missing.status_code == 422 and missing.json()["fields"] == ["card_number", "email"]
    bad_email = c.post("api/holds", json={"book_id": "b112", **patron, "email": "nope"})
    assert bad_email.status_code == 422 and bad_email.json()["error"] == "invalid_email"
    # Titles with copies left are listed first.
    assert c.get("api/books").json()["books"][-1]["title"] == "Middlemarch"

    message = {"name": "Ada", "email": "ada@example.com", "message": "Lost my card"}
    r = c.post("api/messages", json=message)
    assert r.status_code == 201 and r.json()["message"]["id"].startswith("msg_")
    assert c.post("api/messages", json={**message, "message": " "}).status_code == 422

    state = c.get("/admin/state", headers=ADMIN).json()
    assert len(state["holds"]) == 1 and len(state["messages"]) == 1


def test_library_v2_flow():
    c = site("city-library")
    switch(c, "v2")
    assert c.get("api/books", params={"q": "emma"}).status_code == 410
    assert c.post("api/holds", json={}).status_code == 410
    assert c.post("api/messages", json={}).status_code == 410

    results = c.get("api/v2/catalog/search", params={"query": "dracula"}).json()["data"]["results"]
    assert results == [{"itemId": "b108", "title": "Dracula", "creator": "Bram Stoker",
                        "published": 1897, "copiesAvailable": 2, "copiesTotal": 2}]  # fmt: skip
    patron = {
        "fullName": "Mina Harker",
        "cardNumber": "2900456",
        "emailAddress": "mina@example.com",
    }
    r = c.post("api/v2/reservations", json={"itemId": "b108", "patron": patron})
    assert r.status_code == 201
    reservation = r.json()["reservation"]
    assert reservation["reservationId"].startswith("hold_") and reservation["readyBy"]
    again = c.get("api/v2/catalog/search", params={"query": "dracula"}).json()["data"]["results"]
    assert again[0]["copiesAvailable"] == 1
    missing = c.post("api/v2/reservations", json={"itemId": "b108", "patron": {"fullName": "M"}})
    assert missing.status_code == 422
    assert missing.json()["fields"] == ["patron.cardNumber", "patron.emailAddress"]

    sender = {"fullName": "Mina Harker", "emailAddress": "mina@example.com"}
    r = c.post("api/v2/inquiries", json={"sender": sender, "body": "Opening hours on Sunday?"})
    assert r.status_code == 201 and r.json()["inquiry"]["inquiryId"].startswith("msg_")
    assert c.post("api/v2/inquiries", json={"sender": sender}).json()["fields"] == ["body"]


# --- registry ----------------------------------------------------------------------------


def test_registry_and_seed(monkeypatch):
    assert [s["id"] for s in registry.DEMO_SITES] == [
        "sunrise-clinic", "bella-bistro", "pawsome-vet", "city-library",
    ]  # fmt: skip
    assert registry.DEMO_SITES[0]["base_url"] == "http://localhost:4100/"
    assert all(s["is_demo"] and s["goal"] for s in registry.DEMO_SITES)
    monkeypatch.setenv("BISTRO_URL", "https://bistro.example.dev/demo")

    class FakeStore:
        def __init__(self):
            self.sites = {}

        async def upsert_site(self, row):
            self.sites[row["id"]] = row
            return row

    store = FakeStore()
    rows = asyncio.run(registry.seed(store))
    assert len(rows) == 4 and store.sites["bella-bistro"]["name"] == "Bella Bistro"
    assert store.sites["bella-bistro"]["base_url"] == "https://bistro.example.dev/demo/"


# --- a real browser clicking through each page -------------------------------------------


def bistro_flow(page, expect):
    page.select_option("#area", "patio")
    page.fill("#party", "4")
    page.click("#find")
    page.locator("#slots button").first.click()
    page.fill("#name", "Ada Lovelace")
    page.fill("#phone", "555-0100")
    page.click("#book")
    expect(page.locator("#result")).to_contain_text("Booked! Table for 4, Garden Patio")
    expect(page.locator("#result")).to_contain_text("Reference res_")


def vet_flow(page, expect):
    page.select_option("#vet", "brooks")
    page.click("#find")
    page.locator("#slots button").first.click()
    page.fill("#pet", "Biscuit")
    page.fill("#name", "Sam Rivera")
    page.fill("#phone", "555-0142")
    page.click("#book")
    expect(page.locator("#result")).to_contain_text("Booked! Biscuit with Dr. Hannah Brooks")
    expect(page.locator("#result")).to_contain_text("Reference vis_")


def library_flow(page, expect):
    page.fill("#q", "austen")
    page.click("#search")
    expect(page.locator("#results-msg")).to_have_text("2 titles found")
    page.locator("#books button:not([disabled])").first.click()
    page.fill("#name", "Ada Lovelace")
    page.fill("#card", "2900123")
    page.fill("#email", "ada@example.com")
    page.click("#confirm-hold")
    expect(page.locator("#result")).to_contain_text('Hold placed! "Pride and Prejudice"')
    expect(page.locator("#result")).to_contain_text("Reference hold_")
    page.fill("#contact-name", "Ada Lovelace")
    page.fill("#contact-email", "ada@example.com")
    page.fill("#contact-message", "Do you host coding clubs?")
    page.click("#send")
    expect(page.locator("#contact-result")).to_contain_text("Message sent!")


FLOWS = {"bella-bistro": bistro_flow, "pawsome-vet": vet_flow, "city-library": library_flow}


@pytest.fixture(scope="module")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as playwright:
        try:
            chromium = playwright.chromium.launch()
        except Exception as e:  # browser binary missing
            pytest.skip(f"chromium unavailable: {e}")
        yield chromium
        chromium.close()


@pytest.mark.parametrize("site_id", SITES)
def test_browser_completes_the_human_flow(site_id, browser):
    from playwright.sync_api import expect

    server = start_server(create_app(site_id))
    page = browser.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        # Humans never notice the switch: the same clicks work on v1 and v2.
        for version in ("v1", "v2"):
            r = httpx.post(f"{server.url}admin/version", json={"version": version}, headers=ADMIN)
            assert r.status_code == 200
            page.goto(server.url)
            FLOWS[site_id](page, expect)
    finally:
        page.close()
        server.stop()
    assert errors == []

"""Interactive sign-in: a sandbox pauses on a login wall and a person takes over its browser."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.doorway import browser, explorer, sessions
from app.doorway.sandbox import liveview


def test_cookie_header_matches_domain_path_and_scheme():
    state = {
        "cookies": [
            {"name": "sid", "value": "1", "domain": ".luma.test", "path": "/", "secure": True},
            {"name": "other", "value": "2", "domain": "evil.test", "path": "/"},
            {"name": "api", "value": "3", "domain": "app.luma.test", "path": "/api"},
            {"name": "old", "value": "4", "domain": "luma.test", "path": "/", "expires": 1},
        ]
    }
    assert sessions.cookie_header(state, "https://app.luma.test/api/events") == "sid=1; api=3"
    assert sessions.cookie_header(state, "http://luma.test/") is None  # secure cookie, http
    assert sessions.cookie_header(None, "https://luma.test/") is None


def test_a_person_signs_in_through_the_takeover_endpoints(monkeypatch):
    saved: dict = {}

    async def fake_save(user_id, site_id, state):
        saved.update(user=user_id, site=site_id, cookies=[c["name"] for c in state["cookies"]])

    async def fake_user(request):
        return "user-1" if request.headers.get("authorization") == "Bearer good" else None

    monkeypatch.setattr(sessions, "save", fake_save)
    monkeypatch.setattr(liveview, "_user_id", fake_user)

    async def main():
        context = await browser.new_context()
        page = await context.new_page()
        await page.set_content(
            '<input id="u" style="position:absolute;left:0;top:0;width:300px;height:40px">'
        )
        liveview.JOBS["sandbox-1"] = {"kind": "discover", "job_id": 5, "site_id": "luma"}
        token = liveview.current_sandbox.set("sandbox-1")
        waiting = asyncio.create_task(liveview.wait_for_human(page, "a login form"))
        liveview.current_sandbox.reset(token)
        await asyncio.sleep(0.05)
        transport = httpx.ASGITransport(app=liveview.app(["sandbox-1"]))
        async with httpx.AsyncClient(transport=transport, base_url="http://sandbox") as client:
            row = (await client.get("/state")).json()["sandboxes"][0]
            assert row["needs_human"]["reason"] == "a login form"
            assert (
                row["needs_human"]["claimed"] is False and row["needs_human"]["site_id"] == "luma"
            )

            assert (await client.post("/takeover/sandbox-1/claim")).status_code == 401
            claim = await client.post(
                "/takeover/sandbox-1/claim", headers={"authorization": "Bearer good"}
            )
            control = {"x-takeover-token": claim.json()["control_token"]}
            assert claim.json()["viewport"]["width"] > 0

            # Without the control token: no input, no stream, no public frame of the sign-in.
            text = {"type": "type", "text": "secret"}
            assert (await client.post("/input/sandbox-1", json=text)).status_code == 403
            assert (await client.get("/stream/sandbox-1")).status_code == 403
            assert (await client.get("/frame/sandbox-1")).status_code == 403

            click = {"type": "click", "x": 10, "y": 10}
            assert (
                await client.post("/input/sandbox-1", json=click, headers=control)
            ).status_code == 204
            assert (
                await client.post("/input/sandbox-1", json=text, headers=control)
            ).status_code == 204
            bad = {"type": "key", "key": "F5"}
            assert (
                await client.post("/input/sandbox-1", json=bad, headers=control)
            ).status_code == 400
            assert await page.input_value("#u") == "secret"

            await context.add_cookies([{"name": "sid", "value": "s1", "url": "https://luma.test/"}])
            done = await client.post("/takeover/sandbox-1/done", headers=control)
            assert done.status_code == 204
            await asyncio.wait_for(waiting, 5)
            assert saved == {"user": "user-1", "site": "luma", "cookies": ["sid"]}
            assert (await client.get("/state")).json()["sandboxes"][0]["needs_human"] is None

            # Cancelling fails the job with a clear reason.
            token = liveview.current_sandbox.set("sandbox-1")
            waiting = asyncio.create_task(liveview.wait_for_human(page, "a 2FA prompt"))
            liveview.current_sandbox.reset(token)
            await asyncio.sleep(0.05)
            claim = await client.post(
                "/takeover/sandbox-1/claim", headers={"authorization": "Bearer good"}
            )
            control = {"x-takeover-token": claim.json()["control_token"]}
            await client.post("/takeover/sandbox-1/cancel", headers=control)
            with pytest.raises(explorer.NeedHuman, match="sign-in cancelled"):
                await asyncio.wait_for(waiting, 5)
        await context.close()
        await browser.close_browser()
        liveview.JOBS.clear()

    asyncio.run(main())

"""Demo controls for the demo sites (doorway_sites.is_demo).

Each demo site has a private JSON API with two versions. "Break" switches it (v1 ⇄ v2), so
the published tools stop matching and the broker has to heal them; "reset" restores v1 and
clears bookings. Both call the site's /admin endpoints with x-admin-token.
"""

from __future__ import annotations

import httpx
from fastapi import HTTPException

from ..billing.config import NotConfigured, get_settings

# Tests swap in an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None


async def _admin(site: dict, method: str, path: str, body: dict | None = None) -> dict:
    if not site.get("is_demo"):
        raise HTTPException(409, {"error": "not_a_demo_site"})
    token = get_settings().demo_admin_token
    if not token:
        raise NotConfigured("DEMO_ADMIN_TOKEN")
    base = site["base_url"] if site["base_url"].endswith("/") else f"{site['base_url']}/"
    try:
        async with httpx.AsyncClient(transport=transport, timeout=10.0) as client:
            response = await client.request(
                method, f"{base}admin/{path}", json=body, headers={"x-admin-token": token}
            )
    except httpx.HTTPError as error:
        raise HTTPException(502, {"error": "demo_site_unreachable"}) from error
    if response.status_code != 200:
        raise HTTPException(502, {"error": "demo_site_error", "status": response.status_code})
    return response.json()


async def current_version(site: dict) -> str | None:
    try:
        return (await _admin(site, "GET", "state")).get("version")
    except HTTPException as error:
        if error.status_code == 502:  # no /admin/state on this site: assume v1
            return None
        raise


async def break_site(site: dict) -> str:
    """Switch the private API to the other version; returns the new version."""
    version = "v1" if await current_version(site) == "v2" else "v2"
    return (await _admin(site, "POST", "version", {"version": version})).get("version", version)


async def reset_site(site: dict) -> dict:
    return await _admin(site, "POST", "reset")

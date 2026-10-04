"""Saved sign-ins: the browser session a person created by signing in to a site inside a
sandbox (interactive takeover). Passwords are typed into the site itself and never reach
Doorway; only the resulting session (Playwright storage_state: cookies + local storage) is kept.

Stored encrypted (Fernet, key derived from the Supabase secret key) in the private Storage
bucket `doorway-sessions`: `<user_id>/<site_id>` per person, plus `_latest/<site_id>` for the
site's sandbox jobs and the owner's MCP calls. Never written into a tool spec: runs pick the
session up through CURRENT (the api strategy sends its cookies, new browser contexts start
from it).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import time
from contextvars import ContextVar
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet, InvalidToken

from ..billing.config import get_settings

log = logging.getLogger(__name__)

BUCKET = "doorway-sessions"
LATEST = "_latest"
CURRENT: ContextVar[dict | None] = ContextVar("doorway_session", default=None)


def _fernet() -> Fernet:
    secret = get_settings().supabase_secret_key
    if not secret:
        raise RuntimeError("SUPABASE_SECRET_KEY is needed to encrypt saved sign-ins")
    digest = hashlib.sha256(b"doorway-sessions:" + secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _storage() -> tuple[str, dict[str, str]]:
    settings = get_settings()
    key = settings.supabase_secret_key or ""
    if not settings.supabase_url or not key:
        raise RuntimeError("Supabase is not configured")
    headers = {"apikey": key}
    if key.startswith("eyJ"):
        headers["authorization"] = f"Bearer {key}"
    return f"{settings.supabase_url.rstrip('/')}/storage/v1", headers


async def _ensure_bucket(client: httpx.AsyncClient, base: str, headers: dict) -> None:
    body = {"id": BUCKET, "name": BUCKET, "public": False}
    response = await client.post(f"{base}/bucket", headers=headers, json=body)
    if response.status_code >= 400 and "exist" not in response.text.lower():
        response.raise_for_status()


async def _put(client, base, headers, path: str, blob: bytes) -> httpx.Response:
    return await client.post(
        f"{base}/object/{BUCKET}/{path}",
        headers={**headers, "content-type": "application/octet-stream", "x-upsert": "true"},
        content=blob,
    )


async def save(user_id: str, site_id: str, state: dict) -> None:
    """Store `state` for (user, site) and as the site's latest session."""
    base, headers = _storage()
    blob = _fernet().encrypt(
        json.dumps({"user_id": user_id, "saved_at": time.time(), "state": state}).encode()
    )
    async with httpx.AsyncClient(timeout=20) as client:
        response = await _put(client, base, headers, f"{user_id}/{site_id}", blob)
        if response.status_code == 404 or "bucket" in response.text.lower():
            await _ensure_bucket(client, base, headers)
            response = await _put(client, base, headers, f"{user_id}/{site_id}", blob)
        response.raise_for_status()
        (await _put(client, base, headers, f"{LATEST}/{site_id}", blob)).raise_for_status()


async def _read(path: str) -> dict | None:
    base, headers = _storage()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(f"{base}/object/{BUCKET}/{path}", headers=headers)
    if response.status_code != 200:
        return None
    try:
        return json.loads(_fernet().decrypt(response.content))
    except (InvalidToken, ValueError):
        log.warning("unreadable saved session at %s", path.split("/")[-1])
        return None


async def load(site_id: str, user_id: str | None = None) -> dict | None:
    """That user's session for the site, or (no user) the site's latest. None if none."""
    try:
        saved = await _read(f"{user_id or LATEST}/{site_id}")
    except RuntimeError:  # Supabase not configured (tests, local without a project)
        return None
    except Exception:  # noqa: BLE001  (a missing session must never break a run)
        log.exception("loading a saved session failed")
        return None
    return (saved or {}).get("state")


async def list_for(user_id: str) -> list[dict]:
    base, headers = _storage()
    body = {"prefix": f"{user_id}/", "limit": 200, "sortBy": {"column": "name", "order": "asc"}}
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(f"{base}/object/list/{BUCKET}", headers=headers, json=body)
    if response.status_code != 200:
        return []
    return [
        {"site_id": item["name"], "saved_at": item.get("updated_at") or item.get("created_at")}
        for item in response.json()
        if item.get("id")  # folders have no id
    ]


async def delete(user_id: str, site_id: str) -> None:
    base, headers = _storage()
    paths = [f"{user_id}/{site_id}"]
    latest = await _read(f"{LATEST}/{site_id}")
    if latest and latest.get("user_id") == user_id:
        paths.append(f"{LATEST}/{site_id}")
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.request(
            "DELETE", f"{base}/object/{BUCKET}", headers=headers, json={"prefixes": paths}
        )
    response.raise_for_status()


def cookie_header(state: dict | None, url: str) -> str | None:
    """The Cookie header a browser would send to `url` from a saved storage_state."""
    if not state:
        return None
    parts = urlsplit(url)
    host, path = (parts.hostname or "").lower(), parts.path or "/"
    now = time.time()
    pairs = []
    for cookie in state.get("cookies") or []:
        domain = str(cookie.get("domain") or "").lower().lstrip(".")
        if not domain or not (host == domain or host.endswith("." + domain)):
            continue
        if not path.startswith(cookie.get("path") or "/"):
            continue
        if cookie.get("secure") and parts.scheme != "https":
            continue
        expires = cookie.get("expires")
        if isinstance(expires, int | float) and 0 < expires < now:
            continue
        pairs.append(f"{cookie['name']}={cookie['value']}")
    return "; ".join(pairs) or None

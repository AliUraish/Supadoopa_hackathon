"""Who is calling: the frontend sends the Supabase session's access token as a Bearer token."""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import NotConfigured, get_settings

_bearer = HTTPBearer(auto_error=False, description="Supabase access token")


@dataclass(frozen=True)
class User:
    id: str
    email: str | None = None


async def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> User:
    if credentials is None:
        raise HTTPException(401, "Missing bearer token", headers={"WWW-Authenticate": "Bearer"})

    settings = get_settings()
    key = settings.supabase_publishable_key or settings.supabase_secret_key
    if not settings.supabase_url or not key:
        raise NotConfigured("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY")

    # Ask Supabase Auth rather than verifying the JWT locally: works with both
    # legacy (HS256) and asymmetric signing keys, and rejects signed-out sessions.
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.supabase_url.rstrip('/')}/auth/v1/user",
                headers={"apikey": key, "Authorization": f"Bearer {credentials.credentials}"},
            )
    except httpx.HTTPError as error:
        raise HTTPException(502, "Supabase Auth is unreachable") from error

    if response.status_code in (401, 403):
        raise HTTPException(401, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    if response.status_code != 200:
        raise HTTPException(502, f"Supabase Auth returned {response.status_code}")

    data = response.json()
    return User(id=data["id"], email=data.get("email"))

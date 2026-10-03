"""Link Agent Wallet: this app's agent pays on a user's behalf, with their approval.

1. POST /agent-wallet/connect: the user approves our agent at Link (OAuth + PKCE).
2. GET /agent-wallet/callback: Link redirects here; we store the grant.
3. POST /agent-wallet/spend-requests: ask the user to approve one purchase (they get a
   Link prompt; poll GET /agent-wallet/spend-requests/{id}).
4. Once approved, the agent calls get_payment_credential() server-side and pays.

Needs LINK_CLIENT_ID / LINK_CLIENT_SECRET (Stripe issues them through the Link Agent
Wallet application form) and STRIPE_PUBLISHABLE_KEY. US/Canada consumers only.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from .auth import User, current_user
from .config import NotConfigured, Settings, get_settings
from .store import BillingStore, get_store

LINK_LOGIN = "https://login.link.com"
LINK_API = "https://api.link.com"
SCOPES = "payment_methods.agentic userinfo:read"

router = APIRouter(prefix="/agent-wallet", tags=["agent-wallet"])


def _config() -> Settings:
    settings = get_settings()
    missing = [
        name
        for name, value in (
            ("LINK_CLIENT_ID", settings.link_client_id),
            ("LINK_CLIENT_SECRET", settings.link_client_secret),
            ("STRIPE_PUBLISHABLE_KEY", settings.stripe_publishable_key),
        )
        if not value
    ]
    if missing:
        raise NotConfigured(*missing)
    return settings


def _redirect_uri(settings: Settings) -> str:
    return f"{settings.public_api_url}/agent-wallet/callback"


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


async def _token_request(settings: Settings, data: dict[str, str]) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"{LINK_LOGIN}/auth/token",
            headers={"Authorization": f"Bearer {settings.stripe_publishable_key}"},
            data={
                **data,
                "client_id": settings.link_client_id,
                "client_secret": settings.link_client_secret,
            },
        )
    if response.status_code != 200:
        raise HTTPException(502, {"error": "link_oauth_failed", "status": response.status_code})
    return response.json()


def _wallet_row(user_id: str, tokens: dict) -> dict:
    expires_at = datetime.now(UTC) + timedelta(seconds=int(tokens.get("expires_in", 3600)))
    return {
        "user_id": user_id,
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_at": expires_at.isoformat(),
        "scope": tokens.get("scope"),
        "updated_at": datetime.now(UTC).isoformat(),
    }


async def _access_token(user_id: str, store: BillingStore) -> str:
    settings = _config()
    wallet = await store.get_link_wallet(user_id)
    if wallet is None:
        raise HTTPException(404, {"error": "wallet_not_connected", "fix": "/agent-wallet/connect"})
    expires_at = datetime.fromisoformat(str(wallet["expires_at"]))
    if expires_at - timedelta(seconds=60) > datetime.now(UTC):
        return wallet["access_token"]
    tokens = await _token_request(
        settings, {"grant_type": "refresh_token", "refresh_token": wallet["refresh_token"]}
    )
    await store.save_link_wallet(_wallet_row(user_id, tokens))  # refresh tokens rotate
    return tokens["access_token"]


async def _link_api(
    method: str, path: str, token: str, *, json: dict | None = None, params=None
) -> dict:
    async with httpx.AsyncClient(base_url=LINK_API, timeout=30.0) as client:
        response = await client.request(
            method, path, json=json, params=params, headers={"Authorization": f"Bearer {token}"}
        )
    if response.status_code == 404:
        raise HTTPException(404, {"error": "not_found"})
    if response.status_code >= 400:
        raise HTTPException(502, {"error": "link_api_error", "status": response.status_code})
    return response.json()


@router.post("/connect")
async def connect(
    user: User = Depends(current_user), store: BillingStore = Depends(get_store)
) -> dict:
    """Returns the Link URL where the user approves our agent; redirect the browser there."""
    settings = _config()
    state = secrets.token_urlsafe(32)
    verifier, challenge = _pkce()
    await store.save_link_oauth_state(state, user.id, verifier)
    query = urlencode(
        {
            "key": settings.stripe_publishable_key,
            "client_id": settings.link_client_id,
            "redirect_uri": _redirect_uri(settings),
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return {"url": f"{LINK_LOGIN}/auth?{query}"}


@router.get("/callback", include_in_schema=False)
async def callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    store: BillingStore = Depends(get_store),
) -> RedirectResponse:
    settings = _config()
    back = f"{settings.public_app_url}/dashboard"
    pending = await store.pop_link_oauth_state(state) if state else None
    if error or not code or pending is None:
        return RedirectResponse(f"{back}?wallet=error", status_code=303)
    tokens = await _token_request(
        settings,
        {
            "grant_type": "authorization_code",
            "redirect_uri": _redirect_uri(settings),
            "code": code,
            "code_verifier": pending["code_verifier"],
        },
    )
    await store.save_link_wallet(_wallet_row(pending["user_id"], tokens))
    return RedirectResponse(f"{back}?wallet=connected", status_code=303)


@router.get("")
async def wallet_status(
    user: User = Depends(current_user), store: BillingStore = Depends(get_store)
) -> dict:
    wallet = await store.get_link_wallet(user.id)
    if wallet is None:
        return {"connected": False}
    return {"connected": True, "scope": wallet.get("scope")}


@router.delete("")
async def disconnect(
    user: User = Depends(current_user), store: BillingStore = Depends(get_store)
) -> dict:
    settings = _config()
    wallet = await store.get_link_wallet(user.id)
    if wallet:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{LINK_LOGIN}/auth/revoke",
                headers={"Authorization": f"Bearer {settings.stripe_publishable_key}"},
                data={
                    "client_id": settings.link_client_id,
                    "client_secret": settings.link_client_secret,
                    "token": wallet["refresh_token"],
                    "token_type_hint": "refresh_token",
                },
            )
        await store.delete_link_wallet(user.id)
    return {"connected": False}


class SpendRequestIn(BaseModel):
    amount: int = Field(..., gt=0, description="in cents")
    currency: str = "usd"
    merchant_name: str
    merchant_url: str = Field(pattern=r"^https?://")
    # Shown to the user when they approve: what is being bought and why.
    context: str = Field(min_length=100)
    test: bool | None = Field(None, description="defaults to test unless Stripe is live")


def _public(spend_request: dict) -> dict:
    # Never pass card numbers or tokens to clients; only the agent uses those, server-side.
    keys = ("id", "status", "amount", "currency", "merchant_name", "approval_url", "created_at")
    return {key: spend_request.get(key) for key in keys}


@router.post("/spend-requests")
async def create_spend_request(
    body: SpendRequestIn,
    user: User = Depends(current_user),
    store: BillingStore = Depends(get_store),
) -> dict:
    token = await _access_token(user.id, store)
    test = body.test if body.test is not None else not get_settings().stripe_live
    spend_request = await _link_api(
        "POST",
        "/spend_requests",
        token,
        json={
            "amount": body.amount,
            "currency": body.currency,
            "merchant_name": body.merchant_name,
            "merchant_url": body.merchant_url,
            "context": body.context,
            "credential_type": "card",
            "request_approval": True,
            "test": test,
        },
    )
    return _public(spend_request)


@router.get("/spend-requests/{spend_request_id}")
async def get_spend_request(
    spend_request_id: str,
    user: User = Depends(current_user),
    store: BillingStore = Depends(get_store),
) -> dict:
    token = await _access_token(user.id, store)
    return _public(
        await _link_api("GET", f"/spend_requests/{quote(spend_request_id, safe='')}", token)
    )


async def get_payment_credential(user_id: str, spend_request_id: str, store: BillingStore) -> dict:
    """Server-side only: the approved one-time card for the agent's checkout.

    Never return it to a client, log it, or put it in a model prompt.
    """
    token = await _access_token(user_id, store)
    spend_request = await _link_api(
        "GET",
        f"/spend_requests/{quote(spend_request_id, safe='')}",
        token,
        params={"include": "card"},
    )
    if spend_request.get("status") != "approved":
        raise ValueError(f"spend request is {spend_request.get('status')}, not approved")
    return spend_request["card"]

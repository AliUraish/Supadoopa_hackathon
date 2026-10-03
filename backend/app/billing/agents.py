"""Selling to AI agents.

- POST /agents/checkout: an agent buys a catalog item with a Shared Payment Token
  (SPT) its user granted it (Link Agent Wallet, ACP/UCP agents, link-cli, …).
- POST /agents/test-token: sandbox only, mints a test SPT so the flow can be tried.
- GET /llms.txt: what agents can buy here and how; also needed for a Stripe Directory listing.
Pay-per-call endpoints use MPP instead (see mpp.py).
"""

from __future__ import annotations

import time

import httpx
import stripe
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from . import catalog
from .config import NotConfigured, get_settings
from .mpp import PAID_DEPENDENCIES
from .routes import _one_time_price
from .stripe_client import get_stripe

router = APIRouter(tags=["agents"])

SPT_API_VERSION = "2026-09-30.preview"


class AgentCheckoutIn(BaseModel):
    lookup_key: str
    shared_payment_token: str = Field(pattern=r"^spt_")
    quantity: int = Field(1, ge=1, le=100)
    email: str | None = None  # where Stripe sends the receipt


@router.post("/agents/checkout")
async def agent_checkout(body: AgentCheckoutIn) -> dict:
    """Charge a one-time catalog price to the agent's SPT. Retrying with the same SPT is safe."""
    price = _one_time_price(body.lookup_key)
    params: dict = {
        "amount": price.unit_amount * body.quantity,
        "currency": price.currency,
        "confirm": True,
        "shared_payment_granted_token": body.shared_payment_token,
        "metadata": {"purchase_source": "agent", "lookup_key": body.lookup_key},
    }
    if body.email:
        params["receipt_email"] = body.email
    try:
        intent = await get_stripe().v1.payment_intents.create_async(
            params, {"idempotency_key": f"agent-checkout-{body.shared_payment_token}"}
        )
    except stripe.StripeError as error:
        raise HTTPException(
            402, {"error": "payment_failed", "message": error.user_message or str(error)}
        ) from error
    if intent.status != "succeeded":
        raise HTTPException(402, {"error": "payment_incomplete", "status": intent.status})
    return {
        "status": "paid",
        "payment_intent": intent.id,
        "lookup_key": body.lookup_key,
        "amount": intent.amount,
        "currency": intent.currency,
    }


class TestTokenIn(BaseModel):
    amount: int = Field(..., gt=0, description="max amount the token may charge, in cents")
    currency: str = "usd"


@router.post("/agents/test-token")
async def mint_test_token(body: TestTokenIn) -> dict:
    """Sandbox only: an SPT backed by a test Visa, as if an agent's user had granted it."""
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise NotConfigured("STRIPE_SECRET_KEY")
    if settings.stripe_live:
        raise HTTPException(403, {"error": "sandbox_only"})
    expires_at = int(time.time()) + 3600
    async with httpx.AsyncClient(
        base_url=settings.stripe_api_base or "https://api.stripe.com",
        auth=(settings.stripe_secret_key, ""),
        timeout=30.0,
    ) as client:
        response = await client.post(
            "/v1/test_helpers/shared_payment/granted_tokens",
            headers={"Stripe-Version": SPT_API_VERSION},
            data={
                "payment_method": "pm_card_visa",
                "usage_limits[currency]": body.currency,
                "usage_limits[max_amount]": str(body.amount),
                "usage_limits[expires_at]": str(expires_at),
            },
        )
    if response.status_code != 200:
        raise HTTPException(502, {"error": "stripe_error", "status": response.status_code})
    return {
        "shared_payment_token": response.json()["id"],
        "max_amount": body.amount,
        "currency": body.currency,
        "expires_at": expires_at,
    }


def _money(cents: int, currency: str) -> str:
    return f"{cents / 100:.2f} {currency.upper()}"


@router.get("/llms.txt", response_class=PlainTextResponse, include_in_schema=False)
async def llms_txt(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    lines = [
        f"# {request.app.title}",
        "",
        "> Agents can buy items with a Stripe Shared Payment Token, or pay per call (MPP).",
        "",
        "## Buy an item",
        f"POST {base}/agents/checkout with JSON "
        '{"lookup_key": "...", "shared_payment_token": "spt_..."}',
        "",
    ]
    for product in catalog.PRODUCTS:
        for price in product.prices:
            if not price.recurring:
                lines.append(
                    f"- {price.lookup_key}: {product.name}, "
                    f"{_money(price.unit_amount, price.currency)}"
                    + (f" ({product.description})" if product.description else "")
                )

    paid = []
    for route in request.app.routes:
        if not isinstance(route, APIRoute):
            continue
        for dependency in route.dependant.dependencies:
            offer = PAID_DEPENDENCIES.get(dependency.call)
            if offer:
                methods = ",".join(sorted(route.methods))
                note = f" ({offer['description']})" if offer["description"] else ""
                paid.append(f"- {methods} {base}{route.path}: {offer['amount']} USD per call{note}")
    if paid:
        lines += [
            "",
            "## Pay per call (MPP, HTTP 402 then `Authorization: Payment …`)",
            *paid,
        ]
    lines += ["", "## Subscriptions", "Humans subscribe at the website; agents can't."]
    return "\n".join(lines) + "\n"

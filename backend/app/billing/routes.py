"""Billing endpoints the frontend calls (all but /catalog need a Supabase bearer token)."""

from __future__ import annotations

import time
from typing import Annotated

import stripe
from fastapi import APIRouter, Depends, HTTPException
from pydantic import AfterValidator, BaseModel, Field

from . import catalog
from .auth import User, current_user
from .config import get_settings
from .entitlements import ACTIVE_STATUSES, Entitlements, get_entitlements
from .invoices import InvoiceLine, send_invoice
from .store import BillingStore, get_store
from .stripe_client import get_stripe

router = APIRouter(prefix="/billing", tags=["billing"])

PORTAL_CONFIG_TAG = "billing-kit"
_PRICE_TTL_SECONDS = 300
_price_ids: dict[str, tuple[str, float]] = {}


def _relative_path(value: str) -> str:
    # Only same-site paths, so redirects can't be pointed at another domain.
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        raise ValueError("must be a path starting with a single '/'")
    return value


RelativePath = Annotated[str, AfterValidator(_relative_path)]


class CheckoutIn(BaseModel):
    lookup_key: str
    quantity: int = Field(1, ge=1, le=100)
    success_path: RelativePath = "/billing/success"
    cancel_path: RelativePath = "/pricing"


class PortalIn(BaseModel):
    return_path: RelativePath = "/dashboard"


class RedirectOut(BaseModel):
    url: str
    id: str | None = None


async def price_id_for(lookup_key: str) -> str:
    cached = _price_ids.get(lookup_key)
    if cached and cached[1] > time.monotonic():
        return cached[0]
    prices = await get_stripe().v1.prices.list_async(
        {"lookup_keys": [lookup_key], "active": True, "limit": 1}
    )
    if not prices.data:
        raise HTTPException(
            409,
            {
                "error": "price_not_synced",
                "lookup_key": lookup_key,
                "fix": "run `uv run python -m app.billing.sync` in backend/",
            },
        )
    _price_ids[lookup_key] = (prices.data[0].id, time.monotonic() + _PRICE_TTL_SECONDS)
    return prices.data[0].id


async def ensure_customer(user: User, store: BillingStore) -> str:
    existing = await store.get_customer_id(user.id)
    if existing:
        return existing
    params: dict = {"metadata": {"supabase_user_id": user.id}}
    if user.email:
        params["email"] = user.email
    customers = get_stripe().v1.customers
    # The idempotency key stops double-clicks creating two customers...
    customer = await customers.create_async(
        params, {"idempotency_key": f"billing-customer-{user.id}"}
    )
    # ...but for 24h it also replays a customer that was deleted since. Start fresh then.
    response = getattr(customer, "last_response", None)
    if response is not None and response.headers.get("Idempotent-Replayed") == "true":
        current = await customers.retrieve_async(customer.id)
        if getattr(current, "deleted", False):
            customer = await customers.create_async(params)
    return await store.save_customer(user.id, customer.id, user.email)


def _with_query(path: str, query: str) -> str:
    return f"{path}{'&' if '?' in path else '?'}{query}"


@router.get("/catalog")
async def get_catalog() -> list[dict]:
    """Public price list for a pricing page (amounts in the smallest currency unit)."""
    return [
        {
            "product": product.id,
            "name": product.name,
            "description": product.description,
            "plan": product.plan,
            "prices": [
                {
                    "lookup_key": price.lookup_key,
                    "unit_amount": price.unit_amount,
                    "currency": price.currency,
                    "interval": price.interval,
                    "trial_days": price.trial_days,
                }
                for price in product.prices
            ],
        }
        for product in catalog.PRODUCTS
    ]


@router.post("/checkout")
async def create_checkout(
    body: CheckoutIn,
    user: User = Depends(current_user),
    store: BillingStore = Depends(get_store),
) -> RedirectOut:
    """Start a Stripe Checkout Session; redirect the browser to the returned `url`."""
    price = catalog.get_price(body.lookup_key)
    if price is None:
        raise HTTPException(404, {"error": "unknown_price", "lookup_key": body.lookup_key})

    if price.recurring:
        subscriptions = await store.list_subscriptions(user.id)
        if any(s.get("status") in ACTIVE_STATUSES for s in subscriptions):
            raise HTTPException(409, {"error": "already_subscribed", "manage": "/billing/portal"})

    price_id = await price_id_for(body.lookup_key)
    customer_id = await ensure_customer(user, store)
    app_url = get_settings().public_app_url
    metadata = {"supabase_user_id": user.id, "lookup_key": body.lookup_key}

    params: dict = {
        "mode": "subscription" if price.recurring else "payment",
        "customer": customer_id,
        "client_reference_id": user.id,
        "line_items": [{"price": price_id, "quantity": body.quantity}],
        "success_url": app_url + _with_query(body.success_path, "session_id={CHECKOUT_SESSION_ID}"),
        "cancel_url": app_url + body.cancel_path,
        "allow_promotion_codes": True,
        "metadata": metadata,
    }
    if price.recurring:
        params["subscription_data"] = {"metadata": metadata}
        if price.trial_days:
            params["subscription_data"]["trial_period_days"] = price.trial_days
    else:
        params["payment_intent_data"] = {"metadata": metadata}

    session = await get_stripe().v1.checkout.sessions.create_async(params)
    return RedirectOut(url=session.url, id=session.id)


async def _portal_configuration() -> str | None:
    """Use the account's default portal config, else the one the sync script created."""
    configs = await get_stripe().v1.billing_portal.configurations.list_async(
        {"active": True, "limit": 20}
    )
    tagged = None
    for config in configs.data:
        data = config.to_dict()
        if data.get("is_default"):
            return None
        if (data.get("metadata") or {}).get("managed_by") == PORTAL_CONFIG_TAG:
            tagged = data["id"]
    return tagged


@router.post("/portal")
async def create_portal(
    body: PortalIn | None = None,
    user: User = Depends(current_user),
    store: BillingStore = Depends(get_store),
) -> RedirectOut:
    """Stripe customer portal: change plan, cancel, update card, download invoices."""
    body = body or PortalIn()
    customer_id = await store.get_customer_id(user.id)
    if not customer_id:
        raise HTTPException(404, {"error": "no_billing_account", "fix": "check out first"})

    params: dict = {
        "customer": customer_id,
        "return_url": get_settings().public_app_url + body.return_path,
    }
    configuration = await _portal_configuration()
    if configuration:
        params["configuration"] = configuration
    try:
        session = await get_stripe().v1.billing_portal.sessions.create_async(params)
    except stripe.InvalidRequestError as error:
        raise HTTPException(
            409,
            {
                "error": "portal_not_configured",
                "message": error.user_message or str(error),
                "fix": "run `uv run python -m app.billing.sync` in backend/",
            },
        ) from error
    return RedirectOut(url=session.url, id=session.id)


@router.get("/me")
async def my_billing(
    user: User = Depends(current_user),
    store: BillingStore = Depends(get_store),
) -> Entitlements:
    """Current plan, subscription and one-time purchases for the signed-in user."""
    return await get_entitlements(user.id, store)


class OneTimeIn(BaseModel):
    lookup_key: str
    quantity: int = Field(1, ge=1, le=100)


def _one_time_price(lookup_key: str) -> catalog.Price:
    price = catalog.get_price(lookup_key)
    if price is None:
        raise HTTPException(404, {"error": "unknown_price", "lookup_key": lookup_key})
    if price.recurring:
        raise HTTPException(
            400, {"error": "recurring_price", "fix": "use /billing/checkout for subscriptions"}
        )
    return price


class PaymentIntentOut(BaseModel):
    id: str
    client_secret: str
    publishable_key: str | None
    amount: int
    currency: str


@router.post("/payment-intent")
async def create_payment_intent(
    body: OneTimeIn,
    user: User = Depends(current_user),
    store: BillingStore = Depends(get_store),
) -> PaymentIntentOut:
    """One-time purchase with Stripe Elements (your own payment form).

    The frontend mounts the Payment Element with `client_secret` and calls
    stripe.confirmPayment(); the payment_intent.succeeded webhook records the purchase.
    """
    price = _one_time_price(body.lookup_key)
    customer_id = await ensure_customer(user, store)
    intent = await get_stripe().v1.payment_intents.create_async(
        {
            "amount": price.unit_amount * body.quantity,
            "currency": price.currency,
            "customer": customer_id,
            "automatic_payment_methods": {"enabled": True},
            "metadata": {
                "purchase_source": "elements",
                "supabase_user_id": user.id,
                "lookup_key": body.lookup_key,
            },
        }
    )
    return PaymentIntentOut(
        id=intent.id,
        client_secret=intent.client_secret,
        publishable_key=get_settings().stripe_publishable_key,
        amount=intent.amount,
        currency=intent.currency,
    )


class InvoiceIn(OneTimeIn):
    days_until_due: int = Field(7, ge=1, le=90)


@router.post("/invoice")
async def create_invoice(
    body: InvoiceIn,
    user: User = Depends(current_user),
    store: BillingStore = Depends(get_store),
) -> dict:
    """Pay later: email the user a Stripe invoice for a one-time price.

    Recorded as a pending purchase now; invoice.paid flips it to paid.
    """
    price = _one_time_price(body.lookup_key)
    customer_id = await ensure_customer(user, store)
    invoice = await send_invoice(
        customer_id=customer_id,
        lines=[
            InvoiceLine(
                description=body.lookup_key,
                amount=price.unit_amount * body.quantity,
                currency=price.currency,
                price_id=await price_id_for(body.lookup_key),
                quantity=body.quantity,
            )
        ],
        days_until_due=body.days_until_due,
        metadata={
            "purchase_source": "invoice",
            "supabase_user_id": user.id,
            "lookup_key": body.lookup_key,
        },
    )
    await store.upsert_purchase(
        {
            "id": invoice["id"],
            "user_id": user.id,
            "stripe_customer_id": customer_id,
            "source": "invoice",
            "price_lookup_key": body.lookup_key,
            "amount_total": invoice["amount_due"],
            "currency": invoice["currency"],
            "status": "pending",
        }
    )
    return invoice

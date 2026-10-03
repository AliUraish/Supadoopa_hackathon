"""Stripe → Supabase sync. Stripe is the source of truth; these handlers mirror it.

Each event is processed once (billing_events), and subscriptions are re-fetched
from Stripe instead of trusting the payload, so out-of-order delivery and
mismatched webhook API versions can't write stale state.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request

from . import catalog
from .config import NotConfigured, get_settings
from .store import BillingStore, get_store
from .stripe_client import get_stripe

log = logging.getLogger(__name__)

webhook_router = APIRouter(tags=["billing"])

HANDLED_EVENTS = (
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
    "invoice.paid",
    "invoice.payment_failed",
)


def _iso(timestamp: int | None) -> str | None:
    return datetime.fromtimestamp(timestamp, UTC).isoformat() if timestamp else None


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _uuid_or_none(value: Any) -> str | None:
    # client_reference_id can come from a Payment Link URL, so don't trust its shape.
    try:
        return str(uuid.UUID(str(value))) if value else None
    except ValueError:
        return None


def _id(value: Any) -> str | None:
    """An expandable field is either an ID string or an object with an id."""
    if isinstance(value, dict):
        return value.get("id")
    return value


async def sync_subscription(subscription_id: str, store: BillingStore) -> None:
    subscription = await get_stripe().v1.subscriptions.retrieve_async(
        subscription_id, {"expand": ["items.data.price.product"]}
    )
    sub = subscription.to_dict()
    items = (sub.get("items") or {}).get("data") or []
    item = items[0] if items else {}
    price = item.get("price") or {}
    product = price.get("product") if isinstance(price.get("product"), dict) else {}
    lookup_key = price.get("lookup_key")
    customer_id = _id(sub.get("customer"))

    user_id = _uuid_or_none((sub.get("metadata") or {}).get("supabase_user_id"))
    if user_id is None and customer_id:
        user_id = await store.user_for_customer(customer_id)

    await store.upsert_subscription(
        {
            "id": sub["id"],
            "user_id": user_id,
            "stripe_customer_id": customer_id,
            "status": sub["status"],
            "price_lookup_key": lookup_key,
            "plan": catalog.plan_for(lookup_key) or (product.get("metadata") or {}).get("plan"),
            "quantity": item.get("quantity"),
            # Lives on the item since API 2025-03-31; older versions had it on the subscription.
            "current_period_end": _iso(
                item.get("current_period_end") or sub.get("current_period_end")
            ),
            "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
            "updated_at": _now(),
        }
    )


async def _handle_checkout(session: dict[str, Any], event_type: str, store: BillingStore) -> None:
    customer_id = _id(session.get("customer"))
    user_id = _uuid_or_none(session.get("client_reference_id")) or _uuid_or_none(
        (session.get("metadata") or {}).get("supabase_user_id")
    )
    if user_id and customer_id:
        email = (session.get("customer_details") or {}).get("email")
        try:
            await store.save_customer(user_id, customer_id, email)
        except Exception:  # e.g. the user was deleted; the payment still gets recorded
            log.warning("could not link customer %s to user %s", customer_id, user_id)

    if session.get("mode") == "subscription":
        if session.get("subscription"):
            await sync_subscription(_id(session["subscription"]), store)
        return

    if session.get("mode") != "payment":
        return
    if event_type == "checkout.session.async_payment_failed":
        status = "failed"
    elif session.get("payment_status") in ("paid", "no_payment_required"):
        status = "paid"
    else:
        status = "pending"  # delayed methods (e.g. bank debits) settle later

    line_items = await get_stripe().v1.checkout.sessions.line_items.list_async(
        session["id"], {"limit": 1}
    )
    first = line_items.data[0].to_dict() if line_items.data else {}
    await store.upsert_purchase(
        {
            "id": session["id"],
            "user_id": user_id,
            "stripe_customer_id": customer_id,
            "price_lookup_key": (first.get("price") or {}).get("lookup_key"),
            "amount_total": session.get("amount_total"),
            "currency": session.get("currency"),
            "status": status,
            "updated_at": _now(),
        }
    )


def _invoice_subscription(invoice: dict[str, Any]) -> str | None:
    # API 2025-03-31+: invoice.parent.subscription_details.subscription
    # Before that: invoice.subscription
    parent = invoice.get("parent") or {}
    details = parent.get("subscription_details") or {}
    return _id(details.get("subscription")) or _id(invoice.get("subscription"))


async def handle_event(event_type: str, obj: dict[str, Any], store: BillingStore) -> None:
    if event_type.startswith("checkout.session."):
        await _handle_checkout(obj, event_type, store)
    elif event_type.startswith("customer.subscription."):
        await sync_subscription(obj["id"], store)
    elif event_type.startswith("invoice."):
        subscription_id = _invoice_subscription(obj)
        if subscription_id:
            await sync_subscription(subscription_id, store)


@webhook_router.post("/webhooks/stripe", include_in_schema=False)
async def stripe_webhook(request: Request, store: BillingStore = Depends(get_store)) -> dict:
    secret = get_settings().stripe_webhook_secret
    if not secret:
        raise NotConfigured("STRIPE_WEBHOOK_SECRET")

    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(
            payload, request.headers.get("stripe-signature"), secret
        )
    except (ValueError, stripe.SignatureVerificationError) as error:
        raise HTTPException(400, "Invalid Stripe signature") from error

    if event.type not in HANDLED_EVENTS:
        return {"received": True, "handled": False}
    if not await store.claim_event(event.id, event.type):
        return {"received": True, "duplicate": True}

    try:
        await handle_event(event.type, event.data.object.to_dict(), store)
    except Exception:
        # Un-claim so Stripe's automatic retry processes it again; a 500 triggers the retry.
        await store.release_event(event.id)
        log.exception("failed to process %s %s", event.type, event.id)
        raise
    return {"received": True}

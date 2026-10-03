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
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.closed",
)

# PaymentIntents this backend creates directly (not via Checkout or invoices) carry
# metadata.purchase_source, so payment_intent.* events only record those.
DIRECT_SOURCES = ("elements", "agent")


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


def _metadata(obj: dict[str, Any]) -> dict[str, Any]:
    return obj.get("metadata") or {}


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

    user_id = _uuid_or_none(_metadata(sub).get("supabase_user_id"))
    if user_id is None and customer_id:
        user_id = await store.user_for_customer(customer_id)

    await store.upsert_subscription(
        {
            "id": sub["id"],
            "user_id": user_id,
            "stripe_customer_id": customer_id,
            "status": sub["status"],
            "price_lookup_key": lookup_key,
            "plan": catalog.plan_for(lookup_key) or _metadata(product).get("plan"),
            "quantity": item.get("quantity"),
            # Lives on the item since API 2025-03-31; older versions had it on the subscription.
            "current_period_end": _iso(
                item.get("current_period_end") or sub.get("current_period_end")
            ),
            "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
            "updated_at": _now(),
        }
    )


async def settled_state(payment_intent_id: str) -> dict[str, Any]:
    """A paid purchase's current status from Stripe, not from event order.

    Refund and dispute events can arrive before the payment's own event (seen with
    real webhooks), so recording a payment re-reads its charge.
    """
    stripe_v1 = get_stripe().v1
    intent = await stripe_v1.payment_intents.retrieve_async(
        payment_intent_id, {"expand": ["latest_charge"]}
    )
    charge = intent.to_dict().get("latest_charge")
    if not isinstance(charge, dict):
        return {"status": "paid", "amount_refunded": 0}
    state = {"status": "paid", "amount_refunded": charge.get("amount_refunded") or 0}
    if charge.get("disputed"):
        disputes = await stripe_v1.disputes.list_async(
            {"payment_intent": payment_intent_id, "limit": 1}
        )
        outcome = disputes.data[0].status if disputes.data else "needs_response"
        state["status"] = {"lost": "dispute_lost", "won": "paid", "warning_closed": "paid"}.get(
            outcome, "disputed"
        )
    elif charge.get("refunded"):
        state["status"] = "refunded"
    return state


async def _handle_checkout(session: dict[str, Any], event_type: str, store: BillingStore) -> None:
    customer_id = _id(session.get("customer"))
    user_id = _uuid_or_none(session.get("client_reference_id")) or _uuid_or_none(
        _metadata(session).get("supabase_user_id")
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

    payment_intent_id = _id(session.get("payment_intent"))
    settled = {"status": status}
    if status == "paid" and payment_intent_id:
        settled = await settled_state(payment_intent_id)

    line_items = await get_stripe().v1.checkout.sessions.line_items.list_async(
        session["id"], {"limit": 1}
    )
    first = line_items.data[0].to_dict() if line_items.data else {}
    await store.upsert_purchase(
        {
            "id": session["id"],
            "user_id": user_id,
            "stripe_customer_id": customer_id,
            "payment_intent_id": payment_intent_id,
            "source": "payment_link" if session.get("payment_link") else "checkout",
            "price_lookup_key": (first.get("price") or {}).get("lookup_key"),
            "amount_total": session.get("amount_total"),
            "currency": session.get("currency"),
            **settled,
            "updated_at": _now(),
        }
    )


async def _handle_payment_intent(intent: dict[str, Any], event_type: str, store: BillingStore):
    meta = _metadata(intent)
    if meta.get("purchase_source") not in DIRECT_SOURCES:
        return  # Checkout, invoices and MPP record themselves elsewhere
    succeeded = event_type == "payment_intent.succeeded"
    settled = await settled_state(intent["id"]) if succeeded else {"status": "failed"}
    await store.upsert_purchase(
        {
            "id": intent["id"],
            "user_id": _uuid_or_none(meta.get("supabase_user_id")),
            "stripe_customer_id": _id(intent.get("customer")),
            "payment_intent_id": intent["id"],
            "source": meta["purchase_source"],
            "price_lookup_key": meta.get("lookup_key"),
            "amount_total": intent.get("amount_received") if succeeded else intent.get("amount"),
            "currency": intent.get("currency"),
            **settled,
            "updated_at": _now(),
        }
    )


def _invoice_subscription(invoice: dict[str, Any]) -> str | None:
    # API 2025-03-31+: invoice.parent.subscription_details.subscription
    # Before that: invoice.subscription
    parent = invoice.get("parent") or {}
    details = parent.get("subscription_details") or {}
    return _id(details.get("subscription")) or _id(invoice.get("subscription"))


async def _invoice_payment_intent(invoice_id: str) -> str | None:
    payments = await get_stripe().v1.invoice_payments.list_async(
        {"invoice": invoice_id, "limit": 1}
    )
    if not payments.data:
        return None
    return _id((payments.data[0].to_dict().get("payment") or {}).get("payment_intent"))


async def _handle_invoice(invoice: dict[str, Any], event_type: str, store: BillingStore) -> None:
    subscription_id = _invoice_subscription(invoice)
    if subscription_id:
        await sync_subscription(subscription_id, store)
        return
    meta = _metadata(invoice)
    if meta.get("purchase_source") != "invoice" or event_type != "invoice.paid":
        return  # an unpaid one-time invoice just stays "pending"
    payment_intent_id = await _invoice_payment_intent(invoice["id"])
    settled = await settled_state(payment_intent_id) if payment_intent_id else {"status": "paid"}
    await store.upsert_purchase(
        {
            "id": invoice["id"],
            "user_id": _uuid_or_none(meta.get("supabase_user_id")),
            "stripe_customer_id": _id(invoice.get("customer")),
            "payment_intent_id": payment_intent_id,
            "source": "invoice",
            "price_lookup_key": meta.get("lookup_key"),
            "amount_total": invoice.get("amount_paid"),
            "currency": invoice.get("currency"),
            **settled,
            "updated_at": _now(),
        }
    )


async def _handle_refund(charge: dict[str, Any], store: BillingStore) -> None:
    payment_intent_id = _id(charge.get("payment_intent"))
    if not payment_intent_id:
        return
    fields: dict[str, Any] = {"amount_refunded": charge.get("amount_refunded") or 0}
    if charge.get("refunded"):  # fully refunded; partial refunds only update the amount
        fields["status"] = "refunded"
    fields["updated_at"] = _now()
    await store.update_purchase_by_payment_intent(payment_intent_id, fields)


async def _handle_dispute(dispute: dict[str, Any], event_type: str, store: BillingStore) -> None:
    payment_intent_id = _id(dispute.get("payment_intent"))
    if not payment_intent_id:
        return
    if event_type == "charge.dispute.created":
        status = "disputed"
    else:
        status = "dispute_lost" if dispute.get("status") == "lost" else "paid"
    await store.update_purchase_by_payment_intent(
        payment_intent_id, {"status": status, "updated_at": _now()}
    )


async def handle_event(event_type: str, obj: dict[str, Any], store: BillingStore) -> None:
    if event_type.startswith("checkout.session."):
        await _handle_checkout(obj, event_type, store)
    elif event_type.startswith("customer.subscription."):
        await sync_subscription(obj["id"], store)
    elif event_type.startswith("invoice."):
        await _handle_invoice(obj, event_type, store)
    elif event_type.startswith("payment_intent."):
        await _handle_payment_intent(obj, event_type, store)
    elif event_type == "charge.refunded":
        await _handle_refund(obj, store)
    elif event_type.startswith("charge.dispute."):
        await _handle_dispute(obj, event_type, store)


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

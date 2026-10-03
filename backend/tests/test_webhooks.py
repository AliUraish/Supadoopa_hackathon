"""Stripe webhook → billing tables. Stripe reads are faked; signatures are real."""

import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
import stripe
from conftest import USER_ID

from app.billing import webhooks

SECRET = "whsec_test_secret"
PERIOD_END = int(datetime(2026, 11, 3, tzinfo=UTC).timestamp())


def stripe_object(data: dict) -> stripe.StripeObject:
    return stripe.StripeObject.construct_from(data, "sk_test_123")


def subscription(status: str = "active", **overrides) -> dict:
    return {
        "id": "sub_1",
        "object": "subscription",
        "customer": "cus_1",
        "status": status,
        "cancel_at_period_end": False,
        "metadata": {"supabase_user_id": USER_ID},
        "items": {
            "data": [
                {
                    "quantity": 1,
                    "current_period_end": PERIOD_END,
                    "price": {
                        "id": "price_1",
                        "lookup_key": "pro_monthly",
                        "product": {"id": "prod_pro", "metadata": {}},
                    },
                }
            ]
        },
        **overrides,
    }


class FakeStripe:
    def __init__(self, sub: dict | None = None, line_item_key: str = "credits_100", fail: int = 0):
        self.sub = sub or subscription()
        self.retrieved: list[str] = []
        self.fail = fail
        line_items = SimpleNamespace(data=[stripe_object({"price": {"lookup_key": line_item_key}})])

        async def retrieve_async(subscription_id, params=None):
            if self.fail:
                self.fail -= 1
                raise stripe.APIConnectionError("network down")
            self.retrieved.append(subscription_id)
            return stripe_object(self.sub)

        async def list_line_items(session_id, params=None):
            return line_items

        self.charge = {"disputed": False, "refunded": False, "amount_refunded": 0}
        self.dispute_status = "needs_response"

        async def retrieve_intent(intent_id, params=None):
            return stripe_object({"id": intent_id, "latest_charge": self.charge})

        async def list_disputes(params=None):
            return SimpleNamespace(data=[SimpleNamespace(status=self.dispute_status)])

        self.v1 = SimpleNamespace(
            subscriptions=SimpleNamespace(retrieve_async=retrieve_async),
            checkout=SimpleNamespace(
                sessions=SimpleNamespace(line_items=SimpleNamespace(list_async=list_line_items))
            ),
            payment_intents=SimpleNamespace(retrieve_async=retrieve_intent),
            disputes=SimpleNamespace(list_async=list_disputes),
        )


@pytest.fixture
def fake_stripe(monkeypatch, configure):
    configure(STRIPE_WEBHOOK_SECRET=SECRET, STRIPE_SECRET_KEY="sk_test_123")
    fake = FakeStripe()
    monkeypatch.setattr(webhooks, "get_stripe", lambda: fake)
    return fake


def send(client, event_type: str, obj: dict, event_id: str = "evt_1", secret: str = SECRET):
    payload = json.dumps(
        {
            "id": event_id,
            "object": "event",
            "type": event_type,
            "data": {"object": obj},
            "created": int(time.time()),
            "livemode": False,
            "api_version": "2026-09-30.endive",
        }
    )
    timestamp = int(time.time())
    signature = hmac.new(
        secret.encode(), f"{timestamp}.{payload}".encode(), hashlib.sha256
    ).hexdigest()
    return client.post(
        "/webhooks/stripe",
        content=payload,
        headers={
            "stripe-signature": f"t={timestamp},v1={signature}",
            "content-type": "application/json",
        },
    )


def test_missing_secret_is_503(client, memory_store):
    assert send(client, "invoice.paid", {}).status_code == 503


def test_bad_signature_is_rejected(client, memory_store, fake_stripe):
    response = send(client, "customer.subscription.updated", subscription(), secret="whsec_wrong")
    assert response.status_code == 400
    assert memory_store.subscriptions == {}


def test_unhandled_events_are_acknowledged(client, memory_store, fake_stripe):
    response = send(client, "charge.succeeded", {"id": "ch_1"})
    assert response.json() == {"received": True, "handled": False}


def test_subscription_event_syncs_from_stripe(client, memory_store, fake_stripe):
    # The payload is deliberately stale; the handler must trust the re-fetched copy.
    response = send(client, "customer.subscription.updated", subscription(status="incomplete"))
    assert response.json() == {"received": True}
    row = memory_store.subscriptions["sub_1"]
    assert row["status"] == "active"
    assert row["user_id"] == USER_ID and row["plan"] == "pro"
    assert row["price_lookup_key"] == "pro_monthly"
    assert row["current_period_end"] == "2026-11-03T00:00:00+00:00"


def test_duplicate_events_are_processed_once(client, memory_store, fake_stripe):
    send(client, "customer.subscription.updated", subscription())
    response = send(client, "customer.subscription.updated", subscription())
    assert response.json() == {"received": True, "duplicate": True}
    assert fake_stripe.retrieved == ["sub_1"]


def test_failed_processing_is_retried(client, memory_store, fake_stripe):
    fake_stripe.fail = 1
    assert send(client, "customer.subscription.updated", subscription()).status_code == 500
    assert "evt_1" not in memory_store.events  # released for Stripe's retry
    assert send(client, "customer.subscription.updated", subscription()).json() == {
        "received": True
    }
    assert memory_store.subscriptions["sub_1"]["status"] == "active"


def test_user_falls_back_to_customer_link(client, memory_store, fake_stripe):
    fake_stripe.sub = subscription(metadata={})
    memory_store.customers[USER_ID] = {"user_id": USER_ID, "stripe_customer_id": "cus_1"}
    send(client, "customer.subscription.created", subscription())
    assert memory_store.subscriptions["sub_1"]["user_id"] == USER_ID


def test_checkout_payment_records_a_purchase(client, memory_store, fake_stripe):
    session = {
        "id": "cs_1",
        "object": "checkout.session",
        "mode": "payment",
        "customer": "cus_9",
        "client_reference_id": USER_ID,
        "payment_status": "paid",
        "amount_total": 500,
        "currency": "usd",
        "customer_details": {"email": "dev@example.com"},
        "metadata": {},
    }
    assert send(client, "checkout.session.completed", session).json() == {"received": True}
    assert memory_store.purchases["cs_1"]["status"] == "paid"
    assert memory_store.purchases["cs_1"]["price_lookup_key"] == "credits_100"
    assert memory_store.customers[USER_ID]["stripe_customer_id"] == "cus_9"


def test_delayed_payment_goes_pending_then_paid(client, memory_store, fake_stripe):
    session = {
        "id": "cs_2",
        "mode": "payment",
        "customer": "cus_9",
        "client_reference_id": USER_ID,
        "payment_status": "unpaid",
        "amount_total": 500,
        "currency": "usd",
        "metadata": {},
    }
    send(client, "checkout.session.completed", session, event_id="evt_a")
    assert memory_store.purchases["cs_2"]["status"] == "pending"
    send(
        client,
        "checkout.session.async_payment_succeeded",
        {**session, "payment_status": "paid"},
        event_id="evt_b",
    )
    assert memory_store.purchases["cs_2"]["status"] == "paid"


def test_checkout_subscription_links_and_syncs(client, memory_store, fake_stripe):
    session = {
        "id": "cs_3",
        "mode": "subscription",
        "customer": "cus_1",
        "subscription": "sub_1",
        "client_reference_id": USER_ID,
        "payment_status": "paid",
        "metadata": {},
    }
    send(client, "checkout.session.completed", session)
    assert memory_store.customers[USER_ID]["stripe_customer_id"] == "cus_1"
    assert memory_store.subscriptions["sub_1"]["plan"] == "pro"


def test_untrusted_client_reference_id_is_ignored(client, memory_store, fake_stripe):
    session = {
        "id": "cs_4",
        "mode": "payment",
        "customer": "cus_9",
        "client_reference_id": "'; drop",
        "payment_status": "paid",
        "amount_total": 500,
        "currency": "usd",
        "metadata": {},
    }
    assert send(client, "checkout.session.completed", session).status_code == 200
    assert memory_store.purchases["cs_4"]["user_id"] is None
    assert memory_store.customers == {}


@pytest.mark.parametrize(
    "invoice",
    [
        {"id": "in_1", "parent": {"subscription_details": {"subscription": "sub_1"}}},
        {"id": "in_1", "subscription": "sub_1"},  # pre-2025-03-31 shape
    ],
)
def test_invoice_events_resync_the_subscription(client, memory_store, fake_stripe, invoice):
    send(client, "invoice.payment_failed", invoice)
    assert fake_stripe.retrieved == ["sub_1"]


def test_webhook_with_real_postgres(client, pg_store, fake_stripe):
    from app.billing.store import get_store
    from app.main import app

    app.dependency_overrides[get_store] = lambda: pg_store
    assert send(client, "customer.subscription.created", subscription()).json() == {
        "received": True
    }
    assert send(client, "customer.subscription.created", subscription()).json()["duplicate"] is True

"""Human payment workflows beyond Checkout: Elements, invoices, refunds and disputes."""

from types import SimpleNamespace

import pytest
from conftest import USER_ID
from test_webhooks import FakeStripe, send, stripe_object

from app.billing import webhooks

# --- endpoints (stripe-mock validates every request) -----------------------------------


def test_elements_payment_intent(client, memory_store, signed_in, stripe_mock, configure):
    configure(STRIPE_PUBLISHABLE_KEY="pk_test_123")
    response = client.post("/billing/payment-intent", json={"lookup_key": "credits_100"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["client_secret"] and body["publishable_key"] == "pk_test_123"
    assert memory_store.customers[USER_ID]["stripe_customer_id"].startswith("cus_")


@pytest.mark.parametrize("path", ["/billing/payment-intent", "/billing/invoice"])
def test_one_time_endpoints_reject_subscriptions(client, memory_store, signed_in, path):
    assert client.post(path, json={"lookup_key": "pro_monthly"}).status_code == 400
    assert client.post(path, json={"lookup_key": "nope"}).status_code == 404


def test_pay_by_invoice_records_a_pending_purchase(client, memory_store, signed_in, stripe_mock):
    response = client.post("/billing/invoice", json={"lookup_key": "credits_100"})
    assert response.status_code == 200, response.text
    invoice = response.json()
    assert invoice["id"].startswith("in_")
    purchase = memory_store.purchases[invoice["id"]]
    assert purchase["status"] == "pending" and purchase["source"] == "invoice"


# --- webhooks --------------------------------------------------------------------------


@pytest.fixture
def hooks(monkeypatch, configure):
    configure(STRIPE_WEBHOOK_SECRET="whsec_test_secret", STRIPE_SECRET_KEY="sk_test_123")

    async def list_invoice_payments(params=None):
        payment = {"payment": {"type": "payment_intent", "payment_intent": "pi_inv"}}
        return SimpleNamespace(data=[stripe_object(payment)])

    fake = FakeStripe()
    fake.v1.invoice_payments = SimpleNamespace(list_async=list_invoice_payments)
    monkeypatch.setattr(webhooks, "get_stripe", lambda: fake)
    return fake


def intent(source: str | None, **overrides) -> dict:
    metadata = {"supabase_user_id": USER_ID, "lookup_key": "credits_100"}
    if source:
        metadata["purchase_source"] = source
    return {
        "id": "pi_1",
        "amount": 500,
        "amount_received": 500,
        "currency": "usd",
        "customer": "cus_1",
        "metadata": metadata,
        **overrides,
    }


def test_elements_payment_is_recorded(client, memory_store, hooks):
    send(client, "payment_intent.succeeded", intent("elements"))
    purchase = memory_store.purchases["pi_1"]
    assert purchase["status"] == "paid" and purchase["source"] == "elements"
    assert purchase["user_id"] == USER_ID and purchase["payment_intent_id"] == "pi_1"


def test_payment_intents_from_checkout_are_not_double_recorded(client, memory_store, hooks):
    send(client, "payment_intent.succeeded", intent(None))
    assert memory_store.purchases == {}


def test_failed_elements_payment(client, memory_store, hooks):
    send(client, "payment_intent.payment_failed", intent("elements"))
    assert memory_store.purchases["pi_1"]["status"] == "failed"


def test_one_time_invoice_paid(client, memory_store, hooks):
    memory_store.purchases["in_1"] = {"id": "in_1", "user_id": USER_ID, "status": "pending"}
    invoice = {
        "id": "in_1",
        "customer": "cus_1",
        "amount_paid": 500,
        "currency": "usd",
        "metadata": {
            "purchase_source": "invoice",
            "supabase_user_id": USER_ID,
            "lookup_key": "credits_100",
        },
    }
    send(client, "invoice.paid", invoice)
    purchase = memory_store.purchases["in_1"]
    assert purchase["status"] == "paid" and purchase["payment_intent_id"] == "pi_inv"


def test_refunds(client, memory_store, hooks):
    send(client, "payment_intent.succeeded", intent("elements"), event_id="evt_a")
    partial = {"id": "ch_1", "payment_intent": "pi_1", "amount_refunded": 200, "refunded": False}
    send(client, "charge.refunded", partial, event_id="evt_b")
    assert memory_store.purchases["pi_1"]["status"] == "paid"
    assert memory_store.purchases["pi_1"]["amount_refunded"] == 200

    send(
        client,
        "charge.refunded",
        {**partial, "amount_refunded": 500, "refunded": True},
        event_id="evt_c",
    )
    assert memory_store.purchases["pi_1"]["status"] == "refunded"


@pytest.mark.parametrize(("outcome", "status"), [("lost", "dispute_lost"), ("won", "paid")])
def test_disputes(client, memory_store, hooks, outcome, status):
    send(client, "payment_intent.succeeded", intent("elements"), event_id="evt_a")
    dispute = {"id": "dp_1", "payment_intent": "pi_1", "status": "needs_response"}
    send(client, "charge.dispute.created", dispute, event_id="evt_b")
    assert memory_store.purchases["pi_1"]["status"] == "disputed"
    send(client, "charge.dispute.closed", {**dispute, "status": outcome}, event_id="evt_c")
    assert memory_store.purchases["pi_1"]["status"] == status


def test_refund_revokes_purchase_access(client, memory_store, signed_in, hooks):
    send(client, "payment_intent.succeeded", intent("elements"), event_id="evt_a")
    assert client.get("/examples/credits").status_code == 200
    refund = {"id": "ch_1", "payment_intent": "pi_1", "amount_refunded": 500, "refunded": True}
    send(client, "charge.refunded", refund, event_id="evt_b")
    assert client.get("/examples/credits").status_code == 402


def test_payment_link_purchases_are_tagged(client, memory_store, hooks):
    session = {
        "id": "cs_1",
        "mode": "payment",
        "payment_link": "plink_1",
        "payment_intent": "pi_9",
        "payment_status": "paid",
        "amount_total": 500,
        "currency": "usd",
        "metadata": {},
    }
    send(client, "checkout.session.completed", session)
    assert memory_store.purchases["cs_1"]["source"] == "payment_link"
    assert memory_store.purchases["cs_1"]["payment_intent_id"] == "pi_9"


def test_dispute_that_arrives_before_the_payment(client, memory_store, hooks):
    # Real Stripe delivered charge.dispute.created before payment_intent.succeeded.
    dispute = {"id": "dp_1", "payment_intent": "pi_1", "status": "needs_response"}
    send(client, "charge.dispute.created", dispute, event_id="evt_a")
    assert memory_store.purchases == {}
    hooks.charge["disputed"] = True
    send(client, "payment_intent.succeeded", intent("elements"), event_id="evt_b")
    assert memory_store.purchases["pi_1"]["status"] == "disputed"


def test_refund_that_arrives_before_the_payment(client, memory_store, hooks):
    hooks.charge.update(refunded=True, amount_refunded=500)
    send(client, "payment_intent.succeeded", intent("elements"))
    purchase = memory_store.purchases["pi_1"]
    assert purchase["status"] == "refunded" and purchase["amount_refunded"] == 500

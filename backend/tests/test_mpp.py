"""MPP pay-per-call: real pympp challenge/credential flow, faked Stripe PaymentIntent."""

from types import SimpleNamespace

import pytest
from mpp import Challenge, Credential, Receipt

from app.billing import mpp
from app.billing.store import MemoryStore

ROUTE = "/examples/paid-call"


@pytest.fixture
def mpp_env(configure):
    configure(
        STRIPE_SECRET_KEY="sk_test_123", STRIPE_PROFILE_ID="profile_test_123", MPP_REALM="api.test"
    )


@pytest.fixture
def payments(monkeypatch, mpp_env):
    created: list[dict] = []
    by_idempotency_key: dict[str, str] = {}
    state = {"status": "succeeded"}

    async def create_async(params, options=None):
        # Like Stripe: the same idempotency key returns the same PaymentIntent.
        key = (options or {})["idempotency_key"]
        by_idempotency_key.setdefault(key, f"pi_{len(by_idempotency_key) + 1}")
        created.append({"params": params, "options": options})
        return SimpleNamespace(id=by_idempotency_key[key], status=state["status"])

    fake = SimpleNamespace(
        v1=SimpleNamespace(payment_intents=SimpleNamespace(create_async=create_async))
    )
    monkeypatch.setattr(mpp, "get_stripe", lambda: fake)
    replay_store = MemoryStore()
    monkeypatch.setattr(mpp, "get_store", lambda: replay_store)
    return SimpleNamespace(created=created, state=state, store=replay_store)


def pay(client, response, spt: str = "spt_test_123"):
    challenge = Challenge.from_www_authenticate(response.headers["www-authenticate"])
    credential = Credential(challenge=challenge.to_echo(), payload={"spt": spt})
    return client.post(ROUTE, headers={"Authorization": credential.to_authorization()})


def test_needs_a_stripe_profile(client, configure):
    configure(STRIPE_SECRET_KEY="sk_test_123")
    response = client.post(ROUTE)
    assert response.status_code == 503
    assert response.json()["detail"]["missing"] == ["STRIPE_PROFILE_ID"]


def test_unpaid_request_gets_a_402_challenge(client, mpp_env):
    response = client.post(ROUTE)
    assert response.status_code == 402
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["cache-control"] == "no-store"
    challenge = Challenge.from_www_authenticate(response.headers["www-authenticate"])
    assert challenge.method == "stripe" and challenge.intent == "charge"
    assert challenge.request["amount"] == "50"
    assert challenge.request["currency"] == "usd"
    assert challenge.request["methodDetails"]["networkId"] == "profile_test_123"


def test_paid_request_is_served_with_a_receipt(client, payments):
    response = pay(client, client.post(ROUTE))
    assert response.status_code == 200, response.text
    assert response.json()["payment"] == "pi_1"
    receipt = Receipt.from_payment_receipt(response.headers["payment-receipt"])
    assert receipt.reference == "pi_1" and receipt.method == "stripe"

    params = payments.created[0]["params"]
    assert params["amount"] == 50 and params["currency"] == "usd" and params["confirm"] is True
    assert params["shared_payment_granted_token"] == "spt_test_123"
    assert payments.store.mpp_payments["pi_1"]["resource"] == ROUTE


def test_a_payment_credential_cannot_be_replayed(client, payments):
    challenge_response = client.post(ROUTE)
    assert pay(client, challenge_response).status_code == 200
    replay = pay(client, challenge_response)
    assert replay.status_code == 409
    assert replay.json()["detail"]["error"] == "payment_already_used"
    # A fresh challenge + payment works again.
    assert pay(client, client.post(ROUTE), spt="spt_test_456").status_code == 200


def test_failed_payment_is_not_served(client, payments):
    payments.state["status"] = "requires_payment_method"
    response = pay(client, client.post(ROUTE))
    assert response.status_code in (402, 403)
    assert payments.store.mpp_payments == {}


def test_tiny_amounts_are_rejected_at_startup():
    with pytest.raises(ValueError):
        mpp.paid("0.10")

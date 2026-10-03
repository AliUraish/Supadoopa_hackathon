"""POST /mpp/charge: MPP payment checks for other services (the Doorway MCP gateway)."""

import pytest
from mpp import Challenge, Credential, Receipt
from test_mpp import mpp_env, payments  # noqa: F401  (fixtures)

KEY = {"X-Gateway-Key": "gw_secret"}
TOOL = {"amount": "0.50", "resource": "clinic/book_appointment", "description": "Book a slot"}


@pytest.fixture
def gateway(configure, payments):  # noqa: F811
    configure(MPP_GATEWAY_SECRET="gw_secret")
    return payments


def pay(client, challenge_response, body=TOOL, spt="spt_test_123"):
    challenge = Challenge.from_www_authenticate(challenge_response.headers["www-authenticate"])
    credential = Credential(challenge=challenge.to_echo(), payload={"spt": spt})
    return client.post(
        "/mpp/charge", headers=KEY, json={**body, "authorization": credential.to_authorization()}
    )


def test_needs_the_gateway_secret(client, configure):
    assert client.post("/mpp/charge", json=TOOL).status_code == 503
    configure(MPP_GATEWAY_SECRET="gw_secret")
    wrong = client.post("/mpp/charge", headers={"X-Gateway-Key": "nope"}, json=TOOL)
    assert wrong.status_code == 401


def test_unpaid_call_gets_a_challenge_bound_to_the_tool(client, gateway):
    response = client.post("/mpp/charge", headers=KEY, json=TOOL)
    assert response.status_code == 402
    assert response.headers["content-type"].startswith("application/problem+json")
    challenge = Challenge.from_www_authenticate(response.headers["www-authenticate"])
    assert challenge.request["amount"] == "50"
    assert challenge.request["extra"] == {"resource": "clinic/book_appointment"}


def test_paid_call_returns_a_receipt_once(client, gateway):
    first = client.post("/mpp/charge", headers=KEY, json=TOOL)
    paid = pay(client, first)
    assert paid.status_code == 200, paid.text
    body = paid.json()
    assert body["status"] == "paid" and body["reference"] == "pi_1"
    assert Receipt.from_payment_receipt(body["receipt"]).reference == "pi_1"
    assert gateway.store.mpp_payments["pi_1"]["resource"] == "clinic/book_appointment"
    assert pay(client, first).status_code == 409  # replay


def test_credential_for_one_tool_cannot_pay_for_another(client, gateway):
    first = client.post("/mpp/charge", headers=KEY, json=TOOL)
    other = {**TOOL, "resource": "clinic/cancel_appointment"}
    assert pay(client, first, body=other).status_code == 402
    assert gateway.created == []  # nothing was charged


def test_failed_payment_gets_a_fresh_challenge(client, gateway):
    gateway.state["status"] = "requires_payment_method"
    response = pay(client, client.post("/mpp/charge", headers=KEY, json=TOOL))
    assert response.status_code == 402
    assert response.headers["www-authenticate"].startswith("Payment ")


def test_amount_must_meet_the_card_minimum(client, gateway):
    small = client.post("/mpp/charge", headers=KEY, json={**TOOL, "amount": "0.10"})
    assert small.status_code == 422


def test_paid_call_is_served_even_if_the_database_is_down(client, gateway, monkeypatch):
    from app.billing import mpp
    from app.billing.store import StoreError

    class BrokenStore:
        async def claim_mpp_payment(self, row):
            raise StoreError("relation billing_mpp_payments does not exist")

    monkeypatch.setattr(mpp, "get_store", lambda: BrokenStore())
    first = client.post("/mpp/charge", headers=KEY, json=TOOL)
    assert pay(client, first).status_code == 200  # money was taken, so serve the call
    assert pay(client, first).status_code == 409  # still single use, per process

"""Agent workflows: agents buying from us (SPT, llms.txt, catalog feed) and our agent
buying for a user (Link Agent Wallet). External APIs are faked at the HTTP layer."""

import base64
import hashlib
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import stripe
from conftest import USER_ID

from app.billing import agent_catalog, agent_wallet, agents

# --- agents buying from us -------------------------------------------------------------


@pytest.fixture
def charges(monkeypatch, configure):
    configure(STRIPE_SECRET_KEY="sk_test_123")
    state = {"status": "succeeded", "error": None, "calls": []}

    async def create_async(params, options=None):
        state["calls"].append((params, options))
        if state["error"]:
            raise state["error"]
        return SimpleNamespace(id="pi_1", status=state["status"], amount=500, currency="usd")

    fake = SimpleNamespace(
        v1=SimpleNamespace(payment_intents=SimpleNamespace(create_async=create_async))
    )
    monkeypatch.setattr(agents, "get_stripe", lambda: fake)
    return state


def test_agent_checkout_charges_the_spt(client, charges):
    body = {"lookup_key": "credits_100", "shared_payment_token": "spt_abc", "email": "a@b.co"}
    response = client.post("/agents/checkout", json=body)
    assert response.json() == {
        "status": "paid",
        "payment_intent": "pi_1",
        "lookup_key": "credits_100",
        "amount": 500,
        "currency": "usd",
    }
    params, options = charges["calls"][0]
    assert params["shared_payment_granted_token"] == "spt_abc" and params["amount"] == 500
    assert params["metadata"]["purchase_source"] == "agent"
    assert options == {"idempotency_key": "agent-checkout-spt_abc"}


def test_agent_checkout_failures_are_402(client, charges):
    body = {"lookup_key": "credits_100", "shared_payment_token": "spt_abc"}
    charges["status"] = "requires_action"
    assert client.post("/agents/checkout", json=body).status_code == 402
    charges["error"] = stripe.CardError("declined", "card", "card_declined")
    assert client.post("/agents/checkout", json=body).status_code == 402


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"lookup_key": "pro_monthly", "shared_payment_token": "spt_x"}, 400),
        ({"lookup_key": "credits_100", "shared_payment_token": "pm_card_visa"}, 422),
    ],
)
def test_agent_checkout_validation(client, charges, body, status):
    assert client.post("/agents/checkout", json=body).status_code == status


def test_test_tokens_are_sandbox_only(client, configure):
    assert client.post("/agents/test-token", json={"amount": 500}).status_code == 503
    configure(STRIPE_SECRET_KEY="sk_live_123")
    assert client.post("/agents/test-token", json={"amount": 500}).status_code == 403


def test_llms_txt_lists_what_agents_can_buy(client):
    text = client.get("/llms.txt").text
    assert "credits_100: 100 credits, 5.00 USD" in text
    assert "/examples/paid-call: 0.50 USD per call" in text
    assert "pro_monthly" not in text  # subscriptions are for humans


def test_agent_catalog_feed(capsys):
    rows = agent_catalog.feed_rows("https://shop.example", "https://shop.example/p.png", "Acme")
    assert [row["id"] for row in rows] == ["credits_100"]
    assert rows[0]["price"] == "5.00 USD" and rows[0]["inventory_not_tracked"] == "true"
    assert agent_catalog.main(["--image", "https://x.example/p.png"]) == 0
    assert capsys.readouterr().out.startswith("id,title,description,link")


# --- our agent buying for a user (Link Agent Wallet) -----------------------------------


@pytest.fixture
def link(monkeypatch, configure):
    configure(
        LINK_CLIENT_ID="client_1",
        LINK_CLIENT_SECRET="secret_1",
        STRIPE_PUBLISHABLE_KEY="pk_test_1",
        API_URL="https://api.example",
        APP_URL="https://app.example",
    )
    seen: list[httpx.Request] = []
    spend = {"status": "pending_approval"}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/auth/token":
            return httpx.Response(
                200,
                json={
                    "access_token": f"liwltoken_{len(seen)}",
                    "refresh_token": f"liwlrefresh_{len(seen)}",
                    "expires_in": 3600,
                    "scope": "payment_methods.agentic userinfo:read",
                },
            )
        if request.url.path.startswith("/spend_requests"):
            return httpx.Response(
                200,
                json={
                    "id": "lsrq_1",
                    "status": spend["status"],
                    "amount": 3500,
                    "currency": "usd",
                    "merchant_name": "Stripe Press",
                    "approval_url": "https://app.link.com/approve/lsrq_1",
                    "card": {"number": "4242424242424242", "cvc": "123"},
                },
            )
        return httpx.Response(200, json={})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        agent_wallet.httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(handler), **kw),
    )
    return SimpleNamespace(seen=seen, spend=spend)


SPEND = {
    "amount": 3500,
    "merchant_name": "Stripe Press",
    "merchant_url": "https://press.stripe.com",
    "context": "Buying 'Working in Public' from press.stripe.com because the user asked the "
    "assistant to order it as a gift; total includes shipping.",
}


def test_wallet_needs_link_credentials(client, memory_store, signed_in):
    response = client.post("/agent-wallet/connect")
    assert response.status_code == 503
    assert "LINK_CLIENT_ID" in response.json()["detail"]["missing"]


def test_connect_callback_and_spend(client, memory_store, signed_in, link):
    url = urlparse(client.post("/agent-wallet/connect").json()["url"])
    query = parse_qs(url.query)
    assert url.netloc == "login.link.com" and query["code_challenge_method"] == ["S256"]
    assert query["redirect_uri"] == ["https://api.example/agent-wallet/callback"]
    state = query["state"][0]
    verifier = memory_store.link_states[state]["code_verifier"]
    digest = hashlib.sha256(verifier.encode()).digest()
    assert query["code_challenge"] == [base64.urlsafe_b64encode(digest).rstrip(b"=").decode()]

    callback = client.get(
        "/agent-wallet/callback", params={"code": "c1", "state": state}, follow_redirects=False
    )
    assert callback.headers["location"] == "https://app.example/dashboard?wallet=connected"
    token_form = parse_qs(link.seen[-1].content.decode())
    assert token_form["code_verifier"] == [verifier] and token_form["client_secret"] == ["secret_1"]
    assert client.get("/agent-wallet").json()["connected"] is True

    # State is single use.
    again = client.get(
        "/agent-wallet/callback", params={"code": "c1", "state": state}, follow_redirects=False
    )
    assert again.headers["location"].endswith("wallet=error")

    created = client.post("/agent-wallet/spend-requests", json=SPEND).json()
    assert created["approval_url"].startswith("https://app.link.com/")
    assert "card" not in created  # never sent to clients
    sent = link.seen[-1]
    assert sent.headers["authorization"].startswith("Bearer liwltoken_")
    assert b'"test":true' in sent.content.replace(b" ", b"")


@pytest.mark.anyio
async def test_expired_token_refreshes_and_credential_needs_approval(memory_store, link):
    await memory_store.save_link_wallet(
        {
            "user_id": USER_ID,
            "access_token": "old",
            "refresh_token": "liwlrefresh_old",
            "expires_at": (datetime.now(UTC) - timedelta(minutes=5)).isoformat(),
        }
    )
    with pytest.raises(ValueError):
        await agent_wallet.get_payment_credential(USER_ID, "lsrq_1", memory_store)
    assert memory_store.link_wallets[USER_ID]["access_token"] != "old"  # rotated
    link.spend["status"] = "approved"
    card = await agent_wallet.get_payment_credential(USER_ID, "lsrq_1", memory_store)
    assert card["number"] == "4242424242424242"


def test_spend_request_validation(client, memory_store, signed_in, link):
    short = {**SPEND, "context": "too short"}
    assert client.post("/agent-wallet/spend-requests", json=short).status_code == 422
    assert (
        client.post("/agent-wallet/spend-requests", json=SPEND).status_code == 404
    )  # not connected

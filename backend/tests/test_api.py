"""HTTP API: checkout, portal, entitlements, gating. Stripe calls go to stripe-mock."""

import httpx
import pytest
from conftest import USER_ID

from app.billing import auth


def test_health_reports_configuration_without_values(client, configure):
    configure(STRIPE_SECRET_KEY="sk_test_123")
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["billing"]["stripe"] is True and body["billing"]["stripe_mode"] == "test"
    assert "sk_test_123" not in str(body)


def test_catalog_is_public(client):
    products = client.get("/billing/catalog").json()
    keys = {p["lookup_key"] for product in products for p in product["prices"]}
    assert {"pro_monthly", "pro_yearly", "credits_100"} <= keys


def test_checkout_requires_a_bearer_token(client):
    response = client.post("/billing/checkout", json={"lookup_key": "pro_monthly"})
    assert response.status_code == 401


def test_missing_stripe_key_is_a_clear_503(client, memory_store, signed_in):
    response = client.post("/billing/checkout", json={"lookup_key": "pro_monthly"})
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "error": "not_configured",
        "missing": ["STRIPE_SECRET_KEY"],
    }


@pytest.mark.parametrize("lookup_key", ["pro_monthly", "credits_100"])
def test_checkout_returns_a_stripe_url(client, memory_store, signed_in, stripe_mock, lookup_key):
    response = client.post("/billing/checkout", json={"lookup_key": lookup_key})
    assert response.status_code == 200, response.text
    assert response.json()["url"].startswith("https://")
    # The Stripe customer is created once and linked to the user.
    assert memory_store.customers[USER_ID]["stripe_customer_id"].startswith("cus_")


def test_checkout_rejects_unknown_prices(client, memory_store, signed_in, stripe_mock):
    response = client.post("/billing/checkout", json={"lookup_key": "nope"})
    assert response.status_code == 404


@pytest.mark.parametrize("path", ["//evil.example", "https://evil.example", "relative", "/\\evil"])
def test_checkout_rejects_off_site_redirects(client, memory_store, signed_in, path):
    response = client.post(
        "/billing/checkout", json={"lookup_key": "pro_monthly", "success_path": path}
    )
    assert response.status_code == 422


def test_checkout_blocks_a_second_subscription(client, memory_store, signed_in, stripe_mock):
    memory_store.subscriptions["sub_1"] = {"id": "sub_1", "user_id": USER_ID, "status": "active"}
    response = client.post("/billing/checkout", json={"lookup_key": "pro_yearly"})
    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "already_subscribed"
    # One-time purchases are still allowed.
    assert client.post("/billing/checkout", json={"lookup_key": "credits_100"}).status_code == 200


def test_portal_needs_a_billing_account(client, memory_store, signed_in, stripe_mock):
    assert client.post("/billing/portal").status_code == 404
    memory_store.customers[USER_ID] = {"user_id": USER_ID, "stripe_customer_id": "cus_123"}
    response = client.post("/billing/portal", json={"return_path": "/account"})
    assert response.status_code == 200, response.text
    assert response.json()["url"].startswith("https://")


def test_me_and_require_plan(client, memory_store, signed_in):
    assert client.get("/billing/me").json() == {
        "plans": [],
        "subscription": None,
        "purchases": [],
        "plan": None,
    }
    assert client.get("/examples/pro").status_code == 402

    memory_store.subscriptions["sub_1"] = {
        "id": "sub_1",
        "user_id": USER_ID,
        "status": "trialing",
        "plan": "pro",
        "price_lookup_key": "pro_monthly",
        "cancel_at_period_end": False,
    }
    me = client.get("/billing/me").json()
    assert me["plan"] == "pro" and me["subscription"]["status"] == "trialing"
    assert client.get("/examples/pro").status_code == 200

    memory_store.subscriptions["sub_1"]["status"] = "canceled"
    assert client.get("/billing/me").json()["plan"] is None
    assert client.get("/examples/pro").status_code == 402


def test_cors_allows_the_frontend(client):
    response = client.options(
        "/billing/checkout",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    preview = client.options(
        "/billing/me",
        headers={
            "Origin": "https://supabase-hackathon-abc123-aliuraishmirani-4593s-projects.vercel.app",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert preview.status_code == 200
    blocked = client.options(
        "/billing/me",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in blocked.headers


def test_current_user_asks_supabase_auth(client, memory_store, configure, monkeypatch):
    configure(SUPABASE_URL="https://proj.supabase.co", SUPABASE_PUBLISHABLE_KEY="sb_publishable_1")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["apikey"] = request.headers["apikey"]
        if request.headers["authorization"] == "Bearer good":
            return httpx.Response(200, json={"id": USER_ID, "email": "dev@example.com"})
        return httpx.Response(401, json={"msg": "bad jwt"})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        auth.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    assert client.get("/billing/me", headers={"Authorization": "Bearer good"}).status_code == 200
    assert seen == {"url": "https://proj.supabase.co/auth/v1/user", "apikey": "sb_publishable_1"}
    assert client.get("/billing/me", headers={"Authorization": "Bearer bad"}).status_code == 401


@pytest.mark.anyio
async def test_replayed_deleted_customer_is_replaced(monkeypatch, memory_store):
    from types import SimpleNamespace

    from app.billing import routes

    created = []

    async def create_async(params, options=None):
        created.append(options)
        replayed = "true" if options else "false"
        headers = {"Idempotent-Replayed": replayed}
        return SimpleNamespace(
            id=f"cus_{len(created)}", last_response=SimpleNamespace(headers=headers)
        )

    async def retrieve_async(customer_id):
        return SimpleNamespace(id=customer_id, deleted=True)

    fake = SimpleNamespace(
        v1=SimpleNamespace(
            customers=SimpleNamespace(create_async=create_async, retrieve_async=retrieve_async)
        )
    )
    monkeypatch.setattr(routes, "get_stripe", lambda: fake)
    user = auth.User(id=USER_ID, email="dev@example.com")
    assert await routes.ensure_customer(user, memory_store) == "cus_2"
    assert created[1] is None  # the retry is a plain create, without the stale key

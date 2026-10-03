"""SupabaseStore + the billing migration + RLS, on a real Postgres via PostgREST."""

import httpx
import pytest
from conftest import OTHER_USER_ID, USER_ID, make_jwt

from app.billing.store import StoreError

pytestmark = pytest.mark.anyio

SUB = {
    "id": "sub_1",
    "user_id": USER_ID,
    "stripe_customer_id": "cus_A",
    "status": "trialing",
    "price_lookup_key": "pro_monthly",
    "plan": "pro",
    "quantity": 1,
    "current_period_end": "2026-11-03T00:00:00+00:00",
    "cancel_at_period_end": False,
    "updated_at": "2026-10-03T00:00:00+00:00",
}


async def test_customer_link_keeps_the_first_customer(pg_store):
    assert await pg_store.get_customer_id(USER_ID) is None
    assert await pg_store.save_customer(USER_ID, "cus_A", "dev@example.com") == "cus_A"
    assert await pg_store.save_customer(USER_ID, "cus_B", None) == "cus_A"
    assert await pg_store.get_customer_id(USER_ID) == "cus_A"
    assert await pg_store.user_for_customer("cus_A") == USER_ID
    assert await pg_store.user_for_customer("cus_unknown") is None


async def test_subscription_upsert_merges_by_id(pg_store):
    await pg_store.upsert_subscription(SUB)
    await pg_store.upsert_subscription({**SUB, "status": "active", "cancel_at_period_end": True})
    rows = await pg_store.list_subscriptions(USER_ID)
    assert len(rows) == 1
    assert rows[0]["status"] == "active" and rows[0]["cancel_at_period_end"] is True
    assert await pg_store.list_subscriptions(OTHER_USER_ID) == []


async def test_subscription_without_user_is_allowed(pg_store):
    await pg_store.upsert_subscription({**SUB, "id": "sub_orphan", "user_id": None})
    assert await pg_store.list_subscriptions(USER_ID) == []


async def test_purchase_status_is_constrained(pg_store):
    row = {
        "id": "cs_1",
        "user_id": USER_ID,
        "price_lookup_key": "credits_100",
        "amount_total": 500,
        "currency": "usd",
        "status": "pending",
    }
    await pg_store.upsert_purchase(row)
    await pg_store.upsert_purchase({**row, "status": "paid"})
    rows = await pg_store.list_purchases(USER_ID)
    assert [(r["id"], r["status"], r["amount_total"]) for r in rows] == [("cs_1", "paid", 500)]
    with pytest.raises(StoreError):
        await pg_store.upsert_purchase({**row, "status": "refunded-ish"})


async def test_events_are_claimed_once_and_can_be_released(pg_store):
    assert await pg_store.claim_event("evt_1", "invoice.paid") is True
    assert await pg_store.claim_event("evt_1", "invoice.paid") is False
    await pg_store.release_event("evt_1")
    assert await pg_store.claim_event("evt_1", "invoice.paid") is True


async def test_mpp_payment_reference_is_single_use(pg_store):
    row = {"reference": "pi_1", "amount": "0.50", "currency": "usd", "resource": "/x"}
    assert await pg_store.claim_mpp_payment(row) is True
    assert await pg_store.claim_mpp_payment(row) is False


async def test_rls_users_only_read_their_own_rows(pg_store, postgrest):
    await pg_store.save_customer(USER_ID, "cus_A", None)
    await pg_store.upsert_subscription(SUB)
    await pg_store.upsert_subscription(
        {**SUB, "id": "sub_2", "user_id": OTHER_USER_ID, "stripe_customer_id": "cus_B"}
    )
    await pg_store.claim_event("evt_1", "invoice.paid")

    as_user = {"Authorization": f"Bearer {make_jwt({'role': 'authenticated', 'sub': USER_ID})}"}
    async with httpx.AsyncClient(base_url=postgrest["url"]) as http:
        mine = (await http.get("/billing_subscriptions", headers=as_user)).json()
        assert [row["id"] for row in mine] == ["sub_1"]
        assert len((await http.get("/billing_customers", headers=as_user)).json()) == 1

        # Users can't write billing rows, read internal tables, or read anything anonymously.
        write = await http.post("/billing_subscriptions", headers=as_user, json={**SUB, "id": "x"})
        assert write.status_code in (401, 403)
        assert (await http.get("/billing_events", headers=as_user)).status_code in (401, 403)
        assert (await http.get("/billing_subscriptions")).status_code in (401, 403)


async def test_refunds_and_disputes_find_the_purchase_by_payment_intent(pg_store):
    row = {
        "id": "pi_1",
        "user_id": USER_ID,
        "payment_intent_id": "pi_1",
        "source": "elements",
        "amount_total": 500,
        "status": "paid",
    }
    await pg_store.upsert_purchase(row)
    assert await pg_store.update_purchase_by_payment_intent(
        "pi_1", {"status": "refunded", "amount_refunded": 500}
    )
    assert await pg_store.update_purchase_by_payment_intent("pi_unknown", {"status": "x"}) is False
    [purchase] = await pg_store.list_purchases(USER_ID)
    assert purchase["status"] == "refunded" and purchase["amount_refunded"] == 500
    with pytest.raises(StoreError):  # source is constrained
        await pg_store.upsert_purchase(
            {**row, "id": "pi_2", "payment_intent_id": "pi_2", "source": "somewhere"}
        )


async def test_link_oauth_state_is_single_use(pg_store):
    await pg_store.save_link_oauth_state("st_1", USER_ID, "verifier")
    assert (await pg_store.pop_link_oauth_state("st_1"))["code_verifier"] == "verifier"
    assert await pg_store.pop_link_oauth_state("st_1") is None


async def test_link_wallet_upserts_per_user(pg_store):
    row = {
        "user_id": USER_ID,
        "access_token": "a1",
        "refresh_token": "r1",
        "expires_at": "2026-10-03T20:00:00+00:00",
        "scope": "payment_methods.agentic",
    }
    await pg_store.save_link_wallet(row)
    await pg_store.save_link_wallet({**row, "access_token": "a2", "refresh_token": "r2"})
    wallet = await pg_store.get_link_wallet(USER_ID)
    assert (wallet["access_token"], wallet["refresh_token"]) == ("a2", "r2")
    await pg_store.delete_link_wallet(USER_ID)
    assert await pg_store.get_link_wallet(USER_ID) is None

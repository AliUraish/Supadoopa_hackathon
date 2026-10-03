"""Persistence for billing state, in the billing_* tables (see supabase/migrations).

SupabaseStore talks to PostgREST with the secret key, so it bypasses RLS: only
this backend writes billing rows; users can read their own through RLS.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Protocol

import httpx

from .config import NotConfigured, get_settings


class StoreError(RuntimeError):
    pass


class BillingStore(Protocol):
    async def get_customer_id(self, user_id: str) -> str | None: ...

    async def save_customer(self, user_id: str, customer_id: str, email: str | None) -> str:
        """Link a Stripe customer to a user. If the user already has one, keep and return it."""
        ...

    async def user_for_customer(self, customer_id: str) -> str | None: ...

    async def upsert_subscription(self, row: dict[str, Any]) -> None: ...

    async def list_subscriptions(self, user_id: str) -> list[dict[str, Any]]: ...

    async def upsert_purchase(self, row: dict[str, Any]) -> None: ...

    async def list_purchases(self, user_id: str) -> list[dict[str, Any]]: ...

    async def update_purchase_by_payment_intent(
        self, payment_intent_id: str, fields: dict[str, Any]
    ) -> bool:
        """Patch the purchase paid by this PaymentIntent. False if there is none."""
        ...

    async def save_link_oauth_state(self, state: str, user_id: str, code_verifier: str) -> None: ...

    async def pop_link_oauth_state(self, state: str) -> dict[str, Any] | None:
        """Consume a pending Link authorization (single use)."""
        ...

    async def save_link_wallet(self, row: dict[str, Any]) -> None: ...

    async def get_link_wallet(self, user_id: str) -> dict[str, Any] | None: ...

    async def delete_link_wallet(self, user_id: str) -> None: ...

    async def claim_event(self, event_id: str, event_type: str) -> bool:
        """Record a webhook event. False if it was already processed."""
        ...

    async def release_event(self, event_id: str) -> None:
        """Forget a claimed event whose processing failed, so Stripe's retry runs it."""
        ...

    async def claim_mpp_payment(self, row: dict[str, Any]) -> bool:
        """Record an MPP payment reference. False if that payment was already used."""
        ...


class SupabaseStore:
    def __init__(self, rest_url: str, key: str, *, timeout: float = 10.0) -> None:
        self._url = rest_url.rstrip("/")
        self._timeout = timeout
        self._headers = {"apikey": key}
        # Legacy service_role JWTs also go in Authorization; new sb_secret_ keys must not.
        if key.startswith("eyJ"):
            self._headers["Authorization"] = f"Bearer {key}"

    async def _request(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
        prefer: str | None = None,
    ) -> list[dict[str, Any]]:
        headers = dict(self._headers)
        if prefer:
            headers["Prefer"] = prefer
        # A client per call: safe across event loops (tests, serverless reuse).
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.request(
                method, f"{self._url}/{table}", params=params, json=json, headers=headers
            )
        if response.status_code >= 400:
            raise StoreError(f"{method} {table} -> {response.status_code}: {response.text[:300]}")
        return response.json() if response.content else []

    async def _insert_ignore(self, table: str, conflict: str, row: dict[str, Any]) -> bool:
        inserted = await self._request(
            "POST",
            table,
            params={"on_conflict": conflict},
            json=row,
            prefer="resolution=ignore-duplicates,return=representation",
        )
        return bool(inserted)

    async def _upsert(self, table: str, row: dict[str, Any], conflict: str = "id") -> None:
        await self._request(
            "POST",
            table,
            params={"on_conflict": conflict},
            json=row,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    async def get_customer_id(self, user_id: str) -> str | None:
        rows = await self._request(
            "GET",
            "billing_customers",
            params={"select": "stripe_customer_id", "user_id": f"eq.{user_id}"},
        )
        return rows[0]["stripe_customer_id"] if rows else None

    async def save_customer(self, user_id: str, customer_id: str, email: str | None) -> str:
        row = {"user_id": user_id, "stripe_customer_id": customer_id, "email": email}
        if await self._insert_ignore("billing_customers", "user_id", row):
            return customer_id
        existing = await self.get_customer_id(user_id)
        return existing or customer_id

    async def user_for_customer(self, customer_id: str) -> str | None:
        rows = await self._request(
            "GET",
            "billing_customers",
            params={"select": "user_id", "stripe_customer_id": f"eq.{customer_id}"},
        )
        return rows[0]["user_id"] if rows else None

    async def upsert_subscription(self, row: dict[str, Any]) -> None:
        await self._upsert("billing_subscriptions", row)

    async def list_subscriptions(self, user_id: str) -> list[dict[str, Any]]:
        return await self._request(
            "GET",
            "billing_subscriptions",
            params={"select": "*", "user_id": f"eq.{user_id}", "order": "updated_at.desc"},
        )

    async def upsert_purchase(self, row: dict[str, Any]) -> None:
        await self._upsert("billing_purchases", row)

    async def list_purchases(self, user_id: str) -> list[dict[str, Any]]:
        return await self._request(
            "GET",
            "billing_purchases",
            params={"select": "*", "user_id": f"eq.{user_id}", "order": "created_at.desc"},
        )

    async def update_purchase_by_payment_intent(
        self, payment_intent_id: str, fields: dict[str, Any]
    ) -> bool:
        updated = await self._request(
            "PATCH",
            "billing_purchases",
            params={"payment_intent_id": f"eq.{payment_intent_id}"},
            json=fields,
            prefer="return=representation",
        )
        return bool(updated)

    async def save_link_oauth_state(self, state: str, user_id: str, code_verifier: str) -> None:
        await self._request(
            "POST",
            "billing_link_oauth_states",
            json={"state": state, "user_id": user_id, "code_verifier": code_verifier},
        )

    async def pop_link_oauth_state(self, state: str) -> dict[str, Any] | None:
        rows = await self._request(
            "DELETE",
            "billing_link_oauth_states",
            params={"state": f"eq.{state}"},
            prefer="return=representation",
        )
        return rows[0] if rows else None

    async def save_link_wallet(self, row: dict[str, Any]) -> None:
        await self._upsert("billing_link_wallets", row, conflict="user_id")

    async def get_link_wallet(self, user_id: str) -> dict[str, Any] | None:
        rows = await self._request(
            "GET", "billing_link_wallets", params={"select": "*", "user_id": f"eq.{user_id}"}
        )
        return rows[0] if rows else None

    async def delete_link_wallet(self, user_id: str) -> None:
        await self._request("DELETE", "billing_link_wallets", params={"user_id": f"eq.{user_id}"})

    async def claim_event(self, event_id: str, event_type: str) -> bool:
        return await self._insert_ignore(
            "billing_events", "id", {"id": event_id, "type": event_type}
        )

    async def release_event(self, event_id: str) -> None:
        await self._request("DELETE", "billing_events", params={"id": f"eq.{event_id}"})

    async def claim_mpp_payment(self, row: dict[str, Any]) -> bool:
        return await self._insert_ignore("billing_mpp_payments", "reference", row)


class MemoryStore:
    """In-process store for tests and local experiments. Not shared across instances."""

    def __init__(self) -> None:
        self.customers: dict[str, dict[str, Any]] = {}
        self.subscriptions: dict[str, dict[str, Any]] = {}
        self.purchases: dict[str, dict[str, Any]] = {}
        self.events: dict[str, str] = {}
        self.mpp_payments: dict[str, dict[str, Any]] = {}
        self.link_states: dict[str, dict[str, Any]] = {}
        self.link_wallets: dict[str, dict[str, Any]] = {}

    async def get_customer_id(self, user_id: str) -> str | None:
        row = self.customers.get(user_id)
        return row["stripe_customer_id"] if row else None

    async def save_customer(self, user_id: str, customer_id: str, email: str | None) -> str:
        row = self.customers.setdefault(
            user_id, {"user_id": user_id, "stripe_customer_id": customer_id, "email": email}
        )
        return row["stripe_customer_id"]

    async def user_for_customer(self, customer_id: str) -> str | None:
        for row in self.customers.values():
            if row["stripe_customer_id"] == customer_id:
                return row["user_id"]
        return None

    async def upsert_subscription(self, row: dict[str, Any]) -> None:
        self.subscriptions[row["id"]] = {**self.subscriptions.get(row["id"], {}), **row}

    async def list_subscriptions(self, user_id: str) -> list[dict[str, Any]]:
        rows = [r for r in self.subscriptions.values() if r.get("user_id") == user_id]
        return sorted(rows, key=lambda r: r.get("updated_at") or "", reverse=True)

    async def upsert_purchase(self, row: dict[str, Any]) -> None:
        self.purchases[row["id"]] = {**self.purchases.get(row["id"], {}), **row}

    async def list_purchases(self, user_id: str) -> list[dict[str, Any]]:
        return [r for r in self.purchases.values() if r.get("user_id") == user_id]

    async def update_purchase_by_payment_intent(
        self, payment_intent_id: str, fields: dict[str, Any]
    ) -> bool:
        for row in self.purchases.values():
            if row.get("payment_intent_id") == payment_intent_id:
                row.update(fields)
                return True
        return False

    async def save_link_oauth_state(self, state: str, user_id: str, code_verifier: str) -> None:
        self.link_states[state] = {"user_id": user_id, "code_verifier": code_verifier}

    async def pop_link_oauth_state(self, state: str) -> dict[str, Any] | None:
        return self.link_states.pop(state, None)

    async def save_link_wallet(self, row: dict[str, Any]) -> None:
        self.link_wallets[row["user_id"]] = dict(row)

    async def get_link_wallet(self, user_id: str) -> dict[str, Any] | None:
        return self.link_wallets.get(user_id)

    async def delete_link_wallet(self, user_id: str) -> None:
        self.link_wallets.pop(user_id, None)

    async def claim_event(self, event_id: str, event_type: str) -> bool:
        if event_id in self.events:
            return False
        self.events[event_id] = event_type
        return True

    async def release_event(self, event_id: str) -> None:
        self.events.pop(event_id, None)

    async def claim_mpp_payment(self, row: dict[str, Any]) -> bool:
        if row["reference"] in self.mpp_payments:
            return False
        self.mpp_payments[row["reference"]] = row
        return True


@lru_cache
def _supabase_store() -> SupabaseStore:
    settings = get_settings()
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", settings.supabase_url or settings.supabase_rest_url),
            ("SUPABASE_SECRET_KEY", settings.supabase_secret_key),
        )
        if not value
    ]
    if missing:
        raise NotConfigured(*missing)
    rest_url = settings.supabase_rest_url or f"{settings.supabase_url.rstrip('/')}/rest/v1"
    return SupabaseStore(rest_url, settings.supabase_secret_key)


def get_store() -> BillingStore:
    """FastAPI dependency. Tests override it with MemoryStore."""
    return _supabase_store()

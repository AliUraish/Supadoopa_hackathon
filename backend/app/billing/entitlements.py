"""What a user has paid for, read from the billing tables the webhook keeps in sync."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException
from pydantic import BaseModel, computed_field

from .auth import User, current_user
from .store import BillingStore, get_store

# past_due keeps access while Stripe retries the card (Smart Retries / dunning).
ACTIVE_STATUSES = frozenset({"active", "trialing", "past_due"})


class SubscriptionOut(BaseModel):
    id: str
    status: str
    plan: str | None = None
    price_lookup_key: str | None = None
    quantity: int | None = None
    current_period_end: str | None = None
    cancel_at_period_end: bool = False


class PurchaseOut(BaseModel):
    id: str
    status: str
    price_lookup_key: str | None = None
    amount_total: int | None = None
    currency: str | None = None
    created_at: str | None = None


class Entitlements(BaseModel):
    plans: list[str]
    subscription: SubscriptionOut | None
    purchases: list[PurchaseOut]

    @computed_field
    @property
    def plan(self) -> str | None:
        return self.plans[0] if self.plans else None

    def has_plan(self, *plans: str) -> bool:
        return bool(set(self.plans) & set(plans))

    def has_purchased(self, lookup_key: str) -> bool:
        return any(p.price_lookup_key == lookup_key and p.status == "paid" for p in self.purchases)


def _pick(row: dict[str, Any], model: type[BaseModel]) -> dict[str, Any]:
    return {k: row.get(k) for k in model.model_fields if row.get(k) is not None}


async def get_entitlements(user_id: str, store: BillingStore) -> Entitlements:
    subscriptions = await store.list_subscriptions(user_id)
    purchases = await store.list_purchases(user_id)
    active = [s for s in subscriptions if s.get("status") in ACTIVE_STATUSES]
    # Show the live subscription if there is one, else the most recent (e.g. canceled).
    shown = (active or subscriptions or [None])[0]
    return Entitlements(
        plans=sorted({s["plan"] for s in active if s.get("plan")}),
        subscription=SubscriptionOut(**_pick(shown, SubscriptionOut)) if shown else None,
        purchases=[PurchaseOut(**_pick(p, PurchaseOut)) for p in purchases],
    )


def require_plan(*plans: str):
    """Dependency: the caller must have an active subscription to one of `plans`.

    @app.get("/reports")
    async def reports(user: User = Depends(require_plan("pro"))): ...
    """
    if not plans:
        raise ValueError("require_plan needs at least one plan")

    async def dependency(
        user: User = Depends(current_user), store: BillingStore = Depends(get_store)
    ) -> User:
        entitlements = await get_entitlements(user.id, store)
        if not entitlements.has_plan(*plans):
            raise HTTPException(
                402,
                {"error": "plan_required", "required": list(plans), "upgrade": "/billing/checkout"},
            )
        return user

    return dependency


def require_purchase(lookup_key: str):
    """Dependency: the caller must have a paid one-time purchase of `lookup_key`."""

    async def dependency(
        user: User = Depends(current_user), store: BillingStore = Depends(get_store)
    ) -> User:
        entitlements = await get_entitlements(user.id, store)
        if not entitlements.has_purchased(lookup_key):
            raise HTTPException(
                402,
                {"error": "purchase_required", "required": lookup_key, "buy": "/billing/checkout"},
            )
        return user

    return dependency

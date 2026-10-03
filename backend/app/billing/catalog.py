"""What we sell. Edit this file, then run `uv run python -m app.billing.sync`.

The app only ever refers to prices by `lookup_key` (e.g. "pro_monthly"); the sync
script creates/updates the matching Stripe products and prices, so no Stripe IDs
are hard-coded anywhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Interval = Literal["day", "week", "month", "year"]


@dataclass(frozen=True)
class Price:
    lookup_key: str
    unit_amount: int  # smallest currency unit: 1900 = $19.00
    currency: str = "usd"
    interval: Interval | None = None  # None = one-time payment
    trial_days: int | None = None  # subscriptions only, applied at Checkout

    @property
    def recurring(self) -> bool:
        return self.interval is not None


@dataclass(frozen=True)
class Product:
    id: str  # stable Stripe product ID, so sync is idempotent
    name: str
    prices: tuple[Price, ...]
    # Entitlement granted while a subscription to this product is active.
    plan: str | None = None
    description: str | None = None


PRODUCTS: tuple[Product, ...] = (
    Product(
        id="prod_pro",
        name="Pro",
        description="Everything in the app, billed monthly or yearly.",
        plan="pro",
        prices=(
            Price("pro_monthly", 1900, interval="month"),
            Price("pro_yearly", 19000, interval="year"),
        ),
    ),
    Product(
        id="prod_credits_100",
        name="100 credits",
        description="One-time credit pack.",
        prices=(Price("credits_100", 500),),
    ),
)


def get_price(lookup_key: str) -> Price | None:
    for product in PRODUCTS:
        for price in product.prices:
            if price.lookup_key == lookup_key:
                return price
    return None


def product_for(lookup_key: str) -> Product | None:
    for product in PRODUCTS:
        if any(price.lookup_key == lookup_key for price in product.prices):
            return product
    return None


def plan_for(lookup_key: str | None) -> str | None:
    product = product_for(lookup_key) if lookup_key else None
    return product.plan if product else None


def _validate() -> None:
    product_ids = [p.id for p in PRODUCTS]
    lookup_keys = [price.lookup_key for p in PRODUCTS for price in p.prices]
    if len(set(product_ids)) != len(product_ids):
        raise ValueError("catalog: duplicate product id")
    if len(set(lookup_keys)) != len(lookup_keys):
        raise ValueError("catalog: duplicate lookup_key")
    for product in PRODUCTS:
        if not product.prices:
            raise ValueError(f"catalog: {product.id} has no prices")
        if product.plan and not all(price.recurring for price in product.prices):
            raise ValueError(f"catalog: {product.id} grants a plan, so all its prices must recur")
        for price in product.prices:
            if price.unit_amount <= 0:
                raise ValueError(f"catalog: {price.lookup_key} must cost more than 0")
            if price.trial_days and not price.recurring:
                raise ValueError(f"catalog: {price.lookup_key} is one-time, trials need a plan")


_validate()

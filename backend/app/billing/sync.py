"""Make Stripe match catalog.py. Safe to re-run.

uv run python -m app.billing.sync                      # products, prices, portal config
uv run python -m app.billing.sync --payment-links      # + a shareable link per price
uv run python -m app.billing.sync --webhook-url https://api.example.com/webhooks/stripe
"""

from __future__ import annotations

import argparse
import sys

import stripe

from . import catalog
from .config import get_settings
from .routes import PORTAL_CONFIG_TAG
from .stripe_client import get_stripe
from .webhooks import HANDLED_EVENTS


def _say(status: str, what: str) -> None:
    print(f"  {status:<9} {what}")


def sync_product(client: stripe.StripeClient, product: catalog.Product) -> None:
    fields = {
        "name": product.name,
        "description": product.description or "",
        "metadata": {"plan": product.plan or ""},
    }
    try:
        existing = client.v1.products.retrieve(product.id).to_dict()
    except stripe.InvalidRequestError as error:
        if error.code != "resource_missing":
            raise
        params: dict = {"id": product.id, "name": product.name}
        if product.plan:
            params["metadata"] = {"plan": product.plan}
        if product.description:
            params["description"] = product.description
        client.v1.products.create(params)
        _say("created", f"product {product.id}")
        return

    stale = (
        not existing.get("active")
        or existing.get("name") != fields["name"]
        or (existing.get("description") or "") != fields["description"]
        or (existing.get("metadata") or {}).get("plan", "") != fields["metadata"]["plan"]
    )
    if stale:
        update = {**fields, "active": True}
        if not product.description:
            update.pop("description")  # Stripe rejects an empty description
        client.v1.products.update(product.id, update)
        _say("updated", f"product {product.id}")
    else:
        _say("ok", f"product {product.id}")


def _matches(existing: dict, product: catalog.Product, price: catalog.Price) -> bool:
    recurring = existing.get("recurring") or {}
    return (
        existing.get("product") == product.id
        and existing.get("unit_amount") == price.unit_amount
        and existing.get("currency") == price.currency
        and recurring.get("interval") == price.interval
    )


def sync_price(client: stripe.StripeClient, product: catalog.Product, price: catalog.Price) -> str:
    found = client.v1.prices.list({"lookup_keys": [price.lookup_key], "limit": 1}).data
    existing = found[0].to_dict() if found else None

    if existing and _matches(existing, product, price):
        if not existing.get("active"):
            client.v1.prices.update(existing["id"], {"active": True})
            _say("updated", f"price {price.lookup_key} (reactivated)")
        else:
            _say("ok", f"price {price.lookup_key}")
        return existing["id"]

    # Prices are immutable: create a new one and move the lookup key to it.
    params: dict = {
        "product": product.id,
        "unit_amount": price.unit_amount,
        "currency": price.currency,
        "lookup_key": price.lookup_key,
        "transfer_lookup_key": True,
    }
    if price.interval:
        params["recurring"] = {"interval": price.interval}
    created = client.v1.prices.create(params)
    if existing:
        client.v1.prices.update(existing["id"], {"active": False})
        _say("replaced", f"price {price.lookup_key} (old one archived)")
    else:
        _say("created", f"price {price.lookup_key}")
    return created.id


def sync_portal(client: stripe.StripeClient, price_ids: dict[str, str]) -> None:
    switchable = [
        {"product": p.id, "prices": [price_ids[x.lookup_key] for x in p.prices]}
        for p in catalog.PRODUCTS
        if all(x.recurring for x in p.prices)
    ]
    features: dict = {
        "customer_update": {"enabled": True, "allowed_updates": ["email", "address", "name"]},
        "invoice_history": {"enabled": True},
        "payment_method_update": {"enabled": True},
        "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
        "subscription_update": {"enabled": False},
    }
    if switchable:
        features["subscription_update"] = {
            "enabled": True,
            "default_allowed_updates": ["price"],
            "proration_behavior": "create_prorations",
            "products": switchable,
        }

    configs = client.v1.billing_portal.configurations.list({"active": True, "limit": 20}).data
    tagged = None
    for config in configs:
        data = config.to_dict()
        if (data.get("metadata") or {}).get("managed_by") == PORTAL_CONFIG_TAG:
            tagged = data["id"]
        elif data.get("is_default"):
            _say("ok", "portal: using the account's default configuration (edit it in Dashboard)")
            return
    if tagged:
        client.v1.billing_portal.configurations.update(tagged, {"features": features})
        _say("updated", f"portal configuration {tagged}")
    else:
        created = client.v1.billing_portal.configurations.create(
            {"features": features, "metadata": {"managed_by": PORTAL_CONFIG_TAG}}
        )
        _say("created", f"portal configuration {created.id}")


def sync_payment_links(client: stripe.StripeClient, price_ids: dict[str, str]) -> None:
    app_url = get_settings().public_app_url
    links = client.v1.payment_links.list({"active": True, "limit": 100}).data
    by_key = {
        (link.to_dict().get("metadata") or {}).get("lookup_key"): link.to_dict() for link in links
    }
    for lookup_key, price_id in price_ids.items():
        link = by_key.get(lookup_key)
        if link is None:
            link = client.v1.payment_links.create(
                {
                    "line_items": [{"price": price_id, "quantity": 1}],
                    "metadata": {"lookup_key": lookup_key},
                    "after_completion": {
                        "type": "redirect",
                        "redirect": {
                            "url": f"{app_url}/billing/success?session_id={{CHECKOUT_SESSION_ID}}"
                        },
                    },
                }
            ).to_dict()
            _say("created", f"payment link {lookup_key}: {link['url']}")
        else:
            _say("ok", f"payment link {lookup_key}: {link['url']}")


def sync_webhook(client: stripe.StripeClient, url: str) -> None:
    for endpoint in client.v1.webhook_endpoints.list({"limit": 100}).data:
        data = endpoint.to_dict()
        if data.get("url") == url:
            client.v1.webhook_endpoints.update(
                data["id"], {"enabled_events": list(HANDLED_EVENTS), "disabled": False}
            )
            _say("updated", f"webhook {url} (signing secret unchanged)")
            return
    created = client.v1.webhook_endpoints.create(
        {"url": url, "enabled_events": list(HANDLED_EVENTS)}
    )
    _say("created", f"webhook {url}")
    secret = created.to_dict().get("secret")
    if secret:
        print(f"\n  Set STRIPE_WEBHOOK_SECRET on the server to: {secret}\n")
    else:
        print("\n  Copy the signing secret from Dashboard > Developers > Webhooks.\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument(
        "--payment-links", action="store_true", help="create a Payment Link per price"
    )
    parser.add_argument("--webhook-url", help="create/update a webhook endpoint for this URL")
    parser.add_argument("--allow-live", action="store_true", help="permit running with a live key")
    args = parser.parse_args(argv)

    settings = get_settings()
    if not settings.stripe_secret_key:
        print("STRIPE_SECRET_KEY is not set (in the environment or the repo-root .env).")
        return 1
    if settings.stripe_live and not args.allow_live:
        print("Refusing to sync with a LIVE key. Re-run with --allow-live if you mean it.")
        return 1

    client = get_stripe()
    print(f"Syncing catalog to Stripe ({'LIVE' if settings.stripe_live else 'test mode'}):")
    price_ids: dict[str, str] = {}
    for product in catalog.PRODUCTS:
        sync_product(client, product)
        for price in product.prices:
            price_ids[price.lookup_key] = sync_price(client, product, price)
    sync_portal(client, price_ids)
    if args.payment_links:
        sync_payment_links(client, price_ids)
    if args.webhook_url:
        sync_webhook(client, args.webhook_url)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

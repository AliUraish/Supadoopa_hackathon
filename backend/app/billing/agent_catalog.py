"""Agentic Commerce Suite: publish the one-time catalog as a product feed for AI agents.

    uv run python -m app.billing.agent_catalog --site https://your.site --image https://…/p.png
    uv run python -m app.billing.agent_catalog --site … --image … --upload

Agents (ChatGPT, etc.) can then discover and buy these items. Going live also needs
Dashboard onboarding: Agentic commerce > Get started (Stripe profile, policies, tax).
Subscriptions aren't part of the retail feed.
"""

from __future__ import annotations

import argparse
import csv
import io
import sys
import time

import httpx

from . import catalog
from .config import get_settings

API_VERSION = "2026-09-30.preview"
FIELDS = (
    "id",
    "title",
    "description",
    "link",
    "brand",
    "mpn",
    "product_category",
    "image_link",
    "availability",
    "inventory_not_tracked",
    "price",
)


def feed_rows(site: str, image: str, brand: str) -> list[dict[str, str]]:
    rows = []
    for product in catalog.PRODUCTS:
        for price in product.prices:
            if price.recurring:
                continue
            rows.append(
                {
                    "id": price.lookup_key,
                    "title": product.name,
                    "description": product.description or product.name,
                    "link": f"{site.rstrip('/')}/pricing#{price.lookup_key}",
                    "brand": brand,
                    "mpn": price.lookup_key,  # our own SKU; required when there's no GTIN
                    "product_category": "Software > Digital Goods",
                    "image_link": image,
                    "availability": "in_stock",
                    "inventory_not_tracked": "true",
                    "price": f"{price.unit_amount / 100:.2f} {price.currency.upper()}",
                }
            )
    return rows


def to_csv(rows: list[dict[str, str]]) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=FIELDS)
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def upload(csv_text: str, *, timeout: float = 120.0) -> dict:
    """Create a product-feed import, upload the CSV, and wait for Stripe to process it."""
    settings = get_settings()
    headers = {
        "Authorization": f"Bearer {settings.stripe_secret_key}",
        "Stripe-Version": API_VERSION,
    }
    base = settings.stripe_api_base or "https://api.stripe.com"
    with httpx.Client(base_url=base, headers=headers, timeout=30.0) as client:
        created = client.post(
            "/v2/commerce/product_catalog/imports",
            json={"feed_type": "product", "mode": "upsert", "metadata": {"file_name": "feed.csv"}},
        )
        created.raise_for_status()
        job = created.json()
        upload_url = job["status_details"]["awaiting_upload"]["upload_url"]["url"]
        httpx.put(
            upload_url, content=csv_text.encode(), headers={"Content-Type": "text/csv"}
        ).raise_for_status()

        deadline = time.monotonic() + timeout
        while job["status"] not in ("succeeded", "succeeded_with_errors", "failed"):
            if time.monotonic() > deadline:
                break
            time.sleep(2)
            job = client.get(f"/v2/commerce/product_catalog/imports/{job['id']}").json()
    return job


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--site", help="public site URL (product links must resolve)")
    parser.add_argument("--image", required=True, help="public product image URL (JPEG/PNG)")
    parser.add_argument("--brand", default="Supabase Hackathon")
    parser.add_argument("--upload", action="store_true", help="send the feed to Stripe")
    parser.add_argument("--allow-live", action="store_true")
    args = parser.parse_args(argv)

    settings = get_settings()
    csv_text = to_csv(feed_rows(args.site or settings.public_app_url, args.image, args.brand))
    if not args.upload:
        print(csv_text, end="")
        return 0
    if not settings.stripe_secret_key:
        print("STRIPE_SECRET_KEY is not set.")
        return 1
    if settings.stripe_live and not args.allow_live:
        print("Refusing to upload with a LIVE key. Re-run with --allow-live if you mean it.")
        return 1
    job = upload(csv_text)
    print(f"import {job.get('id')}: {job.get('status')}")
    details = job.get("status_details") or {}
    if job.get("status") == "succeeded_with_errors":
        error_file = details["succeeded_with_errors"]["error_file"]["download_url"]["url"]
        print("row errors (CSV, link valid 5 min):", error_file)
    return 0 if job.get("status") in ("succeeded", "succeeded_with_errors") else 1


if __name__ == "__main__":
    sys.exit(main())

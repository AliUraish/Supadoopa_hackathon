from __future__ import annotations

from functools import lru_cache

import stripe

from .config import NotConfigured, get_settings


@lru_cache
def get_stripe() -> stripe.StripeClient:
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise NotConfigured("STRIPE_SECRET_KEY")
    return stripe.StripeClient(
        settings.stripe_secret_key,
        # httpx for both the async request path and the sync sync-script path.
        http_client=stripe.HTTPXClient(allow_sync_methods=True),
        max_network_retries=2,
        base_addresses={"api": settings.stripe_api_base} if settings.stripe_api_base else None,
    )

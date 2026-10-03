"""Catalog sync and invoices against stripe-mock (validates every request shape), plus config."""

import pytest

from app.billing import catalog, config, sync
from app.billing.invoices import InvoiceLine, send_invoice


def test_sync_runs_clean(stripe_mock, capsys):
    assert (
        sync.main(["--payment-links", "--webhook-url", "https://api.example.com/webhooks/stripe"])
        == 0
    )
    out = capsys.readouterr().out
    assert "Done." in out and "pro_monthly" in out


def test_sync_refuses_live_keys(configure, capsys):
    configure(STRIPE_SECRET_KEY="sk_live_123")
    assert sync.main([]) == 1
    assert "LIVE" in capsys.readouterr().out


def test_sync_needs_a_key(capsys):
    assert sync.main([]) == 1


@pytest.mark.anyio
async def test_send_invoice(stripe_mock):
    invoice = await send_invoice(
        email="client@example.com", lines=[InvoiceLine("Consulting", 50000)]
    )
    assert invoice["id"].startswith("in_")


def test_catalog_lookups():
    assert catalog.plan_for("pro_yearly") == "pro"
    assert catalog.plan_for("credits_100") is None
    assert catalog.get_price("credits_100").recurring is False
    assert catalog.get_price("missing") is None


def test_settings_aliases_and_placeholders(configure):
    configure(
        NEXT_PUBLIC_SUPABASE_URL="https://proj.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="eyJlegacy",
        STRIPE_SECRET_KEY="sk_test_xxx",
        STRIPE_WEBHOOK_SECRET="  ",
        APP_URL="https://app.example.com/",
    )
    settings = config.get_settings()
    assert settings.supabase_url == "https://proj.supabase.co"
    assert settings.supabase_secret_key == "eyJlegacy"
    assert settings.stripe_secret_key is None  # placeholder
    assert settings.stripe_webhook_secret is None  # blank
    assert settings.public_app_url == "https://app.example.com"

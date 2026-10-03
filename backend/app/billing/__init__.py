"""Stripe billing on Supabase, as a drop-in for any FastAPI app.

from app import billing
billing.install(app)                                   # all routes below
Depends(billing.require_plan("pro"))                   # subscription gate
Depends(billing.require_purchase("credits_100"))       # one-time purchase gate
Depends(billing.paid("0.50"))                          # MPP pay-per-call for agents
Depends(billing.current_user)                          # just the signed-in user

Routes: /billing/* (humans), /webhooks/stripe, /agents/* + /llms.txt (agents buying
from us), /agent-wallet/* (our agent buying for a user via Link).
"""

from fastapi import FastAPI
from mpp import Receipt

from . import agent_wallet, agents, gateway
from .agent_wallet import get_payment_credential
from .auth import User, current_user
from .catalog import PRODUCTS
from .config import NotConfigured, get_settings
from .entitlements import Entitlements, get_entitlements, require_plan, require_purchase
from .invoices import InvoiceLine, send_invoice
from .mpp import install_mpp, paid
from .routes import router
from .store import BillingStore, get_store
from .webhooks import webhook_router


def install(app: FastAPI) -> None:
    app.include_router(router)
    app.include_router(webhook_router)
    app.include_router(agents.router)
    app.include_router(agent_wallet.router)
    app.include_router(gateway.router)
    install_mpp(app)


def status() -> dict:
    """Which pieces are configured (never the values)."""
    s = get_settings()
    return {
        "stripe": bool(s.stripe_secret_key),
        "stripe_mode": None if not s.stripe_secret_key else ("live" if s.stripe_live else "test"),
        "webhook_secret": bool(s.stripe_webhook_secret),
        "elements": bool(s.stripe_publishable_key),
        "supabase": bool(s.supabase_url and s.supabase_secret_key),
        "mpp": bool(s.stripe_secret_key and s.stripe_profile_id),
        "link_agent_wallet": bool(s.link_client_id and s.link_client_secret),
    }


__all__ = [
    "PRODUCTS",
    "BillingStore",
    "Entitlements",
    "InvoiceLine",
    "NotConfigured",
    "Receipt",
    "User",
    "current_user",
    "get_entitlements",
    "get_payment_credential",
    "get_store",
    "install",
    "paid",
    "require_plan",
    "require_purchase",
    "send_invoice",
    "status",
]

"""Settings, read from the environment and (locally) the repo-root .env.

Each setting accepts several names so one codebase works with the Next.js-style
names in .env, Supabase Compute / Edge Function defaults (SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY) and whatever `stripe projects env --pull` writes.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ENV_FILES = (_BACKEND_DIR.parent / ".env", _BACKEND_DIR / ".env")

DEFAULT_APP_URL = "http://localhost:3000"


def _env(*names: str) -> Any:
    return Field(default=None, validation_alias=AliasChoices(*names))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILES, extra="ignore")

    stripe_secret_key: str | None = _env("STRIPE_SECRET_KEY", "STRIPE_API_KEY")
    stripe_webhook_secret: str | None = _env("STRIPE_WEBHOOK_SECRET")
    # Stripe profile ID (profile_test_… / profile_…), the MPP `networkId`.
    stripe_profile_id: str | None = _env("STRIPE_PROFILE_ID")
    # Returned to the frontend for Stripe Elements; also the Link OAuth `key`.
    stripe_publishable_key: str | None = _env(
        "STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
    )
    # Only for tests (stripe-mock).
    stripe_api_base: str | None = _env("STRIPE_API_BASE")

    # Link Agent Wallet OAuth client (issued by Stripe after the application form).
    link_client_id: str | None = _env("LINK_CLIENT_ID")
    link_client_secret: str | None = _env("LINK_CLIENT_SECRET")
    # This backend's public URL; the Link OAuth callback lives under it.
    api_url: str | None = _env("API_URL", "BILLING_API_URL")

    mpp_secret_key: str | None = _env("MPP_SECRET_KEY")
    mpp_realm: str | None = _env("MPP_REALM")
    # Shared secret for services (e.g. the Doorway gateway) that call POST /mpp/charge.
    mpp_gateway_secret: str | None = _env("MPP_GATEWAY_SECRET")

    supabase_url: str | None = _env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    supabase_secret_key: str | None = _env("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY")
    supabase_publishable_key: str | None = _env(
        "SUPABASE_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    )
    # Only for tests (a bare PostgREST instead of <SUPABASE_URL>/rest/v1).
    supabase_rest_url: str | None = _env("SUPABASE_REST_URL")

    # Doorway
    anthropic_api_key: str | None = _env("ANTHROPIC_API_KEY")
    doorway_model: str | None = _env("DOORWAY_MODEL")  # default chosen in app/doorway
    # Local demos only: dashboard actions without a token run as a shared demo user.
    doorway_demo_open: bool | None = _env("DOORWAY_DEMO_OPEN")
    # Public URL of the sandboxes' live view (default: <SUPABASE_URL>/compute/v1/doorway-sandbox/).
    doorway_live_url: str | None = _env("DOORWAY_LIVE_URL")
    # x-admin-token for demo sites' /admin/version (break/reset).
    demo_admin_token: str | None = _env("DEMO_ADMIN_TOKEN", "CLINIC_ADMIN_TOKEN")

    # Frontend origin: Checkout/portal redirect back here.
    app_url: str | None = _env("APP_URL", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SITE_URL")
    # Extra comma-separated CORS origins.
    cors_origins: str | None = _env("CORS_ORIGINS")

    @field_validator("*", mode="before")
    @classmethod
    def _unset_blanks_and_placeholders(cls, value: Any) -> Any:
        # Treat "", "sk_test_xxx" and "<project-ref>" as unset, so a half-filled
        # .env gives a clear "not configured" error instead of a 401 from Stripe.
        if isinstance(value, str):
            value = value.strip()
            if not value or value.endswith("_xxx") or ("<" in value and ">" in value):
                return None
        return value

    @property
    def public_app_url(self) -> str:
        return (self.app_url or DEFAULT_APP_URL).rstrip("/")

    @property
    def public_api_url(self) -> str:
        return (self.api_url or "http://localhost:8000").rstrip("/")

    @property
    def stripe_live(self) -> bool:
        key = self.stripe_secret_key or ""
        return key.startswith(("sk_live_", "rk_live_"))


@lru_cache
def get_settings() -> Settings:
    return Settings()


class NotConfigured(HTTPException):
    """A required setting is missing. Surfaces as 503 with the variable names."""

    def __init__(self, *names: str) -> None:
        self.names = names
        super().__init__(
            status_code=503,
            detail={"error": "not_configured", "missing": list(names)},
        )

    def __str__(self) -> str:
        return f"missing configuration: {', '.join(self.names)}"

# Backend (FastAPI): Stripe billing on Supabase

Python API for the app. Every Stripe workflow lives in [app/billing/](app/billing/) as a
drop-in package, kept deliberately simple so it's easy to change. Stripe is the source of
truth; a webhook mirrors it into Supabase `billing_*` tables
([migration](../supabase/migrations/20261003200000_billing.sql)).

## Run locally

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000           # API docs: http://localhost:8000/docs
stripe listen --forward-to localhost:8000/webhooks/stripe   # second terminal: real test webhooks
```

Settings come from the repo-root `.env` (see [.env.example](../.env.example)). Anything
missing returns `503 {"error": "not_configured", "missing": [...]}` instead of crashing;
`GET /health` shows what is configured.

## Every workflow

| Workflow | How | Status (sandbox) |
|---|---|---|
| **Checkout** (hosted page) | `POST /billing/checkout {lookup_key}` → redirect to `url` | ✅ tested on real Stripe |
| **Subscriptions** | same, with a recurring price; plan, trial, upgrades, proration | ✅ tested on real Stripe |
| **Customer portal** | `POST /billing/portal` → change plan, cancel, card, invoices | ✅ tested on real Stripe |
| **Promo codes** | `HACKATHON` (20% off) in [catalog.py](app/billing/catalog.py); Checkout shows a code field | ✅ live in sandbox |
| **Payment Links** (no code) | `uv run python -m app.billing.sync --payment-links` prints a URL per price | ✅ 3 links in sandbox |
| **Elements** (your own form) | `POST /billing/payment-intent {lookup_key}` → `client_secret` for the Payment Element | ✅ tested on real Stripe |
| **Invoices** (pay later) | `POST /billing/invoice {lookup_key}` emails a hosted invoice; `send_invoice()` for custom amounts | ✅ tested on real Stripe |
| **Refunds / disputes** | webhooks mark purchases `refunded` / `disputed` / `dispute_lost`; access is revoked | ✅ tested on real Stripe |
| **Agent buys from us** (SPT) | `POST /agents/checkout {lookup_key, shared_payment_token}` | ✅ tested on real Stripe |
| **Pay per API call** (MPP) | `Depends(billing.paid("0.50"))` → 402 challenge → agent pays → 200 + receipt | ✅ tested on real Stripe; needs `STRIPE_PROFILE_ID` for real agents |
| **Charging for another service** (Doorway gateway) | `POST /mpp/charge {amount, resource, authorization}` with `X-Gateway-Key`; relay 402s verbatim | ✅ tested on real Stripe |
| **Agent discovery** | `GET /llms.txt` lists items + paid endpoints (Stripe Directory listing) | ✅ |
| **Sell through AI agents** (ACS feed) | `uv run python -m app.billing.agent_catalog --site … --image … --upload` | ✅ feed import succeeded; going live needs Dashboard onboarding |
| **Link Agent Wallet** (our agent buys for a user) | `/agent-wallet/connect` → callback → `/agent-wallet/spend-requests` → `get_payment_credential()` | 🟡 built + unit-tested; needs `LINK_CLIENT_ID/SECRET` from Stripe |
| **Test agent tokens** | `POST /agents/test-token {amount}` mints a sandbox SPT (403 on live keys) | ✅ sandbox only |

Purchases record their `source`: `checkout`, `payment_link`, `elements`, `invoice` or `agent`.

## Sell something

1. Edit [app/billing/catalog.py](app/billing/catalog.py) (products, prices, plans, promo codes).
2. `uv run python -m app.billing.sync` creates or updates them in Stripe. It's safe to re-run and
   refuses live keys without `--allow-live`.

The app refers to prices only by `lookup_key` (`pro_monthly`, `credits_100`), never by Stripe ID.

## Use it in a feature

```python
from fastapi import Depends
from app import billing


@app.get("/reports")  # subscribers only (402 otherwise)
async def reports(user: billing.User = Depends(billing.require_plan("pro"))): ...


@app.post("/export")  # after a one-time purchase (refunds/disputes revoke it)
async def export(user=Depends(billing.require_purchase("credits_100"))): ...


@app.post("/v1/summarize")  # AI agents pay $0.50 per call via MPP
async def summarize(receipt=Depends(billing.paid("0.50"))): ...


@app.get("/me")  # any signed-in Supabase user
async def me(user=Depends(billing.current_user)): ...
```

## Frontend contract

Send the Supabase session's access token: `Authorization: Bearer <session.access_token>`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/billing/catalog` | (public) | products, prices, amounts in cents |
| POST | `/billing/checkout` | `{"lookup_key", "success_path"?, "cancel_path"?}` | `{"url"}`: redirect there |
| POST | `/billing/portal` | `{"return_path"?: "/dashboard"}` | `{"url"}` |
| POST | `/billing/payment-intent` | `{"lookup_key", "quantity"?}` (one-time) | `{"client_secret", "publishable_key"}` |
| POST | `/billing/invoice` | `{"lookup_key", "days_until_due"?}` (one-time) | `{"id", "hosted_invoice_url"}` |
| GET | `/billing/me` | | `{"plan", "plans", "subscription", "purchases"}` |
| POST | `/agent-wallet/connect` | | `{"url"}`: send the user to Link |
| GET/DELETE | `/agent-wallet` | | connection status / disconnect |
| POST | `/agent-wallet/spend-requests` | `{"amount", "merchant_name", "merchant_url", "context"}` | `{"id", "status", "approval_url"}` |

Errors: `401` bad token, `402` plan/purchase required, `404` unknown price or no billing
account, `409` already subscribed (open the portal), `400` subscription price on a one-time
endpoint, `422` bad input. Access updates once the webhook lands (usually seconds), so poll
`/billing/me` on success pages.

## Test

```bash
uv run pytest        # 79 tests; needs: brew install stripe/stripe-mock/stripe-mock postgrest
uv run ruff check .
```

Tests never touch real Stripe or Supabase: stripe-mock stands in for Stripe, a local
Postgres + PostgREST runs the real migration (with RLS), and Link is faked at the HTTP layer.

## Deploy (Vercel, when the user says so)

Use a separate Vercel project with Root Directory `backend`. FastAPI is detected from
`app/main.py`. Set the env vars from `.env` (plus `API_URL` = the deployed URL), then register
the production webhook: `uv run python -m app.billing.sync --webhook-url
https://<api-domain>/webhooks/stripe` and set the printed `STRIPE_WEBHOOK_SECRET`.

## Going live with the agent workflows

- **MPP / SPT from real agents:** create a Stripe profile (Dashboard → Stripe profile), then set
  `STRIPE_PROFILE_ID`. Try it: `npx @stripe/link-cli mpp pay http://localhost:8000/examples/paid-call -X POST -d '{}'`.
- **Link Agent Wallet:** apply for an OAuth client (Link Agent Wallet application form), then set
  `LINK_CLIENT_ID` / `LINK_CLIENT_SECRET`. Register the redirect URI `<API_URL>/agent-wallet/callback`.
- **Sell through AI agents:** Dashboard → Agentic commerce → Get started (profile, policies, tax),
  then upload the feed with a public site and image URL.
- **Stablecoin payments** (MPP over Tempo/x402) aren't wired: they need the Stablecoins and Crypto
  payment method approved in the Dashboard and pympp 0.12.

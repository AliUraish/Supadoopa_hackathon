# Backend (FastAPI): Stripe billing on Supabase

Python API for the app. Billing lives in [app/billing/](app/billing/) as a drop-in package:
Stripe Checkout, subscriptions and the customer portal, one-time purchases, invoices, and
MPP pay-per-call for AI agents. Stripe is the source of truth; a webhook mirrors it into
Supabase `billing_*` tables ([migration](../supabase/migrations/20261003200000_billing.sql)).

## Run locally

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000        # API on http://localhost:8000/docs
stripe listen --forward-to localhost:8000/webhooks/stripe   # second terminal: real test webhooks
```

Settings come from the repo-root `.env` (see [.env.example](../.env.example)). Anything
missing returns `503 {"error": "not_configured", "missing": [...]}` instead of crashing;
`GET /health` shows what is configured.

## Sell something

1. Edit [app/billing/catalog.py](app/billing/catalog.py) (products, prices, plans).
2. `uv run python -m app.billing.sync` creates or updates them in Stripe. It's safe to re-run,
   refuses live keys without `--allow-live`, and `--payment-links` prints a no-code link per price.

The app refers to prices only by `lookup_key` (`pro_monthly`, `credits_100`), never by Stripe ID.

## Use it in a feature

```python
from fastapi import Depends
from app import billing

@app.get("/reports")                       # subscribers only (402 otherwise)
async def reports(user: billing.User = Depends(billing.require_plan("pro"))): ...

@app.post("/export")                       # after a one-time purchase
async def export(user = Depends(billing.require_purchase("credits_100"))): ...

@app.post("/v1/summarize")                 # AI agents pay $0.50 per call via MPP
async def summarize(receipt = Depends(billing.paid("0.50"))): ...

@app.get("/me")                            # any signed-in Supabase user
async def me(user = Depends(billing.current_user)): ...
```

## Frontend contract

Send the Supabase session's access token: `Authorization: Bearer <session.access_token>`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/billing/catalog` | (public) | products, prices, amounts in cents |
| POST | `/billing/checkout` | `{"lookup_key": "pro_monthly", "success_path"?: "/billing/success", "cancel_path"?: "/pricing"}` | `{"url"}`, redirect the browser there |
| POST | `/billing/portal` | `{"return_path"?: "/dashboard"}` | `{"url"}` for plan changes, cancellation, card, invoices |
| GET | `/billing/me` | | `{"plan", "plans", "subscription", "purchases"}` |

Errors: `401` bad or missing token, `402` plan or purchase required, `404` unknown price or
no billing account yet, `409` already subscribed (send them to the portal), `422` off-site
redirect path. Checkout returns to `APP_URL + success_path?session_id=…`. Access updates
once the webhook lands (usually within seconds), so poll `/billing/me` on the success page.

## Test

```bash
uv run pytest        # 49 tests; needs: brew install stripe/stripe-mock/stripe-mock postgrest
uv run ruff check .
```

Tests never touch real Stripe or Supabase: stripe-mock stands in for Stripe, and a local
Postgres + PostgREST runs the real migration, including the RLS policies.

## Deploy (Vercel, when the user says so)

Use a separate Vercel project with Root Directory `backend`. FastAPI is detected from
`app/main.py`. Set the env vars from `.env`, then register the production webhook:
`uv run python -m app.billing.sync --webhook-url https://<api-domain>/webhooks/stripe` and
set the printed `STRIPE_WEBHOOK_SECRET`.

## MPP pay-per-call

Needs `STRIPE_PROFILE_ID` (create a Stripe profile: Dashboard → Settings → Business profile).
Test it with `npx @stripe/link-cli mpp pay http://localhost:8000/examples/paid-call -X POST -d '{}'`.
Each payment credential works once: replays get `409`.

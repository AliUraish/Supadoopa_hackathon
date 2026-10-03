-- Billing state mirrored from Stripe by the Python backend (backend/app/billing).
-- Only the backend writes (secret key, bypasses RLS). Signed-in users can read
-- their own customer, subscription and purchase rows.

create table public.billing_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  email text,
  created_at timestamptz not null default now()
);

create table public.billing_subscriptions (
  id text primary key, -- sub_…
  user_id uuid, -- null until the Stripe customer is linked to a user
  stripe_customer_id text not null,
  status text not null, -- Stripe status: active, trialing, past_due, canceled, …
  price_lookup_key text,
  plan text,
  quantity integer,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

create index billing_subscriptions_user_id_idx on public.billing_subscriptions (user_id);

create table public.billing_purchases (
  id text primary key, -- cs_… (Checkout / Payment Link), pi_… (Elements / agent), in_… (invoice)
  user_id uuid, -- null for anonymous agent purchases
  stripe_customer_id text,
  payment_intent_id text unique, -- ties refunds and disputes back to the purchase
  source text not null default 'checkout'
    check (source in ('checkout', 'payment_link', 'elements', 'invoice', 'agent')),
  price_lookup_key text,
  amount_total bigint,
  amount_refunded bigint not null default 0,
  currency text,
  status text not null
    check (status in ('pending', 'paid', 'failed', 'refunded', 'disputed', 'dispute_lost')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index billing_purchases_user_id_idx on public.billing_purchases (user_id);

-- Webhook idempotency: one row per processed Stripe event.
create table public.billing_events (
  id text primary key, -- evt_…
  type text not null,
  received_at timestamptz not null default now()
);

-- MPP pay-per-call receipts: stops a payment credential being replayed.
create table public.billing_mpp_payments (
  reference text primary key, -- pi_… from the MPP receipt
  amount text not null,
  currency text not null,
  resource text,
  created_at timestamptz not null default now()
);

-- Link Agent Wallet: a user's OAuth grant, so the app's agent can request spends.
-- Backend-only (no RLS policies). Consider Supabase Vault for these tokens in production.
create table public.billing_link_wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  updated_at timestamptz not null default now()
);

-- Pending Link OAuth authorizations (PKCE verifier kept server-side).
create table public.billing_link_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now()
);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_purchases enable row level security;
alter table public.billing_events enable row level security;
alter table public.billing_mpp_payments enable row level security;
alter table public.billing_link_wallets enable row level security;
alter table public.billing_link_oauth_states enable row level security;

create policy "Users read their own billing customer"
  on public.billing_customers for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users read their own subscriptions"
  on public.billing_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users read their own purchases"
  on public.billing_purchases for select to authenticated
  using ((select auth.uid()) = user_id);

-- Explicit grants, so access doesn't depend on the project's default privileges.
revoke all on
  public.billing_customers, public.billing_subscriptions, public.billing_purchases,
  public.billing_events, public.billing_mpp_payments,
  public.billing_link_wallets, public.billing_link_oauth_states
  from anon, authenticated;

grant select on
  public.billing_customers, public.billing_subscriptions, public.billing_purchases
  to authenticated;

grant select, insert, update, delete on
  public.billing_customers, public.billing_subscriptions, public.billing_purchases,
  public.billing_events, public.billing_mpp_payments,
  public.billing_link_wallets, public.billing_link_oauth_states
  to service_role;

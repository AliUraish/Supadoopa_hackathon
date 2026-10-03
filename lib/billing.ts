import "server-only";
import { createClient } from "@/lib/supabase/server";

// Client for the FastAPI billing service in backend/ (contract: backend/README.md).
// Called from the Next.js server with the user's Supabase access token, so the
// browser never handles tokens and needs no CORS.

export type CatalogPrice = {
  lookup_key: string;
  unit_amount: number; // smallest currency unit: 1900 = $19.00
  currency: string;
  interval: "day" | "week" | "month" | "year" | null; // null = one-time
  trial_days: number | null;
};

export type CatalogProduct = {
  product: string;
  name: string;
  description: string | null;
  plan: string | null;
  prices: CatalogPrice[];
};

export type Entitlements = {
  plan: string | null;
  plans: string[];
  subscription: {
    id: string;
    status: string;
    plan: string | null;
    price_lookup_key: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  purchases: {
    id: string;
    status: string;
    price_lookup_key: string | null;
    amount_total: number | null;
    currency: string | null;
    created_at: string | null;
  }[];
};

export class BillingError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`Billing API ${status}: ${code}`);
  }
}

async function billingFetch<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const base = process.env.BILLING_API_URL?.replace(/\/+$/, "");
  if (!base) throw new BillingError(503, "billing_not_configured");

  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (auth) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new BillingError(401, "not_signed_in");
    headers.set("Authorization", `Bearer ${data.session.access_token}`);
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new BillingError(503, "billing_unreachable");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    const code = typeof detail === "string" ? detail : (detail?.error ?? body?.error ?? "error");
    throw new BillingError(res.status, code);
  }
  return res.json() as Promise<T>;
}

export const getCatalog = () => billingFetch<CatalogProduct[]>("/billing/catalog", {}, false);

export const getEntitlements = () => billingFetch<Entitlements>("/billing/me");

export const createCheckout = (lookup_key: string) =>
  billingFetch<{ url: string }>("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ lookup_key }),
  });

export const createPortal = (return_path = "/dashboard") =>
  billingFetch<{ url: string }>("/billing/portal", {
    method: "POST",
    body: JSON.stringify({ return_path }),
  });

export function formatPrice({ unit_amount, currency, interval }: CatalogPrice) {
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    unit_amount / 100,
  );
  return interval ? `${amount} / ${interval}` : amount;
}

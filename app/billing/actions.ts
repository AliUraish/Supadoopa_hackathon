"use server";

import { redirect } from "next/navigation";
import { BillingError, createCheckout, createPortal } from "@/lib/billing";

export async function startCheckout(formData: FormData) {
  const lookupKey = String(formData.get("lookup_key") ?? "");
  let url: string;
  try {
    ({ url } = await createCheckout(lookupKey));
  } catch (err) {
    if (err instanceof BillingError) {
      if (err.status === 401) redirect("/login?next=/pricing");
      // Already subscribed: plan changes happen in the Stripe portal.
      if (err.code === "already_subscribed") return openPortal();
      redirect(`/pricing?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(url);
}

export async function openPortal() {
  let url: string;
  try {
    ({ url } = await createPortal("/dashboard"));
  } catch (err) {
    if (err instanceof BillingError) {
      if (err.status === 401) redirect("/login?next=/dashboard");
      redirect(`/dashboard?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(url);
}

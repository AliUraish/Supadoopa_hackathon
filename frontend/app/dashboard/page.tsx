import Link from "next/link";
import { openPortal } from "@/app/billing/actions";
import { DashboardTabs } from "@/components/dashboard/dashboard-tabs";
import { isTabId } from "@/components/dashboard/tabs";
import { MetricsBar } from "@/components/dashboard/metrics-bar";
import { Banner } from "@/components/px/ui";
import { type Entitlements, getEntitlements } from "@/lib/billing";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard" };

// Public: no login wall. Billing details only show for a real (non-anonymous) account.
export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const { tab, error } = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims && !data.claims.is_anonymous);

  let billing: Entitlements | null = null;
  if (signedIn) {
    try {
      billing = await getEntitlements();
    } catch {
      // Billing service down or not deployed yet: the dashboard still works.
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4">
      {typeof error === "string" && (
        <Banner tone="bad" title="Billing error">
          {error}
        </Banner>
      )}
      <MetricsBar />
      <DashboardTabs initialTab={isTabId(tab) ? tab : "workspace"} />
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-line pt-3 text-base text-faint">
        <span>Doorway · Supabase × Stripe hackathon · everything in Stripe test mode</span>
        {signedIn ? (
          <span className="flex items-center gap-3">
            <span>
              Plan:{" "}
              <span className="text-text">
                {!billing ? "billing unavailable" : (billing.plan ?? "Free")}
              </span>
            </span>
            {billing?.subscription || billing?.purchases.length ? (
              <form action={openPortal}>
                <button className="text-green underline">Manage billing</button>
              </form>
            ) : (
              <Link href="/pricing" className="text-green underline">
                Upgrade
              </Link>
            )}
          </span>
        ) : (
          <Link href="/login?next=/dashboard" className="hover:text-green">
            Sign in for billing (optional)
          </Link>
        )}
      </footer>
    </main>
  );
}

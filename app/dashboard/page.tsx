import Link from "next/link";
import { redirect } from "next/navigation";
import { openPortal } from "@/app/billing/actions";
import { signOut } from "@/app/login/actions";
import { type Entitlements, getEntitlements } from "@/lib/billing";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  // proxy.ts already guards /dashboard; this is a second check at render time.
  if (!data?.claims) redirect("/login?next=/dashboard");

  const { error } = await searchParams;
  let billing: Entitlements | null = null;
  try {
    billing = await getEntitlements();
  } catch {
    // Billing service down or not deployed yet: the rest of the page still works.
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <form action={signOut}>
          <button className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm">
            Sign out
          </button>
        </form>
      </header>
      <p className="text-foreground/70">
        Signed in as <span className="font-medium text-foreground">{data.claims.email}</span>
      </p>

      {typeof error === "string" && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
          Billing error: {error}
        </p>
      )}

      <section className="flex items-center justify-between rounded-lg border border-foreground/15 p-4">
        <div>
          <h2 className="font-medium">Plan</h2>
          <p className="text-sm text-foreground/70">
            {!billing
              ? "Billing unavailable"
              : billing.plan
                ? `${billing.plan}${billing.subscription?.cancel_at_period_end ? " (cancels at period end)" : ""}`
                : "Free"}
          </p>
        </div>
        {billing?.subscription || billing?.purchases.length ? (
          <form action={openPortal}>
            <button className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm">
              Manage billing
            </button>
          </form>
        ) : (
          <Link
            href="/pricing"
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
          >
            Upgrade
          </Link>
        )}
      </section>
    </main>
  );
}

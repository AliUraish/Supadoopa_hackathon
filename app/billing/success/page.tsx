import Link from "next/link";
import { type Entitlements, getEntitlements } from "@/lib/billing";
import { RefreshUntilActive } from "./refresh";

export default async function BillingSuccessPage() {
  let billing: Entitlements | null = null;
  try {
    billing = await getEntitlements();
  } catch {
    // Treat as still processing; the refresher retries.
  }

  const active = Boolean(billing?.plan || billing?.purchases.some((p) => p.status === "paid"));

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      {active ? (
        <>
          <h1 className="text-3xl font-semibold">You&apos;re all set</h1>
          <p className="text-foreground/70">
            {billing?.plan ? `Your ${billing.plan} plan is active.` : "Your purchase is complete."}
          </p>
          <Link
            href="/dashboard"
            className="rounded-md bg-foreground px-4 py-2 font-medium text-background"
          >
            Go to dashboard
          </Link>
        </>
      ) : (
        <>
          <RefreshUntilActive />
          <h1 className="text-3xl font-semibold">Confirming your payment…</h1>
          <p className="text-foreground/70">This usually takes a few seconds.</p>
          <Link href="/dashboard" className="text-sm text-foreground/70 hover:underline">
            Taking too long? Check your dashboard
          </Link>
        </>
      )}
    </main>
  );
}

import Link from "next/link";
import { ButtonLink, Spinner } from "@/components/px/ui";
import { Icon } from "@/components/px/icons";
import { type Entitlements, getEntitlements } from "@/lib/billing";
import { RefreshUntilActive } from "./refresh";

export const metadata = { title: "Payment" };

export default async function BillingSuccessPage() {
  let billing: Entitlements | null = null;
  try {
    billing = await getEntitlements();
  } catch {
    // Treat as still processing; the refresher retries.
  }

  const active = Boolean(billing?.plan || billing?.purchases.some((p) => p.status === "paid"));

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="px-panel flex w-full max-w-sm flex-col items-center gap-4 p-8 text-center">
        {active ? (
          <>
            <span className="grid size-10 place-items-center rounded-full border border-green/40 bg-green/10 text-green">
              <Icon name="verify" size={18} />
            </span>
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold tracking-tight text-text">Payment complete</h1>
              <p className="text-[13px] text-muted">
                {billing?.plan ? `Your ${billing.plan} plan is active.` : "Your purchase is complete."}
              </p>
            </div>
            <ButtonLink href="/dashboard" className="w-full">
              Go to dashboard
            </ButtonLink>
          </>
        ) : (
          <>
            <RefreshUntilActive />
            <span className="grid size-10 place-items-center rounded-full border border-line bg-panel-2 text-muted">
              <Spinner size={16} />
            </span>
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold tracking-tight text-text">Confirming your payment</h1>
              <p className="text-[13px] text-muted">Waiting for Stripe. This usually takes a few seconds.</p>
            </div>
            <Link href="/dashboard" className="text-xs text-faint hover:text-text">
              Taking too long? Check your dashboard
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

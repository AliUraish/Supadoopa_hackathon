import Link from "next/link";
import { Sprite } from "@/components/px/sprite";
import { ButtonLink, Loading, Panel } from "@/components/px/ui";
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
    <main className="flex flex-1 items-center justify-center p-6">
      <Panel
        title={active ? "Payment complete" : "Confirming payment"}
        icon={active ? "verify" : "clock"}
        tone={active ? "ok" : "warn"}
        className="w-full max-w-md"
      >
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <Sprite name="coin" scale={5} className={active ? "drop-shadow-[0_0_12px_rgba(247,208,70,0.5)]" : "animate-pulse-px"} />
          {active ? (
            <>
              <h1 className="font-pixel text-[14px] uppercase text-green px-glow">You&apos;re all set</h1>
              <p className="text-lg text-muted">
                {billing?.plan ? `Your ${billing.plan} plan is active.` : "Your purchase is complete."}
              </p>
              <ButtonLink href="/dashboard" icon="execute">
                Go to dashboard
              </ButtonLink>
            </>
          ) : (
            <>
              <RefreshUntilActive />
              <h1 className="font-pixel text-[12px] uppercase text-amber">Confirming your payment…</h1>
              <p className="text-lg text-muted">This usually takes a few seconds.</p>
              <Loading label="Waiting for Stripe" className="py-2" />
              <Link href="/dashboard" className="text-base text-muted hover:text-green">
                Taking too long? Check your dashboard
              </Link>
            </>
          )}
        </div>
      </Panel>
    </main>
  );
}

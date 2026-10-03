import Link from "next/link";
import { startCheckout } from "@/app/billing/actions";
import { Sprite } from "@/components/px/sprite";
import { Banner, Button, Empty, Panel } from "@/components/px/ui";
import { type CatalogProduct, formatPrice, getCatalog } from "@/lib/billing";

export const metadata = { title: "Pricing" };

export default async function PricingPage({ searchParams }: PageProps<"/pricing">) {
  const { error } = await searchParams;

  let products: CatalogProduct[] = [];
  let unavailable = false;
  try {
    products = await getCatalog();
  } catch {
    unavailable = true;
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-pixel text-[16px] uppercase text-green px-glow">Pricing</h1>
        <Link href="/dashboard" className="text-base text-muted hover:text-green">
          Dashboard →
        </Link>
      </header>

      {typeof error === "string" && (
        <Banner tone="bad" title="Checkout failed">
          {error}
        </Banner>
      )}
      {unavailable && (
        <Banner tone="warn" title="Billing unavailable">
          Billing is unavailable right now. Try again shortly.
        </Banner>
      )}

      <Panel title="Agents pay per call" icon="coin" tone="gold">
        <div className="flex flex-wrap items-center gap-5">
          <Sprite name="coin" scale={4} />
          <div className="min-w-0 flex-1">
            <p className="text-xl text-text">
              <span className="font-pixel text-[14px] text-gold">$0.50</span> per successful action call · reads are
              free
            </p>
            <p className="text-base text-muted">
              Agents need no plan or account: actions settle per call via Stripe MPP (HTTP 402 → pay → retry). The
              plans below are for this account. Everything runs in Stripe test mode (card 4242 4242 4242 4242).
            </p>
          </div>
        </div>
      </Panel>

      {!unavailable && products.length === 0 && <Empty icon="coin" title="No plans yet" />}

      <div className="grid gap-5 sm:grid-cols-2">
        {products.map((product) => (
          <Panel key={product.product} title={product.name} icon={product.plan ? "bolt" : "coin"}>
            <div className="flex h-full flex-col gap-4">
              {product.description && <p className="text-base text-muted">{product.description}</p>}
              <div className="mt-auto flex flex-col gap-3">
                {product.prices.map((price) => (
                  <form key={price.lookup_key} action={startCheckout}>
                    <input type="hidden" name="lookup_key" value={price.lookup_key} />
                    <Button type="submit" className="w-full">
                      {formatPrice(price)}
                      {price.trial_days ? ` · ${price.trial_days}-day trial` : ""}
                    </Button>
                  </form>
                ))}
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </main>
  );
}

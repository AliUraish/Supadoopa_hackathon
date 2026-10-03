import { startCheckout } from "@/app/(site)/billing/actions";
import { Icon } from "@/components/px/icons";
import { Banner, Button, Empty } from "@/components/px/ui";
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
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-6 py-16">
      <header className="flex max-w-2xl flex-col gap-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-faint">Pricing</p>
        <h1 className="text-3xl font-semibold tracking-tight text-text">Agents pay per call</h1>
        <p className="text-[15px] leading-relaxed text-muted">
          Agents need no plan or account: each successful action settles over Stripe MPP (HTTP 402, pay, retry) and
          reads are free. The plans below are for this account. Everything runs in Stripe test mode — use card{" "}
          <code className="font-mono text-text">4242 4242 4242 4242</code>.
        </p>
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

      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        {[
          { label: "Action call", value: "$0.50", sub: "per successful call" },
          { label: "Read call", value: "Free", sub: "list, search, check" },
          { label: "Failed call", value: "$0", sub: "never charged" },
        ].map((item) => (
          <div key={item.label} className="flex flex-col gap-1 bg-panel p-5">
            <span className="text-xs text-muted">{item.label}</span>
            <span className="font-mono text-2xl font-semibold tracking-tight text-text">{item.value}</span>
            <span className="text-xs text-faint">{item.sub}</span>
          </div>
        ))}
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-[13px] font-medium text-text">Plans</h2>
        {!unavailable && products.length === 0 && (
          <div className="px-panel">
            <Empty icon="coin" title="No plans yet" hint="Per-call pricing works without a plan." />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {products.map((product) => (
            <div key={product.product} className="px-panel flex flex-col gap-4 p-5">
              <div className="flex items-center gap-2">
                <Icon name={product.plan ? "bolt" : "coin"} size={15} className="text-muted" />
                <h3 className="text-[15px] font-semibold tracking-tight text-text">{product.name}</h3>
              </div>
              {product.description && <p className="text-[13px] text-muted">{product.description}</p>}
              <div className="mt-auto flex flex-col gap-2">
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
          ))}
        </div>
      </section>
    </main>
  );
}

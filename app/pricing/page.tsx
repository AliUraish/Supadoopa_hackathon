import Link from "next/link";
import { startCheckout } from "@/app/billing/actions";
import { type CatalogProduct, formatPrice, getCatalog } from "@/lib/billing";

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
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Pricing</h1>
        <Link href="/dashboard" className="text-sm text-foreground/70 hover:underline">
          Dashboard
        </Link>
      </header>

      {typeof error === "string" && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
          Checkout failed: {error}
        </p>
      )}
      {unavailable && (
        <p className="rounded-md bg-yellow-500/10 px-3 py-2 text-sm">
          Billing is unavailable right now. Try again shortly.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {products.map((product) => (
          <section
            key={product.product}
            className="flex flex-col gap-4 rounded-lg border border-foreground/15 p-5"
          >
            <div>
              <h2 className="text-xl font-semibold">{product.name}</h2>
              {product.description && (
                <p className="mt-1 text-sm text-foreground/70">{product.description}</p>
              )}
            </div>
            <div className="mt-auto flex flex-col gap-2">
              {product.prices.map((price) => (
                <form key={price.lookup_key} action={startCheckout}>
                  <input type="hidden" name="lookup_key" value={price.lookup_key} />
                  <button className="w-full rounded-md bg-foreground px-3 py-2 font-medium text-background">
                    {formatPrice(price)}
                    {price.trial_days ? ` · ${price.trial_days}-day trial` : ""}
                  </button>
                </form>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

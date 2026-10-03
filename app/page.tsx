import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">Supabase Hackathon</h1>
      <p className="max-w-md text-foreground/70">
        Next.js + Supabase + Stripe, deployed on Vercel. Ready for the idea.
      </p>
      <div className="flex gap-3">
        <Link
          href={signedIn ? "/dashboard" : "/login"}
          className="rounded-md bg-foreground px-4 py-2 font-medium text-background"
        >
          {signedIn ? "Go to dashboard" : "Sign in"}
        </Link>
        <Link href="/pricing" className="rounded-md border border-foreground/20 px-4 py-2 font-medium">
          Pricing
        </Link>
      </div>
    </main>
  );
}

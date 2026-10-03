// Landing: what Doorway is, on one dense screen. No login wall.

import Link from "next/link";
import { ConnectAgent } from "@/components/connect-agent";
import { DemoSites } from "@/components/landing/demo-sites";
import { Hero } from "@/components/landing/hero";
import { PayPerCall, PipelineStrip, SharedBrain, Strategies } from "@/components/landing/sections";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-4 py-6">
      <Hero />
      <PipelineStrip />
      <div className="grid gap-6 lg:grid-cols-3">
        <Strategies className="lg:col-span-2" />
        <PayPerCall />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SharedBrain />
        <DemoSites />
      </div>
      <div id="connect" className="scroll-mt-20">
        <ConnectAgent />
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-line pt-3 text-base text-faint">
        <span>Doorway · Supabase × Stripe hackathon</span>
        <nav className="flex gap-4" aria-label="Footer">
          <Link href="/dashboard" className="hover:text-green">
            Dashboard
          </Link>
          <Link href="/profile" className="hover:text-green">
            Saved details
          </Link>
          <Link href="/pricing" className="hover:text-green">
            Pricing
          </Link>
        </nav>
      </footer>
    </main>
  );
}

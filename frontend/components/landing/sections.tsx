// Landing sections below the hero: how it works, strategies, shared memory, pricing,
// live numbers, connect, footer. Static copy here; live data lives in ./live.

import Link from "next/link";
import type { ReactNode } from "react";
import { PIPELINE, STAGE_LABEL, type Stage } from "@/lib/doorway/format";
import { DoorwayLogo } from "@/components/brand/doorway-logo";
import { SupabaseLogo } from "@/components/brand/supabase-logo";
import { ConnectAgent } from "@/components/connect-agent";
import { Icon, type IconName } from "@/components/px/icons";
import { Badge, ButtonLink, StatusDot } from "@/components/px/ui";
import { LiveNumbers, StrategyGrid } from "./live";
import { Reveal } from "./reveal";

function Section({
  id,
  overline,
  title,
  lead,
  children,
}: {
  id?: string;
  overline: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-16 lg:py-20">
        <Reveal className="flex max-w-2xl flex-col gap-3">
          <p className="font-mono text-[11px] uppercase tracking-wider text-faint">{overline}</p>
          <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">{title}</h2>
          {lead && <p className="text-[15px] leading-relaxed text-muted">{lead}</p>}
        </Reveal>
        {children}
      </div>
    </section>
  );
}

// ── How it works ───────────────────────────────────────────────────────────

const STEP: Record<Stage, { icon: IconName; line: string }> = {
  request: { icon: "request", line: "An agent asks for a site and a task." },
  lookup: { icon: "lookup", line: "If a verified tool already exists, it is used." },
  discover: { icon: "discover", line: "A sandbox explores the site in Chromium." },
  observe: { icon: "observe", line: "Forms, fields and network calls are recorded." },
  compile: { icon: "compile", line: "A typed tool is built, or a known pattern reused." },
  verify: { icon: "verify", line: "A different sandbox replays it with test data." },
  publish: { icon: "publish", line: "Listed over MCP; the fastest passing strategy wins." },
  execute: { icon: "execute", line: "Agents call it like any other tool." },
  pay: { icon: "coin", line: "Actions settle per call via Stripe MPP." },
  heal: { icon: "heal", line: "When the site changes, the tool is repaired and re-verified." },
};

export function HowItWorks() {
  return (
    <Section
      id="how"
      overline="How it works"
      title="From a URL to a tool in ten steps"
      lead="Every step is a row in Postgres and an event on the dashboard, so you can watch a site become a tool."
    >
      <Reveal>
        <ol className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
          {PIPELINE.map((stage, i) => (
            <li key={stage} className="flex flex-col gap-2 bg-panel p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] tabular-nums text-faint">{String(i + 1).padStart(2, "0")}</span>
                <Icon name={STEP[stage].icon} size={15} className="text-green" />
              </div>
              <div className="text-[13px] font-medium text-text">{STAGE_LABEL[stage]}</div>
              <p className="text-xs leading-relaxed text-muted">{STEP[stage].line}</p>
            </li>
          ))}
        </ol>
      </Reveal>
    </Section>
  );
}

// ── Strategies ─────────────────────────────────────────────────────────────

export function Strategies() {
  return (
    <Section
      overline="Execution"
      title="Three ways to run a tool"
      lead="Once a tool is verified, the optimizer tries every strategy it can and keeps the fastest one that passes. If the site changes, it falls back and heals."
    >
      <Reveal>
        <StrategyGrid />
      </Reveal>
    </Section>
  );
}

// ── Shared memory ──────────────────────────────────────────────────────────

const MEMORY: { icon: IconName; title: string; table: string; line: string }[] = [
  {
    icon: "sandbox",
    title: "Job queue",
    table: "doorway_jobs",
    line: "Discover, verify, heal and optimize jobs, claimed with FOR UPDATE SKIP LOCKED. Verification always runs on a different sandbox.",
  },
  {
    icon: "pattern",
    title: "Patterns",
    table: "doorway_patterns",
    line: "A flow learned once, like listing slots and booking one, is reused on the next site that looks the same.",
  },
  {
    icon: "message",
    title: "Message board",
    table: "doorway_messages",
    line: "Sandboxes announce published tools, broken tools and requests for help.",
  },
  {
    icon: "live",
    title: "Realtime",
    table: "supabase_realtime",
    line: "Every insert and update streams to the dashboard as it happens.",
  },
];

function MemoryDiagram() {
  return (
    <div className="px-panel flex flex-col gap-5 p-5">
      <div className="grid grid-cols-[minmax(0,1fr)_48px_minmax(0,1fr)] items-center">
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-faint">
            <SupabaseLogo size={11} />
            Compute
          </span>
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-3 py-2">
              <Icon name="sandbox" size={14} className="text-muted" />
              <span className="truncate font-mono text-xs text-text">sandbox-{n}</span>
              <StatusDot tone="ok" size={6} pulse={false} className="ml-auto" />
            </div>
          ))}
        </div>
        <svg viewBox="0 0 48 120" className="h-[120px] w-full self-end" aria-hidden preserveAspectRatio="none">
          {[20, 60, 100].map((y) => (
            <path key={y} d={`M0 ${y} C24 ${y} 24 60 48 60`} fill="none" stroke="#363636" strokeWidth="1" />
          ))}
        </svg>
        <div className="flex flex-col items-center gap-3 self-end rounded-lg border border-line bg-panel-2 px-4 py-5">
          <SupabaseLogo size={34} />
          <div className="text-center">
            <div className="text-[13px] font-medium text-text">Postgres</div>
            <div className="text-xs text-faint">one shared database</div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-line pt-4">
        {MEMORY.map((m) => (
          <span key={m.table} className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted">
            {m.table}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SharedMemory() {
  return (
    <Section
      overline="Coordination"
      title="Sandboxes share one memory"
      lead="Each discovery, verification and repair runs in an isolated Chromium worker on Supabase Compute. Workers never talk to each other directly: they coordinate through one Postgres database."
    >
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <Reveal>
          <ul className="flex flex-col gap-5">
            {MEMORY.map((m) => (
              <li key={m.title} className="flex gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-panel text-green">
                  <Icon name={m.icon} size={15} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-text">{m.title}</div>
                  <p className="text-[13px] leading-relaxed text-muted">{m.line}</p>
                </div>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.08}>
          <MemoryDiagram />
        </Reveal>
      </div>
    </Section>
  );
}

// ── Pay per call ───────────────────────────────────────────────────────────

const FLOW: { dir: string; text: string; status: string; tone: "warn" | "gold" | "ok" }[] = [
  { dir: "→", text: "POST /doorway/run/sunrise-clinic/book_appointment", status: "402", tone: "warn" },
  { dir: "→", text: "Pay $0.50 with Stripe MPP", status: "paid", tone: "gold" },
  { dir: "→", text: "Retry with the payment credential", status: "200", tone: "ok" },
  { dir: "→", text: "POST /doorway/run/sunrise-clinic/list_slots", status: "free", tone: "ok" },
];

export function PayPerCall() {
  return (
    <Section
      overline="Pricing"
      title="Pay per call"
      lead="Agents need no plan and no account. Actions that change something settle per call over Stripe MPP; reads are free."
    >
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <Reveal className="flex flex-col gap-6">
          <div className="flex items-baseline gap-3">
            <span className="text-5xl font-semibold tracking-tight tabular-nums text-text">$0.50</span>
            <span className="text-[13px] text-muted">per successful action call</span>
          </div>
          <ul className="flex flex-col gap-2.5 text-[13px] text-muted">
            {[
              "Actions such as booking or reserving return HTTP 402 until paid",
              "Reads such as listing slots or searching are free",
              "Failed calls are never charged",
              "Runs in Stripe test mode",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Icon name="verify" size={14} className="mt-0.5 shrink-0 text-green" />
                {line}
              </li>
            ))}
          </ul>
          <Link href="/pricing" className="inline-flex w-fit items-center gap-1 text-[13px] text-green hover:text-green-hi">
            See plans
            <Icon name="chevron" size={14} />
          </Link>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="px-panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] font-medium text-text">
              <Icon name="coin" size={15} className="text-muted" />
              One paid call
            </div>
            <ol className="flex flex-col">
              {FLOW.map((step, i) => (
                <li
                  key={step.text}
                  className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
                >
                  <span className="font-mono text-[11px] tabular-nums text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">{step.text}</span>
                  <Badge tone={step.tone} className="font-mono normal-case">
                    {step.status}
                  </Badge>
                </li>
              ))}
            </ol>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

// ── Live numbers ───────────────────────────────────────────────────────────

export function Numbers() {
  return (
    <Section overline="Right now" title="Live numbers">
      <Reveal>
        <LiveNumbers />
      </Reveal>
    </Section>
  );
}

// ── Connect ────────────────────────────────────────────────────────────────

export function Connect() {
  return (
    <Section
      id="connect"
      overline="Connect"
      title="Connect your agent"
      lead="One MCP server for every verified tool. Add it to Claude Code, or pick individual tools to install from the dashboard."
    >
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Reveal>
          <ConnectAgent />
        </Reveal>
        <Reveal delay={0.08} className="px-panel flex flex-col gap-3 p-5">
          <div className="text-[13px] font-medium text-text">Prefer to choose?</div>
          <p className="text-[13px] text-muted">
            Browse the verified tools for each website and install only the ones your agent needs.
          </p>
          <ButtonLink href="/dashboard?tab=install" variant="ghost" icon="tool" className="w-fit">
            Install tools
          </ButtonLink>
        </Reveal>
      </div>
    </Section>
  );
}

// ── Footer ─────────────────────────────────────────────────────────────────

const FOOTER_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard?tab=install", label: "Install tools" },
  { href: "/pricing", label: "Pricing" },
  { href: "/profile", label: "Saved details" },
  { href: "/login", label: "Sign in" },
];

export function LandingFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-4 px-6 py-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link href="/" aria-label="Doorway home">
            <DoorwayLogo />
          </Link>
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-muted" aria-label="Footer">
            {FOOTER_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-text">
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 text-xs text-faint">
          <SupabaseLogo size={13} />
          <span>Supabase Postgres, Realtime and Compute</span>
          <span aria-hidden>·</span>
          <span>Stripe test mode</span>
        </div>
      </div>
    </footer>
  );
}

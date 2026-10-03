"use client";

import { useEffect, useState, useTransition } from "react";
import { exploreSite, resetDemo, setClinicVersion } from "./actions";

type Spec = { name: string; description: string; request: { method: string; path: string } };
type Tools = { version: number; specs: Spec[]; status: string; source: string; verified_at: string | null };
type DoorwayEvent = { id: number; kind: string; message: string; created_at: string };
type SiteState = { site: { status: string }; tools: Tools | null; events: DoorwayEvent[] };

const KIND_STYLE: Record<string, { dot: string; label: string }> = {
  explore: { dot: "bg-sky-500", label: "Explore" },
  verify: { dot: "bg-violet-500", label: "Verify" },
  tools: { dot: "bg-emerald-500", label: "Publish" },
  call: { dot: "bg-slate-400", label: "Agent" },
  tool: { dot: "bg-red-500", label: "Broken" },
  heal: { dot: "bg-amber-500", label: "Heal" },
  payment: { dot: "bg-teal-500", label: "Payment" },
};
const styleFor = (kind: string) =>
  kind === "verify.fail" || kind.endsWith(".fail")
    ? { dot: "bg-red-500", label: KIND_STYLE[kind.split(".")[0]]?.label ?? "Error" }
    : (KIND_STYLE[kind.split(".")[0]] ?? { dot: "bg-slate-400", label: kind });

export function DoorwayDemo({
  doorwayUrl,
  site,
  initialClinicVersion,
}: {
  doorwayUrl: string;
  site: { id: string; name: string; goal: string };
  initialClinicVersion: string | null;
}) {
  const [state, setState] = useState<SiteState | null>(null);
  const [online, setOnline] = useState(true);
  const [clinicVersion, setVersion] = useState(initialClinicVersion);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const mcpUrl = `${doorwayUrl}/s/${site.id}/mcp`;

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${doorwayUrl}/sites/${site.id}`, { cache: "no-store" });
        if (!stop) {
          setOnline(true);
          setState(res.ok ? await res.json() : null);
        }
      } catch {
        if (!stop) setOnline(false);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [doorwayUrl, site.id]);

  const run = (action: () => Promise<{ ok: boolean; error?: string; version?: string }>) =>
    startTransition(async () => {
      const r = await action();
      setError(r.ok ? null : (r.error ?? "Something went wrong"));
      if (r.version) setVersion(r.version);
    });

  const events = [...(state?.events ?? [])].reverse();
  const revenue = (state?.events ?? []).filter((e) => e.kind === "payment.paid").length * 0.5;
  const heals = (state?.events ?? []).filter((e) => e.kind === "heal.done").length;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm font-medium text-teal-600">Doorway · live demo</p>
        <h1 className="text-2xl font-semibold sm:text-3xl">Any website, agent-ready.</h1>
        <p className="text-foreground/70">
          {site.name}: buttons and forms for humans, no API. Doorway explores it, builds verified tools, serves them over MCP,
          and repairs them when the site changes.
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-2">
        <button
          disabled={pending}
          onClick={() => run(exploreSite)}
          className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          Explore the site
        </button>
        <button
          disabled={pending || clinicVersion === "v2"}
          onClick={() => run(() => setClinicVersion("v2"))}
          className="rounded-md border border-red-500/40 px-3 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
        >
          Change the site&apos;s backend
        </button>
        <button
          disabled={pending}
          onClick={() => run(resetDemo)}
          className="rounded-md border border-foreground/20 px-3 py-2 text-sm disabled:opacity-50"
        >
          Reset clinic
        </button>
        <div className="ml-auto flex flex-wrap gap-2 text-xs">
          <Badge label="Doorway" value={online ? (state?.site.status ?? "no site yet") : "offline"} tone={online ? "ok" : "bad"} />
          <Badge label="Clinic backend" value={clinicVersion ?? "unknown"} tone={clinicVersion === "v2" ? "warn" : "ok"} />
          <Badge label="Tools" value={state?.tools ? `v${state.tools.version}` : "none"} tone="ok" />
          <Badge label="Heals" value={String(heals)} tone={heals ? "warn" : "ok"} />
          <Badge label="Revenue" value={`$${revenue.toFixed(2)}`} tone="ok" />
        </div>
      </section>
      {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">Verified tools</h2>
          <code className="truncate rounded-md bg-foreground/5 px-3 py-2 text-xs" title={mcpUrl}>
            MCP: {mcpUrl}
          </code>
          {!state?.tools && <p className="text-sm text-foreground/60">No tools yet. Press &ldquo;Explore the site&rdquo;.</p>}
          {state?.tools?.specs.map((s) => (
            <article key={s.name} className="rounded-lg border border-foreground/15 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-medium">{s.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${s.request.method === "GET" ? "bg-foreground/10" : "bg-teal-500/15 text-teal-700"}`}>
                  {s.request.method === "GET" ? "Free" : "$0.50"}
                </span>
              </div>
              <p className="mt-1 text-sm text-foreground/70">{s.description}</p>
              <p className="mt-2 font-mono text-xs text-foreground/50">
                {s.request.method} {s.request.path}
              </p>
            </article>
          ))}
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="font-medium">Live feed</h2>
          <ol className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto rounded-lg border border-foreground/15 p-2">
            {events.length === 0 && <li className="p-2 text-sm text-foreground/60">Waiting for activity…</li>}
            {events.map((e) => {
              const s = styleFor(e.kind);
              return (
                <li key={e.id} className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-foreground/5">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${s.dot}`} />
                  <span className="w-16 shrink-0 text-xs font-medium text-foreground/50">{s.label}</span>
                  <span className="min-w-0 flex-1 break-words">{e.message}</span>
                  <time className="shrink-0 text-xs text-foreground/40">{new Date(e.created_at).toLocaleTimeString()}</time>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </main>
  );
}

function Badge({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "bad" }) {
  const color = tone === "ok" ? "border-foreground/15" : tone === "warn" ? "border-amber-500/50 text-amber-700" : "border-red-500/50 text-red-600";
  return (
    <span className={`rounded-md border px-2 py-1 ${color}`}>
      <span className="text-foreground/50">{label}</span> <span className="font-medium">{value}</span>
    </span>
  );
}

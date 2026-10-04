"use client";

// Sandboxes: the Compute view. A pipeline strip lit by live events, one card per Supabase
// Compute worker with its browser screen while it works, and the workflow events. Real data
// only: /doorway/sandboxes, /doorway/events and the Compute page's frames (<url>frame/<id>).

import { useEffect, useState } from "react";
import { doorway, fetchLiveView, type DoorwayEvent, type EventKind, type Sandbox } from "@/lib/doorway";
import { clockTime, eventStyle, timeAgo, TONE_COLOR } from "@/lib/doorway/format";
import { useFeed, useLive, useNow } from "@/lib/doorway/live";
import { SupabaseLogo } from "@/components/brand/supabase-logo";
import { Icon } from "@/components/px/icons";
import { Badge, Banner, Button, Empty, ErrorBanner, Panel, Skeleton, StatusDot } from "@/components/px/ui";
import { useComputeState, type ComputeSandbox } from "./compute";
import { byNaturalId, jobKindStyle } from "./shared";
import { TakeoverDialog } from "./takeover";

export function SandboxesTab({ active }: { active: boolean }) {
  const sandboxes = useLive(active ? "sandboxes" : null, () => doorway.sandboxes(), {
    tables: ["doorway_sandboxes", "doorway_jobs"],
  });
  const live = useLive("live-view", fetchLiveView, { poll: false });
  const events = useFeed<DoorwayEvent>(active ? "sandbox-activity" : null, (since) => doorway.events({ since }), {
    table: "doorway_events",
    limit: 40,
  });
  const frameBase = live.data?.url;
  const refreshMs = live.data?.refresh_ms ?? 2000;
  const compute = useComputeState(active ? live.data?.state_url : undefined, refreshMs);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const waiting = (compute?.sandboxes ?? []).filter((c) => c.needs_human);
  const takeoverSandbox = compute?.sandboxes.find((c) => c.sandbox === signingIn);
  // Sandboxes built with takeover report `needs_human` (even when null) in their state.
  const takeoverReady = Boolean(compute?.sandboxes.some((c) => "needs_human" in c));

  const list = [...(sandboxes.data ?? [])].sort((a, b) => byNaturalId(a.id, b.id));
  const busy = list.filter((s) => s.status === "busy").length;
  const online = list.filter((s) => s.status !== "offline").length;

  return (
    <div className="flex flex-col gap-4">
      <section className="px-panel flex flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 text-[13px] text-muted">
          <span className="flex items-center gap-2 font-medium text-text">
            <SupabaseLogo size={15} />
            Compute view
          </span>
          <span>
            <span className="text-text">{online}</span> online
          </span>
          <span>
            <span className="text-text">{busy}</span> working
          </span>
        </header>
        <Pipeline events={events.items} active={compute?.active} />
      </section>

      {waiting.map((c) => (
        <Banner
          key={c.sandbox}
          tone="warn"
          icon="lock"
          title={`${c.needs_human?.site_id ?? c.sandbox} needs you to sign in`}
          action={
            <Button size="sm" icon="lock" onClick={() => setSigningIn(c.sandbox)}>
              Sign in
            </Button>
          }
        >
          {c.sandbox} stopped at {c.needs_human?.reason ?? "a login wall"}. Sign in through its browser and it carries on
          building tools.
        </Banner>
      ))}

      {signingIn && frameBase && takeoverSandbox && (
        <TakeoverDialog liveUrl={frameBase} sandbox={takeoverSandbox} onClose={() => setSigningIn(null)} />
      )}

      {!sandboxes.loading && !online && (
        <Banner tone="warn" icon="sandbox" title="No sandbox is running right now">
          Tools keep answering through the Doorway API. New discover and heal jobs wait in the queue until a Supabase
          Compute sandbox starts again.
        </Banner>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        {sandboxes.loading ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-[320px] rounded-lg" />
            <Skeleton className="h-[320px] rounded-lg" />
          </div>
        ) : sandboxes.error && !list.length ? (
          <ErrorBanner error={sandboxes.error} />
        ) : !list.length ? (
          <Panel>
            <Empty
              icon="sandbox"
              title="No sandboxes yet"
              hint="Sandbox workers run on Supabase Compute. They appear here as soon as one starts."
            />
          </Panel>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {list.map((s) => (
              <SandboxCard
                key={s.id}
                sandbox={s}
                frameBase={frameBase}
                active={active}
                refreshMs={refreshMs}
                compute={compute?.sandboxes.find((c) => c.sandbox === s.id)}
                onSignIn={() => setSigningIn(s.id)}
                takeoverReady={takeoverReady}
                lastAction={events.items.find((e) => e.sandbox_id === s.id)}
              />
            ))}
          </div>
        )}
        <Activity feed={events} />
      </div>
    </div>
  );
}

// The Compute page's stage strip, lit from the real event stream.
const STAGES: { id: string; label: string; kinds: (EventKind | string)[] }[] = [
  { id: "request", label: "Request", kinds: ["request.received", "lookup.hit", "lookup.miss"] },
  { id: "discover", label: "Discover", kinds: ["discover.start", "explore.action", "explore.api"] },
  { id: "observe", label: "Observe", kinds: ["observe.capability"] },
  { id: "compile", label: "Compile", kinds: ["compile.tool", "reuse.pattern"] },
  { id: "verify", label: "Verify", kinds: ["verify.start", "verify.pass", "verify.fail"] },
  { id: "publish", label: "Publish", kinds: ["publish.tool"] },
  { id: "optimize", label: "Optimize", kinds: ["optimize.result"] },
  { id: "execute", label: "Execute", kinds: ["execute.call"] },
  { id: "pay", label: "Pay", kinds: ["payment.challenge", "payment.paid"] },
  { id: "heal", label: "Heal", kinds: ["tool.broken", "heal.start", "heal.done", "heal.fail"] },
];
const ACTIVE_FOR_MS = 15_000;

function Pipeline({ events, active }: { events: DoorwayEvent[]; active?: string[] }) {
  const now = useNow();
  const lit = new Set<string>((active ?? []).map((a) => a.toLowerCase()));
  for (const e of events) {
    if (now && now - new Date(e.created_at).getTime() > ACTIVE_FOR_MS) break;
    const stage = STAGES.find((s) => s.kinds.includes(e.kind));
    if (stage) lit.add(stage.id);
  }
  return (
    <ol className="flex flex-wrap items-center gap-1.5 px-4 py-3" aria-label="Pipeline stages">
      {STAGES.map((s, i) => {
        const on = lit.has(s.id);
        return (
          <li key={s.id} className="flex items-center gap-1.5">
            {i > 0 && <Icon name="chevron" size={12} className="text-faint" />}
            <span
              className={
                on
                  ? "animate-breathe rounded-full border border-green/40 bg-green/15 px-2.5 py-1 text-xs font-medium text-green"
                  : "rounded-full border border-line px-2.5 py-1 text-xs text-faint"
              }
            >
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SandboxCard({
  sandbox: s,
  frameBase,
  active,
  refreshMs,
  compute,
  onSignIn,
  takeoverReady,
  lastAction,
}: {
  sandbox: Sandbox;
  frameBase?: string;
  active: boolean;
  refreshMs: number;
  compute?: ComputeSandbox;
  onSignIn: () => void;
  takeoverReady: boolean;
  lastAction?: DoorwayEvent;
}) {
  const now = useNow();
  const needsSignIn = Boolean(compute?.needs_human);
  const working = s.status === "busy";
  const kind = jobKindStyle(s.job_kind);
  return (
    <section
      className="px-panel flex flex-col overflow-hidden"
      style={
        needsSignIn
          ? { borderColor: "color-mix(in srgb, var(--color-amber) 55%, transparent)" }
          : working
            ? { borderColor: "color-mix(in srgb, var(--color-green) 35%, transparent)" }
            : undefined
      }
    >
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <StatusDot status={s.status} />
        <span className="font-mono text-[13px] text-text">{s.id}</span>
        <Badge status={s.status} />
        <span className="ml-auto text-xs text-faint">heartbeat {timeAgo(s.last_heartbeat, now)}</span>
      </header>
      {compute?.url && (
        <p className="truncate border-b border-line bg-bg-2 px-4 py-1.5 font-mono text-[11px] text-muted" title={compute.url}>
          {compute.url}
        </p>
      )}
      <Screen
        key={compute?.job?.job_id ?? s.current_job_id ?? "idle"}
        sandbox={s}
        frameBase={frameBase}
        active={active}
        refreshMs={refreshMs}
        live={compute?.live}
      />
      {needsSignIn && (
        <div className="flex items-center gap-2 border-t border-amber/30 bg-amber/10 px-4 py-2.5 text-[13px] text-amber">
          <Icon name="lock" size={14} />
          <span className="min-w-0 flex-1 truncate">Needs your sign-in: {compute?.needs_human?.reason ?? "login wall"}</span>
          <Button size="sm" onClick={onSignIn}>
            Sign in
          </Button>
        </div>
      )}
      <footer className="flex items-center gap-2 px-4 py-3 text-[13px]">
        {working && s.job_kind ? (
          <>
            <Icon name={kind.icon} size={14} style={{ color: TONE_COLOR[kind.tone] }} />
            <span className="capitalize text-text">{s.job_kind}</span>
            {s.site_id && <span className="text-muted">· {s.site_id}</span>}
            {s.current_job_id !== null && <span className="font-mono text-xs text-faint">#{s.current_job_id}</span>}
          </>
        ) : (
          <span className="text-muted">{s.status === "offline" ? "Offline" : "Waiting for a job"}</span>
        )}
        <span className="ml-auto text-xs text-faint">{s.jobs_done} jobs done</span>
      </footer>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
        <Button
          size="sm"
          variant={needsSignIn ? "primary" : "ghost"}
          icon="agent"
          onClick={onSignIn}
          disabled={!takeoverReady || !(working || compute?.live || needsSignIn)}
          title={
            !takeoverReady
              ? "This sandbox build doesn't support takeover yet"
              : working || compute?.live
                ? "Control this sandbox's browser and enter your details"
                : "Available while the sandbox runs a job"
          }
        >
          Take over
        </Button>
        <span className="text-xs text-faint">
          {!takeoverReady
            ? "Takeover arrives with the next sandbox update"
            : working || compute?.live
              ? "Click, type and sign in on its screen"
              : "Available while it runs a job"}
        </span>
      </div>
      {lastAction && (
        <p className="truncate border-t border-line px-4 py-2 text-xs text-muted" title={lastAction.message}>
          <span className="font-mono text-faint">{clockTime(lastAction.created_at)}</span> · {firstLine(lastAction.message)}
        </p>
      )}
    </section>
  );
}

/** The sandbox's live browser while it works (refreshed every refresh_ms); a placeholder otherwise. */
function Screen({
  sandbox: s,
  frameBase,
  active,
  refreshMs,
  live,
}: {
  sandbox: Sandbox;
  frameBase?: string;
  active: boolean;
  refreshMs: number;
  live?: boolean;
}) {
  const busy = Boolean(live) || s.status === "busy";
  const [tick, setTick] = useState(0);
  const [fails, setFails] = useState(0);
  // Keep retrying while the job runs (the browser can take a few seconds to start); after a few
  // misses show a note instead of the screen. The card remounts this per job, so counts reset.
  const unavailable = busy && (!frameBase || fails >= 5);
  const streaming = busy && active && Boolean(frameBase);

  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [streaming, refreshMs]);

  return (
    <div className="relative aspect-[16/10] w-full bg-bg-2">
      {streaming && fails === 0 ? (
        // eslint-disable-next-line @next/next/no-img-element -- live JPEG frames from Supabase Compute
        <img
          src={`${frameBase}frame/${encodeURIComponent(s.id)}?t=${tick}`}
          alt={`Live browser of ${s.id}`}
          className="absolute inset-0 size-full object-contain"
          onError={() => setFails((n) => n + 1)}
        />
      ) : streaming ? (
        // eslint-disable-next-line @next/next/no-img-element -- retry quietly behind the placeholder
        <img
          src={`${frameBase}frame/${encodeURIComponent(s.id)}?t=${tick}`}
          alt=""
          className="absolute inset-0 size-full object-contain"
          onLoad={() => setFails(0)}
          onError={() => setFails((n) => n + 1)}
        />
      ) : null}
      {!(streaming && fails === 0) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-2 text-center">
          <Icon name="sandbox" size={22} className="text-faint" />
          <span className="text-[13px] text-muted">
            {s.status === "offline"
              ? "Offline"
              : unavailable
                ? "Live screen unavailable"
                : busy
                  ? "Starting the browser…"
                  : "Idle"}
          </span>
          <span className="max-w-xs text-xs text-faint">
            {s.status === "offline"
              ? "This sandbox stopped sending heartbeats."
              : unavailable
                ? "The sandbox is working, but its screen stream isn't reachable."
                : busy
                  ? ""
                  : "The screen appears here while this sandbox runs a job."}
          </span>
        </div>
      )}
    </div>
  );
}

function Activity({ feed }: { feed: { items: DoorwayEvent[]; error: unknown; loading: boolean } }) {
  const { items, error, loading } = feed;
  return (
    <Panel title="Workflow events" icon="live" bodyClassName="p-0 max-h-[640px] overflow-y-auto">
      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
        </div>
      ) : error && !items.length ? (
        <div className="p-4">
          <ErrorBanner error={error} />
        </div>
      ) : !items.length ? (
        <Empty icon="live" title="Nothing yet" hint="Sandbox work shows up here as it happens." />
      ) : (
        <ol>
          {items.slice(0, 40).map((e) => {
            const style = eventStyle(e.kind);
            return (
              <li key={e.id} className="flex gap-3 border-b border-line px-4 py-2.5 last:border-0">
                <Icon name={style.icon} size={14} className="mt-0.5 shrink-0" style={{ color: TONE_COLOR[style.tone] }} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[13px] leading-snug text-text" title={e.message}>
                    {firstLine(e.message)}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-faint">
                    {e.kind} · {e.sandbox_id ?? e.site_id ?? "doorway"} · {clockTime(e.created_at)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

// Errors can carry multi-line tool output (e.g. Playwright banners): keep the first line.
function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

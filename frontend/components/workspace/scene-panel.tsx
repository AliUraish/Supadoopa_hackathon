"use client";

// The 3D network panel: lazy-loads the Three.js scene (client only), pauses it when the tab is
// hidden or the panel is offscreen, and overlays a status line + legend in plain HTML.

import dynamic from "next/dynamic";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import type { DoorwayEvent, Job, Sandbox } from "@/lib/doorway";
import { timeAgo } from "@/lib/doorway/format";
import { useNow } from "@/lib/doorway/live";
import { useDashboardNav } from "@/components/dashboard/dashboard-tabs";
import { cx, StatusDot } from "@/components/px/ui";
import type { PacketSpec } from "./flow";
import type { SceneSandbox, SceneTarget } from "./network-scene";

const NetworkScene = dynamic(() => import("./network-scene").then((m) => m.NetworkScene), {
  ssr: false,
  loading: () => <SceneFallback />,
});

/** Static schematic shown while the scene loads (or if WebGL is unavailable). */
function SceneFallback({ note }: { note?: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 bg-bg">
      <svg viewBox="0 0 360 90" className="w-full max-w-[520px] text-line-2" aria-hidden>
        <g fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="10" y="30" width="60" height="36" rx="6" />
          <rect x="140" y="20" width="40" height="52" rx="4" />
          <rect x="250" y="16" width="44" height="28" rx="5" />
          <rect x="250" y="50" width="44" height="28" rx="5" />
          <path d="M70 48 Q105 30 140 46" />
          <path d="M180 46 Q215 22 250 30" />
          <path d="M180 46 Q215 62 250 64" />
        </g>
        <rect x="150" y="30" width="20" height="34" rx="2" className="fill-green/25" />
        <circle cx="314" cy="47" r="12" fill="none" stroke="currentColor" />
      </svg>
      {note && <p className="text-xs text-faint">{note}</p>}
    </div>
  );
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <SceneFallback note="3D view unavailable in this browser" /> : this.props.children;
  }
}

function useOnScreen<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, visible };
}

function StatusLine({
  sandboxes,
  jobs,
  latest,
}: {
  sandboxes: Sandbox[] | undefined;
  jobs: Job[] | undefined;
  latest: DoorwayEvent | undefined;
}) {
  const now = useNow();
  const list = sandboxes ?? [];
  const online = list.filter((s) => s.status !== "offline").length;
  const running = jobs
    ? jobs.filter((j) => j.status === "running").length
    : list.filter((s) => s.status === "busy").length;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-panel/85 px-2.5 py-1.5 text-xs text-muted backdrop-blur-sm">
      <StatusDot tone={online ? "ok" : list.length ? "bad" : "muted"} size={7} pulse={running > 0} />
      <span className="tabular-nums">
        <span className="text-text">{online}</span>/{list.length} sandboxes online
      </span>
      <span className="text-faint">·</span>
      <span className="tabular-nums">
        <span className={running ? "text-blue" : "text-text"}>{running}</span> job{running === 1 ? "" : "s"} running
      </span>
      <span className="text-faint">·</span>
      <span suppressHydrationWarning>last event {latest && now ? timeAgo(latest.created_at, now) : "—"}</span>
    </div>
  );
}

const LEGEND = [
  { label: "agent traffic", color: "var(--color-blue)" },
  { label: "sandbox work", color: "var(--color-green)" },
  { label: "patterns", color: "var(--color-violet)" },
  { label: "payment", color: "var(--color-gold)" },
];

export function ScenePanel({
  active,
  sandboxes,
  sandboxesLoading,
  jobs,
  patterns,
  latest,
  packets,
  agentBusy,
}: {
  active: boolean;
  sandboxes: Sandbox[] | undefined;
  sandboxesLoading: boolean;
  jobs: Job[] | undefined;
  patterns: number;
  latest: DoorwayEvent | undefined;
  packets: PacketSpec[];
  agentBusy: boolean;
}) {
  const { goTo } = useDashboardNav();
  const reduce = useReducedMotion();
  const { ref, visible } = useOnScreen<HTMLDivElement>();
  const [hover, setHover] = useState(false);
  const running = active && visible && !reduce;

  const sceneSandboxes: SceneSandbox[] = (sandboxes ?? []).map((s) => ({
    id: s.id,
    status: s.status,
    jobKind: s.job_kind,
    siteId: s.site_id,
  }));

  const navigate = (target: SceneTarget, siteId?: string) => {
    setHover(false);
    goTo(target, siteId ? { siteId } : undefined);
  };

  return (
    <section
      ref={ref}
      aria-label="Live network: your agent, the Doorway gateway, Supabase Compute sandboxes and Postgres"
      className={cx("relative h-[420px] overflow-hidden rounded-lg border border-line bg-bg", hover && "cursor-pointer")}
    >
      <SceneBoundary>
        <NetworkScene
          sandboxes={sceneSandboxes}
          sandboxesLoading={sandboxesLoading}
          patterns={patterns}
          packets={packets}
          agentBusy={agentBusy}
          running={running}
          onNavigate={navigate}
          onHover={setHover}
        />
      </SceneBoundary>
      <div className="pointer-events-none absolute left-3 right-3 top-3 flex">
        <StatusLine sandboxes={sandboxes} jobs={jobs} latest={latest} />
      </div>
      <ul className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint">
        {LEGEND.map((l) => (
          <li key={l.label} className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: l.color }} />
            {l.label}
          </li>
        ))}
      </ul>
      <p className="pointer-events-none absolute bottom-3 right-3 hidden text-[11px] text-faint sm:block">
        Click a sandbox or the gateway to drill in
      </p>
    </section>
  );
}

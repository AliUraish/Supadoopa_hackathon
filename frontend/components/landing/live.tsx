"use client";

// The landing's live parts: per-strategy latency from verified tools, and the numbers strip.
// Everything comes from the Doorway API; loading and failures fall back to "—".

import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { doorway } from "@/lib/doorway";
import { fmtInt, fmtMs, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useLive } from "@/lib/doorway/live";
import type { Strategy } from "@/lib/doorway/types";
import { Icon, type IconName } from "@/components/px/icons";
import { Skeleton, StatusDot } from "@/components/px/ui";

const STRATEGIES: { id: Strategy; tier: string; tone: Tone; line: string }[] = [
  { id: "api", tier: "Fastest", tone: "ok", line: "Replays the site's own JSON call, found while exploring." },
  { id: "form", tier: "Fast", tone: "info", line: "Submits the HTML form directly. No browser needed." },
  { id: "browser", tier: "Fallback", tone: "warn", line: "Clicks through the page in headless Chromium." },
];

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function Value({ children }: { children: string }) {
  return (
    <motion.span
      key={children}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="inline-block"
    >
      {children}
    </motion.span>
  );
}

export function StrategyGrid() {
  const reduce = useReducedMotion();
  const tools = useLive("landing:tools", () => doorway.tools(), { tables: ["doorway_tools"], pollMs: 10000, livePollMs: 15000 });

  const stats = useMemo(
    () =>
      STRATEGIES.map((s) => {
        const ms = (tools.data ?? [])
          .filter((t) => t.best_strategy === s.id && t.p50_ms !== null)
          .map((t) => t.p50_ms as number);
        return { ...s, p50: median(ms), count: ms.length };
      }),
    [tools.data],
  );
  const max = Math.max(1, ...stats.map((s) => s.p50 ?? 0));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
        {stats.map((s) => {
          const color = TONE_COLOR[s.tone];
          const pct = s.p50 === null ? 0 : Math.max(2, (s.p50 / max) * 100);
          return (
            <div key={s.id} className="flex flex-col gap-3 bg-panel p-5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-mono text-[13px] text-text">
                  <StatusDot tone={s.tone} size={7} />
                  {s.id}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-wider text-faint">{s.tier}</span>
              </div>
              <div className="text-2xl font-semibold tracking-tight tabular-nums text-text">
                {tools.loading ? <Skeleton className="h-8 w-20" /> : <Value>{fmtMs(s.p50)}</Value>}
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-line">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: color }}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={reduce ? { duration: 0 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
              <p className="text-xs text-faint">
                {tools.loading
                  ? "Loading measurements"
                  : s.count
                    ? `Median p50 across ${s.count} verified ${s.count === 1 ? "tool" : "tools"}`
                    : "No tools run this way yet"}
              </p>
              <p className="text-[13px] text-muted">{s.line}</p>
            </div>
          );
        })}
      </div>
      {Boolean(tools.error) && (
        <p className="text-xs text-faint">Live latencies are unavailable right now.</p>
      )}
    </div>
  );
}

export function LiveNumbers() {
  const metrics = useLive("landing:metrics", () => doorway.metrics(), {
    tables: ["doorway_tools", "doorway_runs"],
    pollMs: 10000,
    livePollMs: 15000,
  });
  const m = metrics.data;
  const items: { label: string; value: string; icon: IconName; sub: string }[] = [
    { label: "Sites", value: fmtInt(m?.sites), icon: "globe", sub: "explored by sandboxes" },
    { label: "Verified tools", value: fmtInt(m?.tools_verified), icon: "verify", sub: "replayed in a second sandbox" },
    { label: "Broker p50", value: fmtMs(m?.broker_p50_ms), icon: "bolt", sub: "agent call to result" },
    { label: "Heals", value: fmtInt(m?.heals), icon: "heal", sub: "tools repaired after a site changed" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="flex min-w-0 flex-col gap-1.5 bg-panel p-5">
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name={it.icon} size={13} />
              {it.label}
            </span>
            <span className="text-3xl font-semibold tracking-tight tabular-nums text-text">
              {metrics.loading ? <Skeleton className="h-9 w-16" /> : <Value>{it.value}</Value>}
            </span>
            <span className="truncate text-xs text-faint">{it.sub}</span>
          </div>
        ))}
      </div>
      <p className="flex items-center gap-2 text-xs text-faint">
        {metrics.error ? (
          <>
            <StatusDot tone="warn" size={6} pulse={false} />
            Live numbers are unavailable right now.
          </>
        ) : (
          <>
            <StatusDot tone="ok" size={6} pulse={!metrics.loading} />
            Live from the Doorway API
          </>
        )}
      </p>
    </div>
  );
}

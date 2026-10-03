// Small shared pieces for the Sandboxes tab: per-sandbox colours, job-kind styling,
// durations, site links and the "just arrived" flash.

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { describeError, type JobKind } from "@/lib/doorway";
import type { Tone } from "@/lib/doorway/format";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { cx } from "@/components/px/ui";

export const JOB_KIND_STYLE: Record<JobKind, { icon: IconName; tone: Tone }> = {
  discover: { icon: "discover", tone: "info" },
  verify: { icon: "verify", tone: "ok" },
  heal: { icon: "heal", tone: "warn" },
  optimize: { icon: "bolt", tone: "gold" },
  race: { icon: "race", tone: "violet" },
};

const UNKNOWN_KIND: { icon: IconName; tone: Tone } = { icon: "dot", tone: "muted" };

export function jobKindStyle(kind: string | null | undefined) {
  return (kind && JOB_KIND_STYLE[kind as JobKind]) || UNKNOWN_KIND;
}

// Each sandbox keeps one colour everywhere (cards, board, queue, patterns) so it can be
// followed across the screen. sandbox-1 → blue, sandbox-2 → violet, …
const SANDBOX_COLORS = [
  "var(--color-blue)",
  "var(--color-violet)",
  "var(--color-gold)",
  "var(--color-green-hi)",
  "#ff9ecf",
  "#6ee7f9",
];

export function sandboxColor(id: string | null | undefined): string {
  if (!id) return "var(--color-muted)";
  const m = /(\d+)\s*$/.exec(id);
  let n = 0;
  if (m) n = Number(m[1]) - 1;
  else for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const len = SANDBOX_COLORS.length;
  return SANDBOX_COLORS[((n % len) + len) % len];
}

export function byNaturalId(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** ms elapsed since `iso`; null without a timestamp or before the clock starts (SSR). */
export function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso || !now) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, now - t);
}

/** ms between two timestamps, or null if either is missing. */
export function spanMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isNaN(ms) ? null : Math.max(0, ms);
}

export function timestamp(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Compact duration: "12s", "4m 05s", "2h 03m", "3d 4h". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Ref callback: flash a row green once when it mounts (stable identity → runs once). */
export function flashOnMount(el: HTMLElement | null) {
  if (!el || typeof el.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [
      { backgroundColor: "rgba(62, 207, 142, 0.28)", boxShadow: "inset 3px 0 0 0 #3ecf8e" },
      { backgroundColor: "rgba(62, 207, 142, 0)", boxShadow: "inset 3px 0 0 0 rgba(62, 207, 142, 0)" },
    ],
    { duration: 2400, easing: "steps(8, end)" },
  );
}

export function SandboxName({
  id,
  fallback = "—",
  className,
}: {
  id: string | null | undefined;
  fallback?: string;
  className?: string;
}) {
  if (!id) return <span className={cx("text-muted", className)}>{fallback}</span>;
  return (
    <span className={className} style={{ color: sandboxColor(id) }}>
      {id}
    </span>
  );
}

export function SiteLink({ id, className }: { id: string; className?: string }) {
  return (
    <Link
      href={`/sites/${encodeURIComponent(id)}`}
      className={cx("text-muted underline-offset-2 hover:text-green hover:underline", className)}
    >
      {id}
    </Link>
  );
}

/** Framed site chip (patterns). `origin` marks the site a pattern was learned on. */
export function SiteChip({ id, origin }: { id: string; origin?: boolean }) {
  const frame = origin ? "var(--color-violet)" : "var(--color-line-2)";
  return (
    <Link
      href={`/sites/${encodeURIComponent(id)}`}
      title={origin ? `Learned on ${id}` : `Reused on ${id}`}
      className="px-frame inline-flex items-center gap-1 bg-bg-2 px-1.5 text-sm leading-6 text-text hover:text-green"
      style={{ "--frame": frame } as CSSProperties}
    >
      <PixelIcon name="site" size={9} className={origin ? "text-violet" : "text-faint"} />
      {id}
    </Link>
  );
}

/** Data is on screen but the last refresh failed. */
export function StaleNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p className={cx("flex items-center gap-1.5 text-sm text-amber", className)} role="status">
      <PixelIcon name="warn" size={10} className="shrink-0" />
      <span className="min-w-0 truncate">Showing last known state · {describeError(error)}</span>
    </p>
  );
}

/** A thin explanatory band under a panel header. */
export function PanelNote({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <p className="-mx-3 -mt-3 mb-3 flex items-start gap-2 border-b-2 border-line bg-bg-2 px-3 py-1.5 text-base leading-tight text-muted">
      {icon && <PixelIcon name={icon} size={12} className="mt-0.5 shrink-0 text-green" />}
      <span>{children}</span>
    </p>
  );
}

"use client";

// Race clocks. A running lane ticks on requestAnimationFrame from the moment it is seen
// running (re-anchored on every server `ms`), then freezes to the lane's server time.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { RaceStatus } from "@/lib/doorway";
import { cx } from "@/components/px/ui";

/** "05.21" / "1:02.50" stopwatch digits. */
export function stopwatch(ms: number | null): string {
  if (ms === null) return "--.--";
  const cs = Math.floor(ms / 10);
  const min = Math.floor(cs / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const frac = String(cs % 100).padStart(2, "0");
  return min ? `${min}:${String(sec).padStart(2, "0")}.${frac}` : `${String(sec).padStart(2, "0")}.${frac}`;
}

function useLaneClock(status: RaceStatus, serverMs: number | null, active: boolean): number | null {
  const running = status === "running";
  const [live, setLive] = useState(0);
  const anchor = useRef<{ ms: number; at: number } | null>(null);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (serverMs !== null) anchor.current = { ms: serverMs, at: performance.now() };
  }, [serverMs]);

  useEffect(() => {
    if (running && start.current === null) start.current = performance.now();
  }, [running]);

  // Tick only while the lane runs and the tab is visible.
  useEffect(() => {
    if (!running || !active) return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const a = anchor.current;
      const t = a ? a.ms + (now - a.at) : now - (start.current ?? now);
      // ~centisecond resolution, never running backwards.
      setLive((prev) => (t - prev >= 10 ? t : prev));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, active]);

  if (status === "queued") return null;
  if (running) return Math.max(live, serverMs ?? 0);
  return serverMs ?? (live || null);
}

/** Big pixel stopwatch for one lane. */
export function LaneTimer({
  status,
  ms,
  active,
  color,
  className,
}: {
  status: RaceStatus;
  ms: number | null;
  active: boolean;
  color: string;
  className?: string;
}) {
  const value = useLaneClock(status, ms, active);
  const done = status === "done" || status === "failed";
  return (
    <div className={cx("flex items-baseline gap-1.5", className)} aria-live="off">
      <span
        className={cx("font-pixel text-[28px] leading-none tabular-nums", done && "px-glow")}
        style={{ color: value === null ? "var(--color-faint)" : color }}
      >
        {stopwatch(value)}
      </span>
      <span className="font-pixel text-[10px] uppercase text-muted">s</span>
    </div>
  );
}

/** Tweens a number towards `target` so counters tick up instead of jumping. */
export function useTween(target: number, duration = 500): number {
  const [shown, setShown] = useState(0);
  const current = useRef(0);

  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / duration);
      const v = Math.round(from + (target - from) * p);
      current.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return shown;
}

export function CountUp({
  value,
  format,
  className,
  style,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  style?: CSSProperties;
}) {
  const shown = useTween(value);
  return (
    <span className={className} style={style}>
      {format(shown)}
    </span>
  );
}

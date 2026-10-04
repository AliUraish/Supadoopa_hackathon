// Formatting and status/colour vocabulary shared by every Doorway screen.

import type { EventKind, MessageKind } from "@/lib/doorway/types";
import type { IconName } from "@/components/px/icons";

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

export function fmtUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function fmtPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "3s ago". Pass `now` from useNow() so renders stay pure. */
export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso || !now) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "--:--:--";
  return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
}

/** "browser 4.1 s vs broker 84 ms" → 49 */
export function speedup(slowMs: number | null | undefined, fastMs: number | null | undefined): number | null {
  if (!slowMs || !fastMs) return null;
  return Math.max(1, Math.round(slowMs / fastMs));
}

// ── Status tones ───────────────────────────────────────────────────────────
// ok = green, bad = red, warn = amber (pulses), info = blue, muted = gray.

export type Tone = "ok" | "bad" | "warn" | "info" | "muted" | "gold" | "violet";

const TONES: Record<string, Tone> = {
  verified: "ok",
  ready: "ok",
  success: "ok",
  done: "ok",
  validated: "ok",
  passed: "ok",
  broken: "bad",
  failed: "bad",
  failure: "bad",
  offline: "bad",
  repairing: "warn",
  healing: "warn",
  discovering: "info",
  verifying: "info",
  running: "info",
  busy: "info",
  queued: "muted",
  new: "muted",
  draft: "muted",
  idle: "muted",
};

export function statusTone(status: string | null | undefined): Tone {
  return (status && TONES[status]) || "muted";
}

/** Statuses that should pulse (work in progress). */
export function isPulsing(status: string | null | undefined): boolean {
  return ["repairing", "healing", "discovering", "verifying", "running", "busy"].includes(status ?? "");
}

// CSS colour for a tone (theme tokens from globals.css).
export const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--color-green)",
  bad: "var(--color-red)",
  warn: "var(--color-amber)",
  info: "var(--color-blue)",
  muted: "var(--color-muted)",
  gold: "var(--color-gold)",
  violet: "var(--color-violet)",
};

// ── Pipeline + event families ──────────────────────────────────────────────

export const PIPELINE = [
  "request",
  "lookup",
  "discover",
  "observe",
  "compile",
  "verify",
  "publish",
  "execute",
  "pay",
  "heal",
] as const;
export type Stage = (typeof PIPELINE)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  request: "Request",
  lookup: "Lookup",
  discover: "Discover",
  observe: "Observe",
  compile: "Compile",
  verify: "Verify",
  publish: "Publish",
  execute: "Execute",
  pay: "Pay",
  heal: "Heal",
};

export interface EventStyle {
  stage: Stage | null;
  icon: IconName;
  tone: Tone;
  label: string;
}

const FAMILY: Record<string, Omit<EventStyle, "label">> = {
  request: { stage: "request", icon: "request", tone: "info" },
  lookup: { stage: "lookup", icon: "lookup", tone: "info" },
  discover: { stage: "discover", icon: "discover", tone: "info" },
  explore: { stage: "discover", icon: "discover", tone: "info" },
  observe: { stage: "observe", icon: "observe", tone: "violet" },
  compile: { stage: "compile", icon: "compile", tone: "violet" },
  reuse: { stage: "compile", icon: "pattern", tone: "violet" },
  verify: { stage: "verify", icon: "verify", tone: "ok" },
  publish: { stage: "publish", icon: "publish", tone: "ok" },
  optimize: { stage: "publish", icon: "bolt", tone: "ok" },
  execute: { stage: "execute", icon: "execute", tone: "ok" },
  payment: { stage: "pay", icon: "coin", tone: "gold" },
  tool: { stage: "heal", icon: "broken", tone: "bad" },
  heal: { stage: "heal", icon: "heal", tone: "warn" },
  sandbox: { stage: null, icon: "sandbox", tone: "muted" },
  human: { stage: "discover", icon: "lock", tone: "warn" },
};

/** Icon, colour and pipeline stage for an event kind like "verify.pass". */
export function eventStyle(kind: EventKind | string): EventStyle {
  const [family, action = ""] = kind.split(".");
  const base = FAMILY[family] ?? { stage: null, icon: "dot" as IconName, tone: "muted" as Tone };
  let tone = base.tone;
  if (action === "fail" || action === "offline") tone = "bad";
  if (kind === "heal.done" || kind === "human.done") tone = "ok";
  if (kind === "lookup.miss") tone = "warn";
  if (kind === "sandbox.online") tone = "ok";
  return { ...base, tone, label: kind };
}

export function stageForEvent(kind: EventKind | string): Stage | null {
  return eventStyle(kind).stage;
}

export const MESSAGE_STYLE: Record<MessageKind, { icon: IconName; tone: Tone; label: string }> = {
  hello: { icon: "sandbox", tone: "muted", label: "hello" },
  tool_published: { icon: "publish", tone: "ok", label: "tool_published" },
  pattern_published: { icon: "pattern", tone: "violet", label: "pattern_published" },
  need_tool: { icon: "lookup", tone: "info", label: "need_tool" },
  validated: { icon: "verify", tone: "ok", label: "validated" },
  broken: { icon: "broken", tone: "bad", label: "broken" },
};

/** One-line summary of a message body, e.g. "slot_booking · pattern #4". */
export function messageSummary(body: Record<string, unknown> | null | undefined): string {
  if (!body) return "";
  const parts: string[] = [];
  for (const key of ["name", "tool", "pattern", "site_id", "version", "text", "reason"]) {
    const v = body[key];
    if (v !== undefined && v !== null && v !== "") parts.push(String(v));
  }
  if (!parts.length) {
    const first = Object.entries(body).slice(0, 2);
    return first.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ");
  }
  return parts.join(" · ");
}

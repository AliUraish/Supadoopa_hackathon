// Pure helpers for the workspace: which wire an event travels, how a broker result reads,
// and which events/messages belong to one agent request.

import type { IconName } from "@/components/px/icons";
import type { Stage, Tone } from "@/lib/doorway/format";
import { eventStyle, fmtUsd, MESSAGE_STYLE } from "@/lib/doorway/format";
import type { AgentRequest, DoorwayEvent, Message, Tool } from "@/lib/doorway/types";

export const STAGE_ICON: Record<Stage, IconName> = {
  request: "request",
  lookup: "lookup",
  discover: "discover",
  observe: "observe",
  compile: "compile",
  verify: "verify",
  publish: "publish",
  execute: "execute",
  pay: "coin",
  heal: "heal",
};

/** Milliseconds since an ISO timestamp; `now` comes from useNow() so renders stay pure. */
export function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso || !now) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, now - t);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── Wires and packets ──────────────────────────────────────────────────────
// Route ids: "agent>door", "door>sb:<id>", "sb:<id>>db". `reverse` runs a packet backwards.

export interface PacketSpec {
  key: string;
  route: string;
  reverse: boolean;
  tone: Tone;
  coin?: boolean;
}

const INTO_SANDBOX = new Set(["discover", "explore", "observe"]);
const SANDBOX_WORK = new Set(["verify", "heal", "optimize", "compile", "tool"]);

export function packetForEvent(e: DoorwayEvent): PacketSpec | null {
  const [family, action = ""] = e.kind.split(".");
  const tone = eventStyle(e.kind).tone;
  const key = `e${e.id}`;
  const sb = e.sandbox_id;
  if (family === "request" || family === "lookup" || family === "execute") {
    return { key, route: "agent>door", reverse: false, tone };
  }
  if (family === "payment") {
    // The 402 challenge goes back to the agent; the paid coin comes in.
    return e.kind === "payment.paid"
      ? { key, route: "agent>door", reverse: false, tone: "gold", coin: true }
      : { key, route: "agent>door", reverse: true, tone: "gold" };
  }
  if (!sb) return null;
  if (INTO_SANDBOX.has(family)) return { key, route: `door>sb:${sb}`, reverse: false, tone };
  if (SANDBOX_WORK.has(family)) {
    // Jobs go in, results come back out.
    return { key, route: `door>sb:${sb}`, reverse: action !== "start", tone };
  }
  if (family === "publish") return { key, route: `sb:${sb}>db`, reverse: false, tone };
  if (family === "reuse") return { key, route: `sb:${sb}>db`, reverse: true, tone: "violet" };
  return null;
}

export function packetForMessage(m: Message): PacketSpec | null {
  const key = `m${m.id}`;
  const tone = (MESSAGE_STYLE[m.kind] ?? MESSAGE_STYLE.hello).tone;
  if (m.kind === "pattern_published" || m.kind === "tool_published") {
    return { key, route: `sb:${m.from_sandbox}>db`, reverse: false, tone };
  }
  if (m.kind === "need_tool") return { key, route: `door>sb:${m.from_sandbox}`, reverse: true, tone: "info" };
  return null;
}

/** Pattern id an event or message is about, if any (flashes its memory card). */
export function patternIdOf(row: { data?: Record<string, unknown> | null; body?: Record<string, unknown> | null }): number | null {
  const bag = row.data ?? row.body ?? null;
  const id = bag?.pattern_id;
  return typeof id === "number" ? id : null;
}

// ── Broker results ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

const LABEL_KEYS = ["title", "name", "label", "time", "slot", "start", "date", "when", "author", "id"];

function itemLabel(v: unknown): string {
  if (isScalar(v)) return String(v);
  if (Array.isArray(v)) return `${v.length} items`;
  if (!isObj(v)) return String(v);
  const picked = LABEL_KEYS.filter((k) => isScalar(v[k]) && v[k] !== null && v[k] !== "").slice(0, 2);
  const keys = picked.length ? picked : Object.keys(v).filter((k) => isScalar(v[k])).slice(0, 2);
  return keys.map((k) => String(v[k])).join(" · ") || "{…}";
}

function listLines(name: string | null, list: unknown[]): string[] {
  const head = `${list.length} ${name ?? (list.length === 1 ? "result" : "results")}`;
  return [head, ...list.slice(0, 3).map((v) => `· ${truncate(itemLabel(v), 70)}`)];
}

const HIDDEN_KEYS = new Set(["paymentLink", "payment_required", "instructions", "body", "method"]);

/** A few readable lines for any result payload (raw JSON stays one click away). */
export function summarizeResult(data: unknown): string[] {
  if (data === undefined || data === null) return [];
  if (isScalar(data)) return [truncate(String(data), 160)];
  if (Array.isArray(data)) return listLines(null, data);
  if (!isObj(data)) return [];
  const lines: string[] = [];
  const entries = Object.entries(data).filter(([k]) => !HIDDEN_KEYS.has(k));
  for (const [k, v] of entries) {
    if (lines.length >= 4) break;
    if (isScalar(v) && v !== null && v !== "") lines.push(`${k.replace(/_/g, " ")}: ${truncate(String(v), 70)}`);
  }
  const list = entries.find(([, v]) => Array.isArray(v));
  if (list) lines.push(...listLines(list[0].replace(/_/g, " "), list[1] as unknown[]));
  else {
    const nested = entries.find(([, v]) => isObj(v));
    if (nested && lines.length < 4) lines.push(`${nested[0].replace(/_/g, " ")}: ${truncate(itemLabel(nested[1]), 70)}`);
  }
  return lines;
}

export type PaymentInfo =
  | { kind: "paid"; amount: string; reference: string }
  | { kind: "required"; amount: string; link: string };

/** "$0.50 paid · pi_test_…" or "Payment required: $0.50 → <paymentLink>". */
export function paymentInfo(req: AgentRequest | undefined, tool: Tool | null | undefined): PaymentInfo | null {
  if (!req) return null;
  const cents = tool?.price_cents ?? null;
  if (req.run?.paid_reference) {
    return { kind: "paid", amount: fmtUsd(cents ?? 50), reference: req.run.paid_reference };
  }
  const r = req.result;
  if (isObj(r) && typeof r.paymentLink === "string") {
    let amount = fmtUsd(cents ?? 50);
    if (typeof r.amount_cents === "number") amount = fmtUsd(r.amount_cents);
    else if (typeof r.amount === "string") amount = r.amount.replace(/^(\d+(?:\.\d+)?) USD$/, "$$$1");
    return { kind: "required", amount, link: r.paymentLink };
  }
  return null;
}

// ── Which events and board messages belong to one request ──────────────────

export interface RequestWindow {
  siteId: string | null;
  requestId?: string;
  fromEventId: number;
  toEventId?: number;
  fromMessageId: number;
  toMessageId?: number;
}

export type TimelineItem =
  | { type: "event"; key: string; at: number; event: DoorwayEvent }
  | { type: "question"; key: string; at: number; message: Message };

function mentionsSite(body: Record<string, unknown> | null, siteId: string): boolean {
  if (!body) return false;
  if (body.site_id === siteId) return true;
  return JSON.stringify(body).includes(siteId);
}

/**
 * Pipeline events for the request's site after it was sent (stops at another agent's
 * request on the same site), plus sandboxes' need_tool questions about that site.
 * `events`/`messages` are newest first, as useFeed returns them.
 */
export function timelineFor(w: RequestWindow, events: DoorwayEvent[], messages: Message[]): TimelineItem[] {
  const siteId = w.siteId;
  if (!siteId) return [];
  const items: TimelineItem[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.id <= w.fromEventId || e.site_id !== siteId) continue;
    if (w.toEventId !== undefined && e.id > w.toEventId) break;
    const rid = e.data?.request_id;
    if (e.kind === "request.received" && w.requestId && typeof rid === "string" && rid !== w.requestId) break;
    if (e.kind.startsWith("sandbox.")) continue;
    items.push({ type: "event", key: `e${e.id}`, at: Date.parse(e.created_at) || 0, event: e });
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== "need_tool" || m.id <= w.fromMessageId) continue;
    if (w.toMessageId !== undefined && m.id > w.toMessageId) break;
    if (mentionsSite(m.body, siteId)) {
      items.push({ type: "question", key: `m${m.id}`, at: Date.parse(m.created_at) || 0, message: m });
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

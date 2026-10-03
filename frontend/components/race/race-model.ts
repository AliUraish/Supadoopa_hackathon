// Race data helpers: normalise lanes (a fresh race row has `browser: {}`), pick a winner,
// summarise a race for the session history, and the per-site task presets.

import type { Race, RaceLane, RaceLogEntry, RaceStatus, Site } from "@/lib/doorway";
import { speedup } from "@/lib/doorway/format";

export type LaneId = "browser" | "broker";

export interface Lane extends RaceLane {
  /** Number of the latest logged step (0 before the first one). */
  current: number;
  /** Planned/final step count when known ("step 4/7"), else null. */
  total: number | null;
  error: string | null;
}

export function isFinished(status: RaceStatus | null | undefined): boolean {
  return status === "done" || status === "failed";
}

const STATUSES: readonly RaceStatus[] = ["queued", "running", "done", "failed"];

function asStatus(value: unknown): RaceStatus | null {
  return STATUSES.includes(value as RaceStatus) ? (value as RaceStatus) : null;
}

function asLogEntry(value: unknown, index: number): RaceLogEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Record<keyof RaceLogEntry, unknown>>;
  return {
    step: typeof v.step === "number" ? v.step : index + 1,
    action: typeof v.action === "string" ? v.action : "step",
    detail: typeof v.detail === "string" ? v.detail : "",
    screenshot_url: typeof v.screenshot_url === "string" && v.screenshot_url ? v.screenshot_url : null,
  };
}

/** A lane with every field filled in, consistent with the race's own status. */
export function normLane(raw: unknown, raceStatus: RaceStatus): Lane {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof RaceLane | "error", unknown>>;
  const log = (Array.isArray(r.log) ? r.log : [])
    .map(asLogEntry)
    .filter((e): e is RaceLogEntry => e !== null)
    .sort((a, b) => a.step - b.step);

  let status = asStatus(r.status) ?? (raceStatus === "running" ? "running" : raceStatus);
  // A finished race has no running lanes (e.g. the worker died mid-lane).
  if (isFinished(raceStatus) && !isFinished(status)) status = raceStatus === "failed" ? "failed" : "done";

  const current = log.length ? log[log.length - 1].step : 0;
  const steps = typeof r.steps === "number" ? r.steps : current;
  const total = steps > current ? steps : isFinished(status) ? Math.max(steps, current) : null;

  return {
    status,
    ms: typeof r.ms === "number" ? r.ms : null,
    steps: Math.max(steps, current),
    tokens: typeof r.tokens === "number" ? r.tokens : 0,
    success: typeof r.success === "boolean" ? r.success : null,
    log,
    current,
    total,
    error: typeof r.error === "string" && r.error ? r.error : null,
  };
}

export function lanesOf(race: Race): { browser: Lane; broker: Lane } {
  return { browser: normLane(race.browser, race.status), broker: normLane(race.broker, race.status) };
}

function finishedOk(lane: Lane): boolean {
  return lane.status === "done" && lane.success !== false && lane.ms !== null;
}

/** Fastest lane that finished successfully, or null. */
export function winnerOf(browser: Lane, broker: Lane): LaneId | null {
  const b = finishedOk(browser);
  const k = finishedOk(broker);
  if (b && k) return (broker.ms ?? 0) <= (browser.ms ?? 0) ? "broker" : "browser";
  if (k) return "broker";
  if (b) return "browser";
  return null;
}

/** 0–1 position on the race track. */
export function progressOf(lane: Lane): number {
  if (lane.status === "done") return 1;
  if (lane.status === "queued") return 0;
  if (lane.total) return Math.min(0.92, lane.current / lane.total);
  return Math.min(0.9, 1 - Math.pow(0.82, lane.current)); // unknown length: creep towards the line
}

// ── Session history ────────────────────────────────────────────────────────

export interface RaceSummary {
  status: RaceStatus;
  winner: LaneId | null;
  browserMs: number | null;
  brokerMs: number | null;
  speedup: number | null;
}

export interface HistoryEntry {
  id: string;
  siteId: string;
  siteName: string;
  task: string;
  startedAt: string;
  result: RaceSummary | null;
}

export function summarize(race: Race): RaceSummary {
  const { browser, broker } = lanesOf(race);
  const winner = winnerOf(browser, broker);
  return {
    status: race.status,
    winner,
    browserMs: browser.ms,
    brokerMs: broker.ms,
    speedup: winner === "broker" ? speedup(browser.ms, broker.ms) : null,
  };
}

export function sameSummary(a: RaceSummary | null, b: RaceSummary): boolean {
  return (
    !!a &&
    a.status === b.status &&
    a.winner === b.winner &&
    a.browserMs === b.browserMs &&
    a.brokerMs === b.brokerMs &&
    a.speedup === b.speedup
  );
}

// ── Task presets ───────────────────────────────────────────────────────────

export const DEFAULT_TASK = "Book the earliest available appointment";

const PRESETS: Record<string, string[]> = {
  "sunrise-clinic": ["Book the earliest available appointment", "Book a check-up for tomorrow morning"],
  "bella-bistro": ["Reserve a table for 2 tonight", "Book the earliest table for 4"],
  "pawsome-vet": ["Book the earliest available appointment", "Book a check-up for my dog Rex"],
  "city-library": ["Place a hold on the first available book", "Place a hold on Frankenstein"],
};

/** Task chips for a site; the first one is the default task. */
export function presetsFor(site: Site | null | undefined): string[] {
  const list = [...(PRESETS[site?.id ?? ""] ?? [DEFAULT_TASK]), ...(site?.goal ? [site.goal] : [])];
  return [...new Set(list)];
}

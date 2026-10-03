// In-browser mock of the Doorway backend (NEXT_PUBLIC_DOORWAY_MOCK=1).
//
// The whole world lives in memory (fixtures: mock-fixtures.ts). Every DoorwayApi call answers
// after 80–200 ms with deep copies, and every row change is pushed on mockBus exactly like
// Supabase Realtime would (INSERT/UPDATE on the doorway_* tables). While a page is open, timers
// keep it alive: heartbeats, agent traffic, optimize jobs and sandbox chatter. The demo flows
// (add site, break → self-heal, race, run, agent request) are scripted with real timings.
// Nothing happens at import time: timers start on the first call/subscription in a browser.

import { DoorwayError, parseDetail } from "@/lib/doorway/errors";
import {
  BOOKS,
  confirmationCode,
  fmtCall,
  isoDay,
  isRecord,
  resourceFor,
  sampleArgs,
  specFor,
  summarize,
  toolResult,
  type Json,
} from "@/lib/doorway/mock-data";
import { createWorld, type AgentRequestState, type ApiVersion, type World } from "@/lib/doorway/mock-fixtures";
import { screenshotUrl, type ShotOptions } from "@/lib/doorway/mock-screens";
import {
  STRATEGIES,
  type AgentRequest,
  type AgentRequestCreated,
  type DoorwayApi,
  type DoorwayEvent,
  type EventKind,
  type GraphEdge,
  type GraphNode,
  type Job,
  type JobKind,
  type JsonSchema,
  type LiveBus,
  type Message,
  type MessageKind,
  type Payment,
  type Race,
  type RaceLane,
  type RealtimeRows,
  type RealtimeTable,
  type RowChange,
  type Run,
  type RunToolResult,
  type Sandbox,
  type Site,
  type SiteStatus,
  type Strategy,
  type StrategyResult,
  type Tool,
  type ToolKind,
  type ToolStatus,
  type VersionSource,
} from "@/lib/doorway/types";

type Strategies = Partial<Record<Strategy, StrategyResult>>;

// ── Utilities ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.round(rand(min, max));
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const alnum = (n: number) =>
  Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join("");
const nowIso = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const around = (base: number, spread = 0.12) => Math.max(1, Math.round(base * (1 + (Math.random() * 2 - 1) * spread)));
const tomorrow = () => isoDay(Date.now() + 86_400_000);
const blank = (v: unknown) => v === undefined || v === null || v === "";
const humanize = (name: string) => name.replace(/_/g, " ");
const titleize = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const newReference = () => `pi_test_${alnum(20)}`;
const unique = <T>(items: T[]) => [...new Set(items)];

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function trim<T>(rows: T[], max: number) {
  if (rows.length > max) rows.splice(0, rows.length - max);
}

function spawn(task: Promise<unknown>) {
  task.catch((err: unknown) => console.error("[doorway mock]", err));
}

/** Absolute schedule for a scripted flow: `await at(1500)` = 1.5 s after the flow started. */
function timeline() {
  const t0 = Date.now();
  return { t0, at: (ms: number) => sleep(Math.max(0, t0 + ms - Date.now())) };
}

function apiBase(): string {
  return process.env.NEXT_PUBLIC_DOORWAY_API_URL?.replace(/\/+$/, "") || "http://localhost:8000";
}

// ── World + lookups ────────────────────────────────────────────────────────

let world: World | null = null;

function w(): World {
  if (!world) world = createWorld(Date.now());
  return world;
}

const siteById = (id: string) => w().sites.find((s) => s.id === id);
const toolById = (id: number) => w().tools.find((t) => t.id === id);
const toolsOf = (siteId: string) => w().tools.filter((t) => t.site_id === siteId);
const jobById = (id: number) => w().jobs.find((j) => j.id === id);
const sandboxById = (id: string | null) => w().sandboxes.find((s) => s.id === id);
const capOf = (tool: Tool) => w().capabilities.find((c) => c.tool_id === tool.id);

function siteView(site: Site): Site {
  const tools = toolsOf(site.id);
  return {
    ...site,
    tools_count: tools.length,
    verified_count: tools.filter((t) => t.status === "verified").length,
    mcp_url: `${apiBase()}/doorway/sites/${site.id}/mcp`,
  };
}

/** The demo site's private API changed under this tool (only the api strategy cares). */
function mismatched(tool: Tool): boolean {
  if (tool.best_strategy !== "api" || tool.status === "draft") return false;
  const world = w();
  return (world.toolApi.get(tool.id) ?? "v1") !== (world.siteApi.get(tool.site_id) ?? "v1");
}

/** The next strategy that still works when the private API changed: form, else browser. */
function fallbackOf(tool: Tool): Strategy {
  const have = tool.strategies?.length ? tool.strategies : STRATEGIES;
  return have.find((s) => s !== "api" && s !== tool.best_strategy) ?? "browser";
}

/** Verified tools on ready sites, safe for background traffic. */
function healthyTools(): Tool[] {
  return w().tools.filter((t) => t.status === "verified" && siteById(t.site_id)?.status === "ready" && !mismatched(t));
}

/** Latest active (else latest) job for a site that's mid-flow, or null when it's idle. */
function busyJob(siteId: string): number | null {
  const world = w();
  if (!world.flows.has(siteId) && !world.healing.has(siteId)) return null;
  const jobs = world.jobs.filter((j) => j.site_id === siteId);
  const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const job = active[active.length - 1] ?? jobs[jobs.length - 1];
  return job ? job.id : null;
}

// ── Live bus ───────────────────────────────────────────────────────────────

type Listener = (change: RowChange) => void;
const listeners = new Map<RealtimeTable, Set<Listener>>();

function emit<T extends RealtimeTable>(table: T, type: "INSERT" | "UPDATE", row: RealtimeRows[T]): void {
  const set = listeners.get(table);
  if (!set?.size) return;
  const change: RowChange<T> = { table, type, row: clone(row) };
  for (const cb of [...set]) {
    try {
      cb(change);
    } catch (err) {
      console.error("[doorway mock] listener failed", err);
    }
  }
}

export const mockBus: LiveBus = {
  subscribe(table, cb) {
    ensureStarted();
    const set = listeners.get(table) ?? new Set<Listener>();
    listeners.set(table, set);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  },
  status: () => "live",
  onStatus: () => () => {},
};

// ── Writers (every change emits) ───────────────────────────────────────────

interface EventOpts {
  site?: string | null;
  sandbox?: string | null;
  data?: Json;
}

function addEvent(kind: EventKind, message: string, opts: EventOpts = {}): DoorwayEvent {
  const world = w();
  const row: DoorwayEvent = {
    id: world.next.event++,
    site_id: opts.site ?? null,
    sandbox_id: opts.sandbox ?? null,
    kind,
    message,
    data: opts.data ?? {},
    created_at: nowIso(),
  };
  world.events.push(row);
  trim(world.events, 5000);
  if (kind === "heal.done") world.heals += 1;
  emit("doorway_events", "INSERT", row);
  return row;
}

function postMessage(from: string, to: string | null, kind: MessageKind, body: Json): Message {
  const world = w();
  const row: Message = { id: world.next.message++, from_sandbox: from, to_sandbox: to, kind, body, created_at: nowIso() };
  world.messages.push(row);
  trim(world.messages, 2000);
  emit("doorway_messages", "INSERT", row);
  return row;
}

function insertJob(kind: JobKind, siteId: string | null, toolId: number | null = null): Job {
  const world = w();
  const job: Job = {
    id: world.next.job++,
    kind,
    site_id: siteId,
    tool_id: toolId,
    status: "queued",
    claimed_by: null,
    attempts: 0,
    result: null,
    error: null,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
  };
  world.jobs.push(job);
  trim(world.jobs, 1000);
  emit("doorway_jobs", "INSERT", job);
  return job;
}

function saveSandbox(sb: Sandbox) {
  sb.last_heartbeat = nowIso();
  emit("doorway_sandboxes", "UPDATE", sb);
}

/** An idle sandbox (never `exclude`: verify runs on a different sandbox) claims the job. */
function claim(job: Job, exclude: string | null = null): Sandbox {
  const world = w();
  const pool = world.sandboxes.filter((s) => s.status !== "offline" && s.id !== exclude);
  const idle = pool.filter((s) => s.status === "idle");
  const load = (s: Sandbox) => world.sandboxJobs.get(s.id)?.length ?? 0;
  const sb = idle.length ? pick(idle) : [...pool].sort((a, b) => load(a) - load(b))[0];
  job.status = "running";
  job.claimed_by = sb.id;
  job.attempts += 1;
  job.started_at = nowIso();
  emit("doorway_jobs", "UPDATE", job);
  world.sandboxJobs.set(sb.id, [...(world.sandboxJobs.get(sb.id) ?? []), job.id]);
  sb.status = "busy";
  sb.current_job_id = job.id;
  sb.site_id = job.site_id;
  sb.job_kind = job.kind;
  saveSandbox(sb);
  return sb;
}

function finishJob(job: Job, result: unknown) {
  const world = w();
  job.status = "done";
  job.result = result;
  job.finished_at = nowIso();
  emit("doorway_jobs", "UPDATE", job);
  const sb = sandboxById(job.claimed_by);
  if (!sb) return;
  const rest = (world.sandboxJobs.get(sb.id) ?? []).filter((id) => id !== job.id);
  world.sandboxJobs.set(sb.id, rest);
  sb.jobs_done += 1;
  const current = rest.length ? jobById(rest[rest.length - 1]) : undefined;
  sb.status = current ? "busy" : "idle";
  sb.current_job_id = current?.id ?? null;
  sb.site_id = current?.site_id ?? null;
  sb.job_kind = current?.kind ?? null;
  saveSandbox(sb);
}

function saveTool(tool: Tool, type: "INSERT" | "UPDATE" = "UPDATE") {
  tool.updated_at = nowIso();
  emit("doorway_tools", type, tool);
}

function setToolStatus(tool: Tool, status: ToolStatus) {
  tool.status = status;
  const cap = capOf(tool);
  if (cap) cap.status = status;
  saveTool(tool);
}

// Sites aren't a Realtime table: callers always follow this with an event row.
function setSiteStatus(site: Site, status: SiteStatus) {
  site.status = status;
  site.updated_at = nowIso();
}

function recordRun(fields: Omit<Run, "id" | "created_at">): Run {
  const world = w();
  const run: Run = { id: world.next.run++, ...fields, created_at: nowIso() };
  world.runs.push(run);
  trim(world.runs, 5000);
  emit("doorway_runs", "INSERT", run);
  const tool = fields.tool_id !== null && fields.mode !== "browser_agent" ? toolById(fields.tool_id) : undefined;
  if (tool) {
    const n = Math.min(tool.runs_count, 200);
    const ok = fields.status === "success" ? 1 : 0;
    tool.success_rate = Math.round((((tool.success_rate ?? 1) * n + ok) / (n + 1)) * 1000) / 1000;
    tool.runs_count += 1;
    saveTool(tool);
  }
  return run;
}

function saveRace(race: Race, type: "INSERT" | "UPDATE" = "UPDATE") {
  emit("doorway_races", type, race);
}

// ── Errors (shaped like the FastAPI backend) ───────────────────────────────

const notFound = () => new DoorwayError(404, "not_found", { error: "not_found" });

/** FastAPI request validation: detail [{loc, msg, type}], code = readable message. */
const badField = (field: string, msg: string) =>
  parseDetail(422, { detail: [{ loc: ["body", field], msg, type: "value_error" }] });

const invalidUrl = (url: string) =>
  new DoorwayError(422, "invalid_url", { error: "invalid_url", message: `not a website URL: ${url || "(empty)"}` });

// ── URLs and slugs ─────────────────────────────────────────────────────────

const bare = (url: string) =>
  url.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

/** "joes-pizza.example.com" → "https://joes-pizza.example.com/" (422 when it isn't a URL). */
function normalizeUrl(raw: string): string {
  const text = raw.trim();
  if (!text || /\s/.test(text)) throw invalidUrl(text);
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw invalidUrl(text);
  }
  const hostOk = u.hostname === "localhost" || /^\d+(\.\d+){3}$/.test(u.hostname) || /\.[a-z]{2,}$/i.test(u.hostname);
  if (!/^https?:$/.test(u.protocol) || !hostOk) throw invalidUrl(text);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}/`;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "site";

function slugForUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  if (host === "localhost" || /^\d+(\.\d+){3}$/.test(host)) return slugify(`${host}-${u.port || "80"}`);
  return slugify(host.split(".")[0]);
}

function freeId(slug: string): string {
  let id = slug;
  for (let n = 2; siteById(id); n++) id = `${slug}-${n}`;
  return id;
}

/** By id, name, base_url or host (case-insensitive). */
function findSite(website: string): Site | undefined {
  const raw = website.trim().toLowerCase();
  const q = bare(raw);
  const host = q.split("/")[0];
  return w().sites.find(
    (s) => s.id === raw || s.name.toLowerCase() === raw || bare(s.base_url) === q || bare(s.base_url).split("/")[0] === host,
  );
}

function createSite(fields: { id: string; name: string; base_url: string; goal: string | null }): Site {
  const world = w();
  const site: Site = { ...fields, status: "queued", tools_count: 0, verified_count: 0, updated_at: nowIso() };
  world.sites.unshift(site);
  world.siteApi.set(site.id, "v1");
  return site;
}

// ── Strategies, versions, execution ────────────────────────────────────────

function msFor(tool: Tool, strategy: Strategy): number {
  if (strategy === tool.best_strategy && tool.p50_ms) return around(tool.p50_ms, 0.15);
  if (strategy === "api") return randInt(70, 130);
  return strategy === "form" ? randInt(540, 720) : randInt(3800, 4700);
}

/** What a verifier measures: every strategy the tool can run, timed. */
function measure(tool: Tool, flakyForm = false): Strategies {
  const have = (s: Strategy) => (tool.strategies?.length ? tool.strategies : STRATEGIES).includes(s);
  return {
    api: have("api") ? { ms: msFor(tool, "api"), passed: true } : { ms: null, passed: false },
    form: have("form") ? { ms: msFor(tool, "form"), passed: !(flakyForm && Math.random() < 0.2) } : { ms: null, passed: false },
    browser: { ms: msFor(tool, "browser"), passed: true },
  };
}

function fastest(s: Strategies): [Strategy, number] {
  let best: [Strategy, number] = ["browser", s.browser?.ms ?? 4200];
  for (const k of STRATEGIES) {
    const r = s[k];
    if (r?.passed && r.ms !== null && r.ms < best[1]) best = [k, r.ms];
  }
  return best;
}

function strategyLine(s: Strategies): string {
  return STRATEGIES.filter((k) => s[k]?.passed && s[k]?.ms)
    .map((k) => `${k} ${fmtMs(s[k]?.ms ?? 0)}`)
    .join(" · ");
}

/** A new verified version: bumps the tool, records who verified it and how fast each strategy ran. */
function publishVersion(tool: Tool, source: VersionSource, verifiedBy: string, strategies: Strategies) {
  const world = w();
  const history = world.versions.get(tool.id) ?? [];
  if (source === "heal") for (const v of history) v.status = "broken"; // they targeted the old API
  tool.version += 1;
  history.push({ version: tool.version, status: "verified", source, verified_by: verifiedBy, strategies, created_at: nowIso() });
  world.versions.set(tool.id, history);
  const [best, ms] = fastest(strategies);
  tool.best_strategy = best;
  tool.p50_ms = ms;
  tool.success_rate = tool.success_rate ?? 1;
  tool.strategies = STRATEGIES.filter((k) => strategies[k]?.passed);
  world.toolApi.set(tool.id, world.siteApi.get(tool.site_id) ?? "v1");
  setToolStatus(tool, "verified");
}

function coerce(tool: Tool, args: Json) {
  for (const [name, prop] of Object.entries(tool.input_schema.properties ?? {})) {
    const v = args[name];
    if (typeof v !== "string") continue;
    if ((prop.type === "integer" || prop.type === "number") && v.trim() !== "" && !Number.isNaN(Number(v))) args[name] = Number(v);
    if (prop.type === "boolean") args[name] = v === "true" || v === "1" || v === "on";
  }
}

/** What the website itself would reject (the run executes and fails: 200 ok:false). */
function siteRejects(tool: Tool, args: Json): string | null {
  for (const [name, prop] of Object.entries(tool.input_schema.properties ?? {})) {
    const v = args[name];
    if (blank(v)) continue;
    if (prop.enum && !prop.enum.some((e) => e === v)) return `${name} must be one of: ${prop.enum.join(", ")}`;
    if (prop.type === "integer" && !Number.isInteger(v)) return `${name} must be a whole number`;
    if (typeof v === "number" && prop.minimum !== undefined && v < prop.minimum) return `${name} must be at least ${prop.minimum}`;
    if (typeof v === "number" && prop.maximum !== undefined && v > prop.maximum) return `${name} must be at most ${prop.maximum}`;
    if (prop.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return `${name} must be a date (YYYY-MM-DD)`;
    if (prop.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) return `${name} is not a valid email`;
  }
  if (tool.name.startsWith("book_") && "slot_id" in args && !/^s_\d{4}$/.test(String(args.slot_id))) {
    return `slot ${String(args.slot_id)} is not open`;
  }
  if (tool.name === "place_hold" && !BOOKS.some((b) => b.id === args.book_id)) return `no book with id ${String(args.book_id)}`;
  return null;
}

interface Exec {
  ok: boolean;
  data: unknown;
  error: string | null;
  strategy: Strategy;
  ms: number;
}

/** Run a tool against the (pretend) website. `book` keeps dashboard bookings so slots fill up. */
function execute(tool: Tool, args: Json, strategy: Strategy, book = false): Exec {
  const world = w();
  const ms = msFor(tool, strategy);
  const rejected = siteRejects(tool, args);
  if (rejected) return { ok: false, data: null, error: rejected, strategy, ms };
  const bookings = world.bookings.get(tool.site_id) ?? [];
  const booked = new Set(bookings.map((b) => b.slot_id).filter((s): s is string => Boolean(s)));
  const slot = typeof args.slot_id === "string" ? args.slot_id : null;
  if (book && tool.kind === "action" && slot && booked.has(slot)) {
    return { ok: false, data: null, error: `slot ${slot} is not open`, strategy, ms };
  }
  const code = confirmationCode(tool.site_id);
  const data = toolResult(tool, args, { date: tomorrow(), code, booked });
  if (book && tool.kind === "action") {
    bookings.push({ tool_id: tool.id, slot_id: slot, confirmation: code, created_at: nowIso() });
    world.bookings.set(tool.site_id, bookings);
  }
  return { ok: true, data, error: null, strategy, ms };
}

/**
 * How a call gets served right now. A tool whose API path broke still runs through a fallback
 * strategy (form) and is marked repairing while a heal job fixes the fast path; a tool marked
 * broken waits for the heal, then runs (healed: true).
 */
async function route(tool: Tool, site: Site): Promise<{ strategy: Strategy; healed: boolean }> {
  if (tool.status === "broken") {
    await startHeal(site.id);
    return { strategy: tool.best_strategy ?? "api", healed: true };
  }
  if (mismatched(tool)) {
    const strategy = fallbackOf(tool);
    if (tool.status === "verified") {
      const error = `404 /api/${w().toolApi.get(tool.id) ?? "v1"}/${resourceFor(tool.name)}`;
      setToolStatus(tool, "repairing");
      addEvent("tool.broken", `${tool.name}: api strategy broke; serving via ${strategy} while a sandbox repairs it`, {
        site: site.id,
        data: { tool_id: tool.id, tool: tool.name, error, strategy: "api", fallback: strategy },
      });
      spawn(startHeal(site.id));
    }
    return { strategy, healed: false };
  }
  return { strategy: tool.best_strategy ?? "api", healed: false };
}

async function payTest(tool: Tool): Promise<Payment> {
  const amount = tool.price_cents;
  addEvent("payment.challenge", `${tool.name}: sent a ${usd(amount)} payment challenge`, {
    site: tool.site_id,
    data: { tool_id: tool.id, tool: tool.name, amount_cents: amount },
  });
  await sleep(250);
  const reference = newReference();
  addEvent("payment.paid", `Paid ${usd(amount)} for ${tool.name} (${reference})`, {
    site: tool.site_id,
    data: { tool_id: tool.id, tool: tool.name, amount_cents: amount, reference },
  });
  return {
    reference,
    amount_cents: amount,
    receipt: { id: `rcpt_${alnum(14)}`, status: "succeeded", livemode: false, reference, amount_cents: amount, currency: "usd", method: "mpp" },
  };
}

/** What an agent gets back for a paid action instead of a result (Stripe's MCP pattern). */
function paymentLink(tool: Tool, inputs: Json): Json {
  const link = `${apiBase()}/doorway/run/${tool.site_id}/${tool.name}`;
  return {
    payment_required: true,
    paymentLink: link,
    amount: `${(tool.price_cents / 100).toFixed(2)} USD`,
    amount_cents: tool.price_cents,
    tool: `${tool.site_id}__${tool.name}`,
    method: "POST",
    body: { arguments: inputs },
    arguments: inputs,
    instructions: { agent: "POST {arguments} to paymentLink; on 402 pay with an SPT (link-cli) and retry" },
  };
}

// ── Agent calls (broker) ───────────────────────────────────────────────────

interface Served extends Exec {
  run: Run;
  healed: boolean;
}

/** lookup.hit → execute.call → (actions: payment.challenge → payment.paid) → run, `gap` ms apart. */
async function serveCall(tool: Tool, opts: { gap: number; requestId: string; args: Json }): Promise<Served> {
  const site = siteById(tool.site_id);
  if (!site) throw notFound();
  const base = { request_id: opts.requestId, tool_id: tool.id, tool: tool.name };
  await sleep(opts.gap);
  addEvent("lookup.hit", `Found ${tool.name} (v${tool.version}, ${tool.best_strategy ?? "api"})`, { site: site.id, data: base });
  const { strategy, healed } = await route(tool, site);
  const res = execute(tool, opts.args, strategy);
  await sleep(opts.gap);
  addEvent("execute.call", `${tool.name} → ${strategy} (${fmtMs(res.ms)})${healed ? " after self-heal" : ""}`, {
    site: site.id,
    data: { ...base, strategy, ms: res.ms, ok: res.ok, healed },
  });
  let reference: string | null = null;
  if (tool.kind === "action" && tool.price_cents > 0) {
    await sleep(opts.gap);
    addEvent("payment.challenge", `${tool.name}: sent a ${usd(tool.price_cents)} payment challenge`, {
      site: site.id,
      data: { ...base, amount_cents: tool.price_cents },
    });
    await sleep(opts.gap);
    reference = newReference();
    addEvent("payment.paid", `Paid ${usd(tool.price_cents)} for ${tool.name} (${reference})`, {
      site: site.id,
      data: { ...base, amount_cents: tool.price_cents, reference },
    });
  }
  const run = recordRun({
    tool_id: tool.id,
    site_id: tool.site_id,
    mode: "broker",
    strategy,
    status: res.ok ? "success" : "failure",
    ms: res.ms,
    steps: 1,
    tokens: 0,
    paid_reference: reference,
    error: res.error,
  });
  return { ...res, run, healed };
}

const ACTION_TASK = /\bbook(ing)?\b|reserv|\bhold\b|submit|schedule|\bplace\b/i;

/** The action tool if the task asks to book/reserve/hold/submit, else a read tool; best name match wins. */
function matchTool(siteId: string, task: string): Tool | null {
  const tools = toolsOf(siteId).filter((t) => t.status !== "draft");
  const wantsAction = ACTION_TASK.test(task);
  const pool = tools.filter((t) => t.kind === (wantsAction ? "action" : "read"));
  const text = task.toLowerCase();
  const score = (t: Tool) =>
    t.name
      .split("_")
      .filter((tok) => tok.length > 2 && text.includes(tok.replace(/s$/, "")))
      .length;
  const ranked = [...(pool.length ? pool : tools)].sort((a, b) => score(b) - score(a));
  return ranked[0] ?? null;
}

async function announceAction(tool: Tool, requestId: string) {
  const data = { request_id: requestId, tool_id: tool.id, tool: tool.name };
  await sleep(randInt(300, 400));
  addEvent("lookup.hit", `Found ${tool.name} (v${tool.version}, ${tool.best_strategy ?? "api"})`, { site: tool.site_id, data });
  await sleep(randInt(300, 400));
  addEvent("payment.challenge", `${tool.name}: payment link for ${usd(tool.price_cents)} sent to the agent`, {
    site: tool.site_id,
    data: { ...data, amount_cents: tool.price_cents, paymentLink: `${apiBase()}/doorway/run/${tool.site_id}/${tool.name}` },
  });
}

/** Drives a POST /doorway/requests to done/failed (waits for discovery when needed). */
async function agentFlow(req: AgentRequestState) {
  const world = w();
  if (req.status === "discovering") {
    await (world.flows.get(req.site_id) ?? Promise.resolve());
    const tool = matchTool(req.site_id, req.task);
    if (!tool) {
      req.status = "failed";
      req.error = toolsOf(req.site_id).length ? "no tool matches this task" : "could not discover this site";
      addEvent("lookup.miss", `No tool matches: ${req.task}`, { site: req.site_id, data: { request_id: req.id } });
      return;
    }
    req.tool_id = tool.id;
    if (tool.kind === "action") {
      req.status = "done";
      req.result = paymentLink(tool, req.inputs);
      await announceAction(tool, req.id);
      return;
    }
    req.status = "executing";
  }
  const tool = req.tool_id !== null ? toolById(req.tool_id) : undefined;
  if (!tool) {
    req.status = "failed";
    req.error = "tool disappeared";
    return;
  }
  const out = await serveCall(tool, { gap: randInt(300, 400), requestId: req.id, args: sampleArgs(tool, tomorrow(), req.inputs) });
  req.status = out.ok ? "done" : "failed";
  req.result = out.data;
  req.run = out.run;
  req.error = out.error;
}

// ── Flow A: discover → verify → publish ────────────────────────────────────

interface ToolPlan {
  schema: JsonSchema;
  profile: Record<string, string>;
  pattern: number | null;
}
interface CapPlan {
  name: string;
  kind: ToolKind;
  description: string;
  tool: ToolPlan | null; // null = observed only, never compiled
}
interface Plan {
  actions: [string, Json][];
  apis: [string, Json][];
  caps: CapPlan[];
  patterns: number[];
}

const BOOKING = /\bbook(ing)?\b|reserv|appoint|table|slot|visit/i;

function bookingNoun(text: string): string {
  if (/appoint|doctor|clinic|dentist|salon|hair|spa/i.test(text)) return "appointment";
  if (/table|reserv|restaurant|dinner|bistro|pizza|cafe/i.test(text)) return "table";
  if (/visit|vet/i.test(text)) return "visit";
  if (/class|gym|yoga|studio/i.test(text)) return "class";
  if (/room|hotel|stay/i.test(text)) return "room";
  return "slot";
}

function searchNoun(text: string): string {
  if (/menu|pizza|food|restaurant/i.test(text)) return "menu";
  if (/book|librar|catalog/i.test(text)) return "books";
  if (/shop|store|product|buy/i.test(text)) return "products";
  if (/job|career/i.test(text)) return "jobs";
  return "catalog";
}

const str = (description: string, examples: unknown[]): JsonSchema => ({ type: "string", description, examples });

function explorePlan(booking: boolean, noun: string): Pick<Plan, "actions" | "apis"> {
  const day = tomorrow();
  if (booking) {
    const cta = noun === "table" ? "Reserve a table" : `Book ${noun === "appointment" ? "an appointment" : `a ${noun}`}`;
    const plural = noun === "table" ? "reservations" : `${noun}s`;
    return {
      actions: [
        [`click '${cta}'`, { action: "click", target: cta }],
        [`fill date = ${day}`, { action: "fill", target: "date", value: day }],
        ["click 'Find times'", { action: "click", target: "Find times" }],
      ],
      apis: [
        [`GET /api/v1/slots?date=${day} → 200 JSON (6 slots)`, { method: "GET", path: "/api/v1/slots", status: 200 }],
        [`POST /api/v1/${plural} → 201 JSON (dry run)`, { method: "POST", path: `/api/v1/${plural}`, status: 201 }],
      ],
    };
  }
  const q = noun === "books" ? "dune" : noun === "menu" ? "pizza" : "gift";
  return {
    actions: [
      ["click 'Search'", { action: "click", target: "Search" }],
      [`type '${q}' into search`, { action: "type", target: "search", value: q }],
      ["click 'Contact us'", { action: "click", target: "Contact us" }],
    ],
    apis: [
      [`GET /api/v1/search?q=${q} → 200 JSON`, { method: "GET", path: "/api/v1/search", status: 200 }],
      ["POST /contact → 302 (HTML form)", { method: "POST", path: "/contact", status: 302 }],
    ],
  };
}

/** What a sandbox finds on a brand-new site: two compiled tools from shared patterns + one observed. */
function newPlan(site: Site): Plan {
  const text = `${site.goal ?? ""} ${site.name} ${site.base_url}`;
  const name = str("Your full name", ["Ada Lovelace"]);
  if (BOOKING.test(text)) {
    const noun = bookingNoun(text);
    return {
      ...explorePlan(true, noun),
      caps: [
        {
          name: "list_open_slots",
          kind: "read",
          description: `List open ${noun} slots (id and time) for one day.`,
          tool: {
            schema: {
              type: "object",
              properties: { date: { ...str("Day as YYYY-MM-DD", [tomorrow()]), format: "date" } },
              required: ["date"],
            },
            profile: {},
            pattern: 4,
          },
        },
        {
          name: `book_${noun}`,
          kind: "action",
          description: `Book an open ${noun} slot. Returns a confirmation code.`,
          tool: {
            schema: {
              type: "object",
              properties: {
                slot_id: str("Slot id from list_open_slots", ["s_0900"]),
                full_name: name,
                phone: str("Contact phone number", ["555-0100"]),
              },
              required: ["slot_id", "full_name", "phone"],
            },
            profile: { full_name: "full_name", phone: "phone" },
            pattern: 4,
          },
        },
        { name: `cancel_${noun}`, kind: "action", description: `Cancel a ${noun} (behind a login; not compiled yet).`, tool: null },
      ],
      patterns: [4],
    };
  }
  const noun = searchNoun(text);
  return {
    ...explorePlan(false, noun),
    caps: [
      {
        name: `search_${noun}`,
        kind: "read",
        description: `Search the site's ${noun}.`,
        tool: {
          schema: { type: "object", properties: { query: str("What to look for", [noun === "books" ? "dune" : "pizza"]) }, required: ["query"] },
          profile: {},
          pattern: 5,
        },
      },
      {
        name: "submit_contact_form",
        kind: "action",
        description: "Send the site a message through its contact form.",
        tool: {
          schema: {
            type: "object",
            properties: {
              full_name: name,
              email: { ...str("Reply-to email", ["ada@example.com"]), format: "email" },
              message: str("Your message", ["Do you take group bookings?"]),
            },
            required: ["full_name", "email", "message"],
          },
          profile: { full_name: "full_name", email: "email" },
          pattern: 6,
        },
      },
      { name: "subscribe_newsletter", kind: "action", description: "Join the mailing list (observed, not compiled).", tool: null },
    ],
    patterns: [5, 6],
  };
}

function startDiscover(siteId: string, jobId: number) {
  const world = w();
  const flow = discoverFlow(siteId, jobId)
    .catch((err: unknown) => console.error("[doorway mock] discover failed", err))
    .finally(() => world.flows.delete(siteId));
  world.flows.set(siteId, flow);
}

async function discoverFlow(siteId: string, jobId: number): Promise<void> {
  const world = w();
  const site = siteById(siteId);
  const job = jobById(jobId);
  if (!site || !job) return;
  const { at } = timeline();
  let t = 800;
  const step = (ms = 300) => at((t += ms));

  const published = toolsOf(siteId).filter((tool) => tool.status !== "draft");
  const rediscover = published.length > 0;
  const plan: Plan = rediscover
    ? {
        ...explorePlan(
          published.some((tool) => tool.name.includes("slot")),
          bookingNoun(`${site.goal ?? ""} ${site.name}`),
        ),
        caps: world.capabilities.filter((c) => c.site_id === siteId).map((c) => ({ ...c, description: c.description ?? "", tool: null })),
        patterns: [],
      }
    : newPlan(site);

  await at(t);
  const sb = claim(job);
  const ev = { site: siteId, sandbox: sb.id };
  setSiteStatus(site, "discovering");
  addEvent("discover.start", `${sb.id} opened ${site.base_url} in a fresh Chromium`, {
    ...ev,
    data: { job_id: job.id, url: site.base_url, goal: site.goal, rediscover },
  });
  for (const [text, data] of plan.actions) {
    await step();
    addEvent("explore.action", text, { ...ev, data: { job_id: job.id, ...data } });
  }
  for (const [text, data] of plan.apis) {
    await step();
    addEvent("explore.api", text, { ...ev, data: { job_id: job.id, ...data } });
  }

  // Observe: capabilities appear on the graph one by one.
  for (const c of plan.caps) {
    await step();
    let cap = world.capabilities.find((x) => x.site_id === siteId && x.name === c.name);
    if (!cap) {
      cap = { id: world.next.cap++, site_id: siteId, name: c.name, description: c.description, kind: c.kind, status: "observed", tool_id: null };
      world.capabilities.push(cap);
    }
    addEvent("observe.capability", `${c.name} (${c.kind})`, { ...ev, data: { capability_id: cap.id, name: c.name, kind: c.kind } });
  }

  // Shared memory: try patterns other sandboxes published before exploring from scratch.
  for (const id of plan.patterns) {
    const p = world.patterns.find((x) => x.id === id);
    if (!p) continue;
    await step();
    addEvent("reuse.pattern", `trying shared pattern ${p.name} from ${p.created_by ?? "the board"}`, {
      ...ev,
      data: { pattern_id: p.id, pattern: p.name, from_sandbox: p.created_by },
    });
    if (p.source_site_id !== siteId && !p.used_by.includes(siteId)) p.used_by.push(siteId);
  }

  // Compile: new draft tools (or the existing ones when rediscovering).
  const compiled: Tool[] = [];
  for (const c of plan.caps) {
    const cap = world.capabilities.find((x) => x.site_id === siteId && x.name === c.name);
    let tool = toolsOf(siteId).find((x) => x.name === c.name);
    if (rediscover ? !tool : !c.tool) continue;
    await step();
    if (!tool && c.tool) {
      tool = {
        id: world.next.tool++,
        site_id: siteId,
        name: c.name,
        description: c.description,
        kind: c.kind,
        status: "draft",
        version: 0,
        best_strategy: null,
        p50_ms: null,
        success_rate: null,
        runs_count: 0,
        price_cents: c.kind === "action" ? 50 : 0,
        pattern_id: c.tool.pattern,
        input_schema: c.tool.schema,
        profile_fields: c.tool.profile,
        updated_at: nowIso(),
        strategies: [...STRATEGIES],
      };
      world.tools.push(tool);
      world.versions.set(tool.id, []);
      world.toolApi.set(tool.id, world.siteApi.get(siteId) ?? "v1");
      if (cap) {
        cap.status = "draft";
        cap.tool_id = tool.id;
      }
      saveTool(tool, "INSERT");
    }
    if (!tool) continue;
    compiled.push(tool);
    const pattern = tool.pattern_id ? world.patterns.find((p) => p.id === tool.pattern_id) : undefined;
    addEvent(
      "compile.tool",
      `compiled ${tool.name} (${(tool.strategies ?? STRATEGIES).join(" + ")})${pattern && !rediscover ? ` from ${pattern.name}` : ""}`,
      { ...ev, data: { tool_id: tool.id, tool: tool.name, strategies: tool.strategies ?? STRATEGIES, pattern_id: tool.pattern_id } },
    );
  }

  const names = compiled.map((x) => x.name);
  await step(200);
  postMessage(sb.id, null, "tool_published", { site_id: siteId, tool: names.join(", "), tools: names, status: rediscover ? "reverify" : "draft" });
  finishJob(job, { capabilities: plan.caps.length, tools: compiled.length });

  // Verify on a different sandbox, then publish.
  const verify = insertJob("verify", siteId);
  await step(300);
  const vb = claim(verify, sb.id);
  const vev = { site: siteId, sandbox: vb.id };
  setSiteStatus(site, "verifying");
  addEvent("verify.start", `${vb.id} verifying ${compiled.length} tools compiled on ${sb.id}`, {
    ...vev,
    data: { job_id: verify.id, tools: names, compiled_by: sb.id },
  });
  const results = new Map<number, Strategies>();
  for (const tool of compiled) {
    await step(compiled.length > 2 ? 450 : 600);
    const s = measure(tool, !rediscover);
    results.set(tool.id, s);
    const [best, ms] = fastest(s);
    addEvent("verify.pass", `${tool.name} passed (${best}, ${ms} ms)`, {
      ...vev,
      data: { tool_id: tool.id, tool: tool.name, strategy: best, ms, strategies: s },
    });
  }
  await step(500);
  for (const tool of compiled) {
    const source: VersionSource = rediscover ? "reverify" : tool.pattern_id ? "reuse" : "discover";
    publishVersion(tool, source, vb.id, results.get(tool.id) ?? measure(tool));
    const pattern = tool.pattern_id ? world.patterns.find((p) => p.id === tool.pattern_id) : undefined;
    if (pattern && !rediscover) pattern.success_count += 1;
    addEvent("publish.tool", `published ${tool.name} v${tool.version} → MCP (${tool.best_strategy}, ${tool.p50_ms} ms)`, {
      ...vev,
      data: { tool_id: tool.id, tool: tool.name, version: tool.version, strategy: tool.best_strategy, ms: tool.p50_ms },
    });
  }
  await step(500);
  const apiMs = compiled.filter((x) => x.best_strategy === "api").map((x) => x.p50_ms ?? 0);
  const browserMs = compiled.map((x) => results.get(x.id)?.browser?.ms ?? 4200);
  addEvent(
    "optimize.result",
    `optimizer: api fastest for ${apiMs.length}/${compiled.length} tools (~${median(apiMs) ?? "—"} ms vs browser ${fmtMs(median(browserMs) ?? 4200)})`,
    { ...vev, data: { strategy: "api", ms: median(apiMs), browser_ms: median(browserMs), tools: names } },
  );
  await step(400);
  postMessage(vb.id, null, "validated", {
    site_id: siteId,
    tool: names.join(", "),
    version: Math.max(0, ...compiled.map((x) => x.version)),
  });
  await step(800);
  setSiteStatus(site, "ready");
  finishJob(verify, { passed: compiled.length });
  addEvent("publish.tool", `${site.name} is ready: ${compiled.length} verified tools on MCP`, {
    ...vev,
    data: { site_id: siteId, tools: compiled.length, mcp_url: `${apiBase()}/doorway/sites/${siteId}/mcp` },
  });
}

// ── Flow B: break → broken → repairing → verified (self-heal) ──────────────

function startHeal(siteId: string): Promise<void> {
  const world = w();
  const running = world.healing.get(siteId);
  if (running) return running;
  const flow = healFlow(siteId)
    .catch((err: unknown) => console.error("[doorway mock] heal failed", err))
    .finally(() => world.healing.delete(siteId));
  world.healing.set(siteId, flow);
  return flow;
}

async function healFlow(siteId: string): Promise<void> {
  const world = w();
  const site = siteById(siteId);
  if (!site) return;
  const { t0, at } = timeline();
  const to: ApiVersion = world.siteApi.get(siteId) ?? "v1";
  const tools = toolsOf(siteId).filter((x) => x.status !== "draft" && x.best_strategy === "api");
  if (!tools.length) return;
  const from: ApiVersion = world.toolApi.get(tools[0].id) ?? (to === "v1" ? "v2" : "v1");
  const errorFor = (tool: Tool) => `404 /api/${from}/${resourceFor(tool.name)}`;
  const names = tools.map((x) => x.name);

  // t+0.4 s: canary calls fail → tools broken, the board hears about it, a heal job is queued.
  await at(400);
  const spotter = pick(world.sandboxes.filter((s) => s.status !== "offline")).id;
  setSiteStatus(site, "broken");
  for (const tool of tools) {
    if (tool.status !== "verified") continue; // a fallback call already marked it repairing
    setToolStatus(tool, "broken");
    addEvent("tool.broken", `${tool.name} broke: ${errorFor(tool)}`, {
      site: siteId,
      sandbox: spotter,
      data: { tool_id: tool.id, tool: tool.name, error: errorFor(tool), strategy: "api", version: tool.version },
    });
  }
  postMessage(spotter, null, "broken", { site_id: siteId, tool: names.join(", "), reason: errorFor(tools[0]), api: `${from} → ${to}` });
  const job = insertJob("heal", siteId, tools.length === 1 ? tools[0].id : null);

  // t+1.5 s: a sandbox claims the heal and re-explores.
  await at(1500);
  const healer = claim(job);
  const hev = { site: siteId, sandbox: healer.id };
  setSiteStatus(site, "healing");
  for (const tool of tools) if (tool.status !== "repairing") setToolStatus(tool, "repairing");
  addEvent("heal.start", `${healer.id} re-exploring ${site.name}: private API changed (${from} → ${to})`, {
    ...hev,
    data: { job_id: job.id, from, to, tools: names },
  });
  const resources = unique(tools.map((x) => resourceFor(x.name))).slice(0, 2);
  for (const [i, r] of resources.entries()) {
    await at(1900 + i * 500);
    addEvent("explore.api", `found /api/${to}/${r} (fields renamed)`, {
      ...hev,
      data: { job_id: job.id, method: "GET", path: `/api/${to}/${r}`, status: 200 },
    });
  }

  // t+4 s: recompile, then verify on a different sandbox.
  for (const [i, tool] of tools.entries()) {
    await at(4000 + i * 150);
    addEvent("compile.tool", `recompiled ${tool.name} against /api/${to}/${resourceFor(tool.name)}`, {
      ...hev,
      data: { tool_id: tool.id, tool: tool.name, version: tool.version + 1, strategies: tool.strategies ?? STRATEGIES },
    });
  }
  const verify = insertJob("verify", siteId, tools.length === 1 ? tools[0].id : null);
  const verifier = claim(verify, healer.id);
  const vev = { site: siteId, sandbox: verifier.id };
  addEvent("verify.start", `${verifier.id} verifying ${tools.length} repaired tools (healed on ${healer.id})`, {
    ...vev,
    data: { job_id: verify.id, tools: names, healed_by: healer.id },
  });

  // t+6.5 s: verify.pass per tool.
  const results = new Map<number, Strategies>();
  for (const [i, tool] of tools.entries()) {
    await at(6500 + i * 200);
    const s = measure(tool);
    results.set(tool.id, s);
    const [best, ms] = fastest(s);
    addEvent("verify.pass", `${tool.name} passed (${best}, ${ms} ms)`, {
      ...vev,
      data: { tool_id: tool.id, tool: tool.name, strategy: best, ms, strategies: s },
    });
  }

  // t+8 s: new versions published, site ready again.
  await at(Math.max(8000, 6500 + tools.length * 200 + 300));
  setSiteStatus(site, "ready");
  for (const tool of tools) {
    publishVersion(tool, "heal", verifier.id, results.get(tool.id) ?? measure(tool));
    addEvent("heal.done", `${tool.name} healed → v${tool.version} (${tool.best_strategy}, ${tool.p50_ms} ms)`, {
      ...vev,
      data: { tool_id: tool.id, tool: tool.name, version: tool.version, strategy: tool.best_strategy, ms: tool.p50_ms, heal_ms: Date.now() - t0 },
    });
  }
  for (const tool of toolsOf(siteId)) world.toolApi.set(tool.id, world.siteApi.get(siteId) ?? "v1");
  addEvent("publish.tool", `republished ${tools.length} healed tools for ${site.name}`, {
    ...vev,
    data: { site_id: siteId, tools: names, api: to },
  });
  postMessage(verifier.id, null, "validated", {
    site_id: siteId,
    tool: names.join(", "),
    version: Math.max(...tools.map((x) => x.version)),
    healed: true,
  });
  finishJob(job, { healed: names, api: to, ms: Date.now() - t0 });
  finishJob(verify, { passed: tools.length });
}

// ── Flow C: race (browser agent vs broker) ─────────────────────────────────

const lane = (): RaceLane => ({ status: "queued", ms: null, steps: 0, tokens: 0, success: null, log: [] });

/** Inputs a person would type into the booking form: profile-backed ones first. */
function typedFields(action: Tool | null, args: Json): [string, string][] {
  if (!action) return [["full_name", "Ada Lovelace"], ["phone", "555-0100"]];
  const props = action.input_schema.properties ?? {};
  const names = unique([
    ...Object.keys(action.profile_fields),
    ...(action.input_schema.required ?? []).filter((n) => !n.endsWith("_id") && props[n]?.type === "string"),
  ]).slice(0, 2);
  return names.map((n) => [n, String(args[n] ?? "")]);
}

function ctaFor(action: Tool | null): string {
  const name = action?.name ?? "";
  if (name === "book_table") return "Reserve a table";
  if (name === "book_appointment") return "Book appointment";
  if (name === "place_hold") return "Search catalog";
  if (name.startsWith("book_")) return `Book a ${humanize(name.slice(5))}`;
  return name ? titleize(humanize(name)) : "Get started";
}

interface BrowserStep {
  action: string;
  detail: string;
  shot: ShotOptions | null;
}

function browserScript(site: Site, action: Tool | null, readData: unknown, typed: [string, string][], code: string): BrowserStep[] {
  const base = { site: site.name, url: site.base_url };
  const cta = ctaFor(action);
  const search = isRecord(readData) && Array.isArray(readData.results);
  const rows = isRecord(readData) ? (Array.isArray(readData.results) ? readData.results : Array.isArray(readData.slots) ? readData.slots : []) : [];
  const items = rows
    .filter(isRecord)
    .map((r) => (search ? String(r.title ?? r.id) : String(r.start ?? "").slice(11, 16) || String(r.id)));
  if (!items.length) items.push("09:00", "09:30", "10:30", "11:00", "14:00", "15:30");
  const list: ShotOptions = { ...base, url: `${site.base_url}${search ? "search" : "book"}`, scene: search ? "results" : "picker", items };
  const steps: BrowserStep[] = [
    { action: "screenshot", detail: "homepage", shot: { ...base, scene: "home", cta } },
    { action: "click", detail: `"${cta}"`, shot: { ...base, scene: "home", cta, target: "cta" } },
    { action: "screenshot", detail: search ? "search results" : "slot picker", shot: list },
    { action: "click", detail: search ? `"${items[0]}"` : `earliest slot ${items[0]}`, shot: { ...list, target: 0 } },
  ];
  for (const [name, value] of typed) steps.push({ action: "type", detail: `${humanize(name)}: ${value}`, shot: null });
  steps.push({ action: "submit", detail: `Confirmation ${code}`, shot: { ...base, scene: "confirm", code } });
  return steps;
}

const BROWSER_AT = [700, 1400, 2200, 3000, 3700, 4400, 5200];
const BROWSER_TOKENS = [2600, 5200, 8100, 10900, 13300, 15700, 18400];

async function raceFlow(raceId: string, jobId: number, inputs: Json): Promise<void> {
  const world = w();
  const race = world.races.get(raceId);
  const job = jobById(jobId);
  const site = race ? siteById(race.site_id) : undefined;
  if (!race || !job || !site) return;
  const { at } = timeline();
  const day = tomorrow();
  const code = confirmationCode(site.id);
  const ctx = { date: day, code, booked: new Set<string>() };
  const only = (tool: Tool) =>
    Object.fromEntries(Object.entries(inputs).filter(([k]) => k in (tool.input_schema.properties ?? {})));

  const tools = toolsOf(site.id).filter((x) => x.status !== "draft");
  const read = tools.find((x) => x.kind === "read" && /slot|search/.test(x.name)) ?? tools.find((x) => x.kind === "read") ?? null;
  const action = tools.find((x) => x.kind === "action" && /^(book|place)_/.test(x.name)) ?? tools.find((x) => x.kind === "action") ?? null;
  const readArgs = read ? sampleArgs(read, day, only(read)) : {};
  const readData = read ? toolResult(read, readArgs, ctx) : null;
  const rows = isRecord(readData) ? (Array.isArray(readData.slots) ? readData.slots : Array.isArray(readData.results) ? readData.results : []) : [];
  const firstId = isRecord(rows[0]) ? rows[0].id : undefined;
  const idKey = action ? ["slot_id", "book_id"].find((k) => k in (action.input_schema.properties ?? {})) : undefined;
  const actionArgs = action
    ? sampleArgs(action, day, { ...(idKey && firstId ? { [idKey]: firstId } : {}), ...only(action) })
    : {};
  const typed = typedFields(action, actionArgs);
  if (!race.inputs?.length) race.inputs = typed.map(([name]) => name);

  // t+0.3 s: both lanes start; the browser lane runs on a sandbox's Chromium.
  await at(300);
  const sb = claim(job);
  race.status = "running";
  race.broker.status = "running";
  race.browser.status = "running";
  saveRace(race);
  addEvent("request.received", `Race ${race.id}: ${race.task}`, { site: site.id, data: { race_id: race.id, task: race.task } });
  addEvent("execute.call", `browser agent started on ${sb.id} (Chromium + LLM)`, {
    site: site.id,
    sandbox: sb.id,
    data: { race_id: race.id, lane: "browser", strategy: "browser" },
  });

  const beats: { at: number; run: () => void }[] = [];
  const settle = () => {
    const done = (l: RaceLane) => l.status === "done" || l.status === "failed";
    if (done(race.broker) && done(race.browser)) race.status = "done";
    saveRace(race);
  };

  // Broker lane: the site's read tool, then its action tool (~110 + ~190 ms).
  const calls = [
    read ? { tool: read, args: readArgs, data: readData, short: false } : null,
    action ? { tool: action, args: actionArgs, data: toolResult(action, actionArgs, ctx), short: true } : null,
  ].filter((c): c is { tool: Tool; args: Json; data: unknown; short: boolean } => c !== null);
  if (!calls.length) {
    beats.push({
      at: 340,
      run: () => {
        race.broker = { status: "failed", ms: 40, steps: 1, tokens: 0, success: false, log: [{ step: 1, action: "lookup", detail: "no verified tool yet" }] };
        settle();
      },
    });
  }
  let elapsed = 0;
  calls.forEach((call, i) => {
    const slow = call.tool.status !== "verified" || mismatched(call.tool);
    const strategy = slow ? fallbackOf(call.tool) : (call.tool.best_strategy ?? "api");
    const ms = slow ? randInt(540, 700) : i === 0 ? randInt(100, 125) : randInt(170, 200);
    elapsed += ms;
    const total = elapsed;
    const last = i === calls.length - 1;
    beats.push({
      at: 300 + total,
      run: () => {
        race.broker.log.push({ step: i + 1, action: "call", detail: `${fmtCall(call.tool.name, call.args, call.short)} → ${summarize(call.data)}` });
        race.broker.steps = i + 1;
        race.broker.ms = total;
        if (last) {
          race.broker.status = "done";
          race.broker.success = true;
        }
        settle();
        addEvent("execute.call", `${call.tool.name} → ${strategy} (${ms} ms)`, {
          site: site.id,
          data: { race_id: race.id, lane: "broker", tool_id: call.tool.id, tool: call.tool.name, strategy, ms },
        });
        if (last) {
          recordRun({
            tool_id: call.tool.id,
            site_id: site.id,
            mode: "broker",
            strategy,
            status: "success",
            ms: total,
            steps: calls.length,
            tokens: 0,
            paid_reference: null,
            error: null,
          });
        }
      },
    });
  });

  // Browser lane: 7 steps over ~5 s, tokens piling up to ~18k.
  const script = browserScript(site, action, readData, typed, code);
  let tokens = 0;
  let browserMs = 0;
  script.forEach((s, i) => {
    const ms = (BROWSER_AT[i] ?? 5200 + i * 600) + randInt(-90, 90);
    const last = i === script.length - 1;
    beats.push({
      at: 300 + ms,
      run: () => {
        tokens = Math.max(tokens + 900, (BROWSER_TOKENS[i] ?? 18400) + randInt(-180, 180));
        browserMs = ms;
        race.browser.log.push({ step: i + 1, action: s.action, detail: s.detail, screenshot_url: s.shot ? screenshotUrl(s.shot) : null });
        race.browser.steps = i + 1;
        race.browser.ms = ms;
        race.browser.tokens = tokens;
        if (last) {
          race.browser.status = "done";
          race.browser.success = true;
        }
        settle();
      },
    });
  });

  beats.sort((a, b) => a.at - b.at);
  for (const beat of beats) {
    await at(beat.at);
    beat.run();
  }

  recordRun({
    tool_id: action?.id ?? null,
    site_id: site.id,
    mode: "browser_agent",
    strategy: "browser",
    status: "success",
    ms: browserMs,
    steps: script.length,
    tokens,
    paid_reference: null,
    error: null,
  });
  addEvent("execute.call", `browser agent finished: ${script.length} steps · ${fmtMs(browserMs)} · ${(tokens / 1000).toFixed(1)}k tokens`, {
    site: site.id,
    sandbox: sb.id,
    data: { race_id: race.id, lane: "browser", strategy: "browser", ms: browserMs, steps: script.length, tokens },
  });
  finishJob(job, { broker_ms: race.broker.ms, browser_ms: browserMs });
}

// ── Ambient life: heartbeats, agent traffic, optimizer, chatter ────────────

const AGENTS = ["claude-desktop", "claude-code", "cursor", "agent-sdk", "n8n"];
const HELLOS = [
  "idle · warm Chromium ready",
  "heartbeat ok · 3 browser contexts free",
  "cache warm for slot_booking",
  "pulled pattern catalog_search v1",
];
const TASKS: Record<string, string> = {
  list_doctors: "Which doctors can I see?",
  list_open_slots: "Find an open slot tomorrow",
  book_appointment: "Book the earliest appointment",
  contact_clinic: "Ask the clinic about referral letters",
  book_table: "Reserve a table for two tonight",
  get_menu: "What's on the menu tonight?",
  book_visit: "Book a checkup for my dog",
  search_books: "Find a copy of Dune",
  place_hold: "Put Dune on hold for me",
};

function heartbeat() {
  for (const sb of w().sandboxes) if (sb.status !== "offline") saveSandbox(sb);
}

async function ambientCall() {
  const tools = healthyTools();
  if (!tools.length) return;
  const tool = pick(tools);
  const requestId = `req_${hex(6)}`;
  addEvent("request.received", `Agent request: ${TASKS[tool.name] ?? titleize(humanize(tool.name))}`, {
    site: tool.site_id,
    data: { request_id: requestId, agent: pick(AGENTS), via: tool.kind === "action" ? "paymentLink" : "mcp", tool: tool.name },
  });
  await serveCall(tool, { gap: 250, requestId, args: sampleArgs(tool, tomorrow()) });
}

async function optimizeFlow() {
  const world = w();
  const tools = healthyTools();
  if (!tools.length || !world.sandboxes.some((s) => s.status === "idle")) return;
  const tool = pick(tools);
  const job = insertJob("optimize", tool.site_id, tool.id);
  await sleep(500);
  const sb = claim(job);
  await sleep(randInt(2800, 3300));
  const s = measure(tool);
  const [best, ms] = fastest(s);
  let message = `${tool.name}: ${strategyLine(s)} → keeps ${best}`;
  if (tool.status === "verified" && !mismatched(tool)) {
    if (best === tool.best_strategy && tool.p50_ms) tool.p50_ms = Math.round((tool.p50_ms * 3 + ms) / 4);
    saveTool(tool);
  } else {
    message = `${tool.name}: api failing, left to the heal job`;
  }
  addEvent("optimize.result", message, {
    site: tool.site_id,
    sandbox: sb.id,
    data: { job_id: job.id, tool_id: tool.id, tool: tool.name, strategy: best, ms, strategies: s },
  });
  finishJob(job, { best, ms });
}

function chatter() {
  const ids = w()
    .sandboxes.filter((s) => s.status !== "offline")
    .map((s) => s.id);
  if (ids.length < 2) return;
  const from = pick(ids);
  const tools = healthyTools();
  const r = Math.random();
  if (r < 0.34 || !tools.length) {
    postMessage(from, null, "hello", { text: pick(HELLOS) });
  } else if (r < 0.67) {
    const slots = tools.filter((x) => x.name === "list_open_slots");
    const tool = pick(slots.length ? slots : tools);
    postMessage(from, pick(ids.filter((id) => id !== from)), "need_tool", { site_id: tool.site_id, tool: tool.name });
  } else {
    const tool = pick(tools);
    postMessage(from, null, "validated", { tool: tool.name, version: tool.version, site_id: tool.site_id });
  }
}

let started = false;

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  w();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const every = (min: number, max: number, first: number, fn: () => void) => {
    const schedule = (ms: number) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        try {
          fn();
        } catch (err) {
          console.error("[doorway mock]", err);
        }
        schedule(rand(min, max));
      }, ms);
      timers.add(handle);
    };
    schedule(first);
  };
  every(2000, 2000, 2000, heartbeat);
  every(6000, 9000, 2500, () => spawn(ambientCall()));
  every(13000, 17000, 6000, () => spawn(optimizeFlow()));
  every(10000, 14000, 4000, chatter);
  // Hot reload: stop the previous module instance's timers.
  const g = globalThis as { __doorwayMockStop?: () => void };
  g.__doorwayMockStop?.();
  g.__doorwayMockStop = () => {
    timers.forEach(clearTimeout);
    timers.clear();
  };
}

// ── The API ────────────────────────────────────────────────────────────────

/** Every call: start the simulation, wait 80–200 ms, answer with a deep copy. */
async function respond<T>(fn: () => T | Promise<T>): Promise<T> {
  ensureStarted();
  await sleep(randInt(80, 200));
  return clone(await fn());
}

function siteOr404(id: string): Site {
  const site = siteById(id);
  if (!site) throw notFound();
  return site;
}

export const mockApi: DoorwayApi = {
  metrics: () =>
    respond(() => {
      const world = w();
      const ms = (mode: Run["mode"]) => world.runs.filter((r) => r.mode === mode && r.ms !== null).map((r) => r.ms ?? 0);
      const ok = world.runs.filter((r) => r.status === "success");
      return {
        sites: world.sites.length,
        tools_verified: world.tools.filter((t) => t.status === "verified").length,
        runs: world.runs.length,
        success_rate: world.runs.length ? Math.round((ok.length / world.runs.length) * 1000) / 1000 : null,
        broker_p50_ms: median(ms("broker")),
        browser_p50_ms: median(ms("browser_agent")),
        heals: world.heals,
        revenue_cents: ok.filter((r) => r.paid_reference).length * 50,
        patterns: world.patterns.length,
        reuse_count: world.patterns.reduce((sum, p) => sum + p.used_by.length, 0),
      };
    }),

  sites: () => respond(() => w().sites.map(siteView)),

  site: (id) =>
    respond(() => {
      const site = siteOr404(id);
      const world = w();
      return {
        site: siteView(site),
        capabilities: world.capabilities.filter((c) => c.site_id === id).sort((a, b) => a.id - b.id),
        tools: toolsOf(id).sort((a, b) => a.id - b.id),
        events: world.events.filter((e) => e.site_id === id).slice(-50).reverse(),
      };
    }),

  tools: (siteId) => respond(() => (siteId ? toolsOf(siteId) : w().tools).slice().sort((a, b) => a.id - b.id)),

  tool: (id) =>
    respond(() => {
      const world = w();
      const tool = toolById(id);
      if (!tool) throw notFound();
      return {
        tool,
        versions: [...(world.versions.get(id) ?? [])].reverse(),
        runs: world.runs.filter((r) => r.tool_id === id).slice(-20).reverse(),
        spec: specFor(tool, world.toolApi.get(id) ?? "v1"),
      };
    }),

  graph: () =>
    respond(() => {
      const world = w();
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      for (const s of world.sites) nodes.push({ id: `site:${s.id}`, type: "site", label: s.name, status: s.status });
      for (const c of world.capabilities) {
        nodes.push({ id: `cap:${c.id}`, type: "capability", label: c.name, status: c.status });
        edges.push({ from: `site:${c.site_id}`, to: `cap:${c.id}`, type: "has" });
        if (c.tool_id !== null) edges.push({ from: `cap:${c.id}`, to: `tool:${c.tool_id}`, type: "compiled_to" });
      }
      for (const t of world.tools) {
        nodes.push({ id: `tool:${t.id}`, type: "tool", label: t.name, status: t.status });
        if (t.pattern_id !== null) edges.push({ from: `tool:${t.id}`, to: `pattern:${t.pattern_id}`, type: "reuses" });
      }
      for (const p of world.patterns) nodes.push({ id: `pattern:${p.id}`, type: "pattern", label: p.name, status: "verified" });
      return { nodes, edges };
    }),

  sandboxes: () => respond(() => w().sandboxes),

  jobs: (status) =>
    respond(() =>
      w()
        .jobs.filter((j) => !status || j.status === status)
        .slice(-100)
        .reverse(),
    ),

  patterns: () => respond(() => w().patterns),

  messages: (since) =>
    respond(() => {
      const rows = w().messages;
      return since ? rows.filter((m) => m.id > since).slice(0, 200) : rows.slice(-200).reverse();
    }),

  events: (opts = {}) =>
    respond(() => {
      const rows = w().events.filter((e) => !opts.siteId || e.site_id === opts.siteId);
      return opts.since ? rows.filter((e) => e.id > (opts.since ?? 0)).slice(0, 200) : rows.slice(-200).reverse();
    }),

  race: (id) =>
    respond(() => {
      const race = w().races.get(id);
      if (!race) throw notFound();
      return race;
    }),

  addSite: (body) =>
    respond(() => {
      const world = w();
      const base = normalizeUrl(String(body?.url ?? ""));
      const name = body.name?.trim() || null;
      const goal = body.goal?.trim() || null;
      let site = world.sites.find((s) => bare(s.base_url) === bare(base));
      if (site) {
        // Known site: update it and discover again (like the backend's upsert).
        if (name) site.name = name;
        if (goal) site.goal = goal;
      } else {
        const id = freeId(name ? slugify(name) : slugForUrl(base));
        site = createSite({ id, name: name ?? titleize(id), base_url: base, goal });
      }
      addEvent("request.received", `Discovery requested for ${base}`, { site: site.id, data: { goal, url: base } });
      const running = busyJob(site.id);
      if (running !== null) return { site: siteView(site), job_id: running };
      setSiteStatus(site, "queued");
      const job = insertJob("discover", site.id);
      startDiscover(site.id, job.id);
      return { site: siteView(site), job_id: job.id };
    }),

  rediscover: (siteId) =>
    respond(() => {
      const site = siteOr404(siteId);
      addEvent("request.received", `Rediscovery requested for ${site.name}`, { site: siteId, data: { goal: site.goal } });
      const running = busyJob(siteId);
      if (running !== null) return { job_id: running };
      const job = insertJob("discover", siteId);
      startDiscover(siteId, job.id);
      return { job_id: job.id };
    }),

  breakSite: (siteId) =>
    respond(() => {
      siteOr404(siteId);
      const world = w();
      const current = world.siteApi.get(siteId) ?? "v1";
      if (world.healing.has(siteId)) return { version: current };
      const next: ApiVersion = current === "v1" ? "v2" : "v1";
      world.siteApi.set(siteId, next);
      if (toolsOf(siteId).some((t) => t.status !== "draft" && t.best_strategy === "api")) spawn(startHeal(siteId));
      return { version: next };
    }),

  resetSite: (siteId) =>
    respond(() => {
      siteOr404(siteId);
      const world = w();
      world.siteApi.set(siteId, "v1");
      for (const tool of toolsOf(siteId)) world.toolApi.set(tool.id, "v1");
      world.bookings.set(siteId, []);
      return { version: "v1" };
    }),

  startRace: (body) =>
    respond(() => {
      const site = siteOr404(String(body?.site_id ?? ""));
      const task = String(body.task ?? "").trim();
      if (task.length < 2) throw badField("task", "ensure this value has at least 2 characters");
      const inputs = isRecord(body.inputs) ? body.inputs : {};
      const race: Race = {
        id: `race_${hex(4)}`,
        site_id: site.id,
        task,
        status: "queued",
        created_at: nowIso(),
        browser: lane(),
        broker: lane(),
        inputs: Object.keys(inputs),
      };
      w().races.set(race.id, race);
      saveRace(race, "INSERT");
      const job = insertJob("race", site.id);
      spawn(raceFlow(race.id, job.id, inputs));
      return { race_id: race.id };
    }),

  runTool: (toolId, body) =>
    respond(async (): Promise<RunToolResult> => {
      const world = w();
      const tool = toolById(toolId);
      if (!tool || tool.status === "draft") throw notFound();
      const site = siteOr404(tool.site_id);
      const submitted: Json = {};
      for (const [k, v] of Object.entries(isRecord(body?.arguments) ? body.arguments : {})) if (!blank(v)) submitted[k] = v;
      const args: Json = { ...submitted };

      // Profile: only fields this person consented to share with this site.
      const filled: string[] = [];
      if (body.use_profile) {
        const consent = world.consents.find((c) => c.site_id === tool.site_id);
        for (const [input, field] of Object.entries(tool.profile_fields)) {
          const value = world.profile[field];
          if (blank(args[input]) && consent?.fields.includes(field) && value) {
            args[input] = value;
            filled.push(input);
          }
        }
      }
      const missing = (tool.input_schema.required ?? []).filter((name) => blank(args[name]));
      if (missing.length) throw new DoorwayError(422, "missing_inputs", { error: "missing_inputs", missing });
      coerce(tool, args);

      const payment = tool.kind === "action" && body.pay === "test" ? await payTest(tool) : null;
      const { strategy, healed } = await route(tool, site);
      const res = execute(tool, args, strategy, true);
      await sleep(res.ms);
      const run = recordRun({
        tool_id: tool.id,
        site_id: tool.site_id,
        mode: "dashboard",
        strategy,
        status: res.ok ? "success" : "failure",
        ms: res.ms,
        steps: 1,
        tokens: 0,
        paid_reference: payment?.reference ?? null,
        error: res.error,
      });
      addEvent(
        "execute.call",
        `${tool.name} ${res.ok ? "ok" : `failed: ${res.error}`} (${strategy}, ${fmtMs(res.ms)})${healed ? " after self-heal" : ""}`,
        { site: tool.site_id, data: { tool_id: tool.id, tool: tool.name, strategy, ms: res.ms, run_id: run.id, mode: "dashboard", ok: res.ok, healed } },
      );
      if (res.ok && body.remember) {
        for (const [input, field] of Object.entries(tool.profile_fields)) {
          if (!blank(submitted[input])) world.profile[field] = String(submitted[input]);
        }
      }
      const result: RunToolResult = {
        ok: res.ok,
        data: res.data,
        run,
        filled_from_profile: filled,
        error: res.error,
        strategy,
        ms: res.ms,
        healed,
      };
      if (payment) result.payment = payment;
      return result;
    }),

  profile: () => respond(() => ({ fields: { ...w().profile } })),

  saveProfile: (fields) =>
    respond(() => {
      const profile = w().profile;
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === undefined || value === null || String(value).trim() === "") delete profile[key];
        else profile[key] = String(value).trim();
      }
      return { fields: { ...profile } };
    }),

  consents: () => respond(() => [...w().consents].sort((a, b) => b.id - a.id)),

  grantConsent: (siteId, fields) =>
    respond(() => {
      siteOr404(siteId);
      const world = w();
      const clean = unique((fields ?? []).map(String).filter(Boolean));
      const existing = world.consents.find((c) => c.site_id === siteId);
      if (existing) {
        existing.fields = clean;
        existing.granted_at = nowIso();
        return existing;
      }
      const consent = { id: world.next.consent++, site_id: siteId, fields: clean, granted_at: nowIso() };
      world.consents.push(consent);
      return consent;
    }),

  revokeConsent: (id) =>
    respond(() => {
      const consents = w().consents;
      const index = consents.findIndex((c) => c.id === id);
      if (index < 0) throw notFound();
      consents.splice(index, 1);
    }),

  request: (body) =>
    respond((): AgentRequestCreated => {
      const world = w();
      const website = String(body?.website ?? "").trim();
      const task = String(body?.task ?? "").trim();
      if (website.length < 4) throw badField("website", "ensure this value has at least 4 characters");
      if (task.length < 2) throw badField("task", "ensure this value has at least 2 characters");
      const inputs = isRecord(body.inputs) ? body.inputs : {};
      const id = `req_${hex(6)}`;
      const received = (siteId: string, url: string) =>
        addEvent("request.received", `Agent request: ${task}`, {
          site: siteId,
          data: { request_id: id, website: url, inputs: Object.keys(inputs) },
        });

      let site = findSite(website);
      const req: AgentRequestState = {
        id,
        site_id: "",
        task,
        status: "discovering",
        inputs,
        tool_id: null,
        result: null,
        run: null,
        error: null,
      };
      if (!site) {
        // Lookup miss: add the site with the task as its goal and discover it.
        const url = normalizeUrl(website);
        site = createSite({ id: freeId(slugForUrl(url)), name: new URL(url).host, base_url: url, goal: task });
        received(site.id, url);
        addEvent("lookup.miss", `No verified tool yet for: ${task}`, { site: site.id, data: { request_id: id } });
        startDiscover(site.id, insertJob("discover", site.id).id);
      } else {
        received(site.id, site.base_url);
        const published = toolsOf(site.id).some((t) => t.status !== "draft");
        if (!published) {
          addEvent("lookup.miss", `No verified tool yet for: ${task}`, { site: site.id, data: { request_id: id } });
          if (!world.flows.has(site.id)) startDiscover(site.id, insertJob("discover", site.id).id);
        } else {
          const tool = matchTool(site.id, task);
          req.tool_id = tool?.id ?? null;
          if (!tool) {
            req.status = "failed";
            req.error = "no tool matches this task";
            addEvent("lookup.miss", `No tool matches: ${task}`, { site: site.id, data: { request_id: id } });
          } else if (tool.kind === "action") {
            // Agents pay for actions: hand out the paid run URL instead of acting.
            req.status = "done";
            req.result = paymentLink(tool, inputs);
            spawn(announceAction(tool, id));
          } else {
            req.status = "executing";
          }
        }
      }
      req.site_id = site.id;
      world.requests.set(id, req);
      if (req.status === "discovering" || req.status === "executing") spawn(agentFlow(req));
      const tool = req.tool_id !== null ? toolById(req.tool_id) : undefined;
      return { request_id: id, site_id: site.id, status: req.status, tool: tool ?? null };
    }),

  getRequest: (id) =>
    respond((): AgentRequest => {
      const req = w().requests.get(id);
      if (!req) throw notFound();
      const tool = req.tool_id !== null ? toolById(req.tool_id) : undefined;
      return {
        id: req.id,
        site_id: req.site_id,
        task: req.task,
        status: req.status,
        result: req.result,
        tool: tool ?? null,
        run: req.run,
        error: req.error,
      };
    }),
};

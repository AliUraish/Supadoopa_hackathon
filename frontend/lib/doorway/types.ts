// Doorway API types. Source of truth: backend/DOORWAY_API.md (contract v1).
// Every object here is what the HTTP API returns and what a Realtime row looks like.

export type SiteStatus =
  | "new"
  | "queued"
  | "discovering"
  | "verifying"
  | "ready"
  | "broken"
  | "healing"
  | "failed";
export type ToolStatus = "draft" | "verified" | "broken" | "repairing";
export type ToolKind = "read" | "action";
export type Strategy = "api" | "form" | "browser";
export const STRATEGIES: readonly Strategy[] = ["api", "form", "browser"];
export type JobKind = "discover" | "verify" | "heal" | "optimize" | "race";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type SandboxStatus = "idle" | "busy" | "offline";
export type RunMode = "broker" | "browser_agent" | "dashboard" | "verify";
export type RunStatus = "success" | "failure";
export type VersionSource = "discover" | "reuse" | "heal" | "reverify" | "seed";
export type RaceStatus = "queued" | "running" | "done" | "failed";

export const MESSAGE_KINDS = [
  "hello",
  "tool_published",
  "pattern_published",
  "need_tool",
  "validated",
  "broken",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const EVENT_KINDS = [
  "request.received",
  "lookup.hit",
  "lookup.miss",
  "discover.start",
  "explore.action",
  "explore.api",
  "observe.capability",
  "compile.tool",
  "reuse.pattern",
  "verify.start",
  "verify.pass",
  "verify.fail",
  "publish.tool",
  "optimize.result",
  "execute.call",
  "payment.challenge",
  "payment.paid",
  "tool.broken",
  "heal.start",
  "heal.done",
  "heal.fail",
  "sandbox.online",
  "sandbox.offline",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface Site {
  id: string; // slug, e.g. "sunrise-clinic"
  name: string;
  base_url: string;
  goal: string | null;
  status: SiteStatus;
  tools_count: number;
  verified_count: number;
  updated_at: string;
  mcp_url?: string | null; // as built: this site's MCP endpoint
}

export interface Capability {
  id: number;
  site_id: string;
  name: string;
  description: string | null;
  kind: ToolKind;
  status: string;
  tool_id: number | null;
}

// The subset of JSON Schema the "Try it" form understands.
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number)[];
  default?: unknown;
  format?: string;
  examples?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
}

export interface Tool {
  id: number;
  site_id: string;
  name: string;
  description: string | null;
  kind: ToolKind;
  status: ToolStatus;
  version: number;
  best_strategy: Strategy | null;
  p50_ms: number | null;
  success_rate: number | null; // 0–1
  runs_count: number;
  price_cents: number; // 50 for actions, 0 for reads
  pattern_id: number | null;
  input_schema: JsonSchema;
  profile_fields: Record<string, string>; // tool input → profile field
  updated_at: string;
  strategies?: Strategy[]; // as built: strategies this tool can run with
}

export interface StrategyResult {
  ms: number | null;
  passed: boolean;
}

export interface ToolVersion {
  version: number;
  status: "verified" | "broken";
  source: VersionSource;
  verified_by: string | null; // sandbox id
  strategies: Partial<Record<Strategy, StrategyResult>>;
  created_at: string;
}

export interface Run {
  id: number;
  tool_id: number | null;
  site_id: string | null;
  mode: RunMode;
  strategy: Strategy | null;
  status: RunStatus;
  ms: number | null;
  steps: number | null;
  tokens: number | null;
  paid_reference: string | null;
  error: string | null;
  created_at: string;
}

export interface Sandbox {
  id: string; // "sandbox-1"
  status: SandboxStatus;
  current_job_id: number | null;
  site_id: string | null;
  job_kind: JobKind | null;
  jobs_done: number;
  last_heartbeat: string | null;
  started_at: string | null;
}

export interface Job {
  id: number;
  kind: JobKind;
  site_id: string | null;
  tool_id: number | null;
  status: JobStatus;
  claimed_by: string | null;
  attempts: number;
  result: unknown;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Pattern {
  id: number;
  name: string;
  description: string | null;
  created_by: string | null;
  source_site_id: string | null;
  used_by: string[]; // site ids
  success_count: number;
  created_at: string;
}

export interface Message {
  id: number;
  from_sandbox: string;
  to_sandbox: string | null; // null = broadcast
  kind: MessageKind;
  body: Record<string, unknown> | null;
  created_at: string;
}

export interface DoorwayEvent {
  id: number;
  site_id: string | null;
  sandbox_id: string | null;
  kind: EventKind;
  message: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface RaceLogEntry {
  step: number;
  action: string; // screenshot | click | type | submit | call | …
  detail: string;
  screenshot_url?: string | null;
}

export interface RaceLane {
  status: RaceStatus;
  ms: number | null;
  steps: number;
  tokens: number;
  success: boolean | null;
  log: RaceLogEntry[];
}

export interface Race {
  id: string;
  site_id: string;
  task: string;
  status: RaceStatus;
  created_at: string;
  browser: RaceLane;
  broker: RaceLane;
  inputs?: string[] | null; // as built: input names only, values stay private
}

export interface Metrics {
  sites: number;
  tools_verified: number;
  runs: number;
  success_rate: number | null; // 0–1
  broker_p50_ms: number | null;
  browser_p50_ms: number | null;
  heals: number;
  revenue_cents: number;
  patterns: number;
  reuse_count: number;
}

export type GraphNodeType = "site" | "capability" | "tool" | "pattern";
export interface GraphNode {
  id: string; // "site:x" | "cap:12" | "tool:31" | "pattern:4"
  type: GraphNodeType;
  label: string;
  status: string | null;
}
export type GraphEdgeType = "has" | "compiled_to" | "reuses";
export interface GraphEdge {
  from: string;
  to: string;
  type: GraphEdgeType;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SiteDetail {
  site: Site;
  capabilities: Capability[];
  tools: Tool[];
  events: DoorwayEvent[];
}

export interface ToolDetail {
  tool: Tool;
  versions: ToolVersion[];
  runs: Run[];
  spec?: unknown; // as built: the declarative tool spec
}

export const PROFILE_FIELDS = ["full_name", "email", "phone", "address"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface Profile {
  fields: Partial<Record<string, string>>;
}

export interface Consent {
  id: number;
  site_id: string;
  fields: string[];
  granted_at: string;
}

export interface RunToolBody {
  arguments: Record<string, unknown>;
  use_profile?: boolean;
  remember?: boolean;
  pay?: "test";
}

export interface Payment {
  reference: string;
  amount_cents: number;
  receipt: unknown;
}

export interface RunToolResult {
  ok: boolean;
  data: unknown;
  run: Run;
  filled_from_profile: string[]; // tool input names filled from the profile
  payment?: Payment | null;
  // as built:
  error?: string | null;
  strategy?: Strategy | null;
  ms?: number | null;
  healed?: boolean; // the tool broke, healed, and the call was retried
}

// Agent-facing broker request (POST /doorway/requests).
export type AgentRequestStatus = "discovering" | "executing" | "done" | "failed";
export interface AgentRequestCreated {
  request_id: string;
  site_id: string;
  status: AgentRequestStatus;
  tool?: Tool | null;
}
// As built: read tasks return "executing" (poll for done/failed); action tasks return
// "done" at once with result = the paymentLink payload (agents pay at /doorway/run/...);
// unknown sites return "discovering" until a matching tool is verified.
export interface AgentRequest {
  id?: string;
  site_id?: string;
  task?: string;
  status: AgentRequestStatus;
  result?: unknown;
  tool?: Tool | null;
  run?: Run | null;
  error?: string | null;
}

// GET /doorway/live: the Supabase Compute page that streams every sandbox's browser.
export interface LiveView {
  url: string; // self-contained page (pipeline strip, ~1 fps screens, event feed)
  state_url: string; // JSON state behind it, for a custom UI
}

// ── Realtime ──────────────────────────────────────────────────────────────
// Tables the browser may subscribe to (read-only, INSERT + UPDATE).
export interface RealtimeRows {
  doorway_events: DoorwayEvent;
  doorway_sandboxes: Sandbox;
  doorway_jobs: Job;
  doorway_tools: Tool;
  doorway_messages: Message;
  doorway_races: Race;
  doorway_runs: Run;
}
export type RealtimeTable = keyof RealtimeRows;
export const REALTIME_TABLES: readonly RealtimeTable[] = [
  "doorway_events",
  "doorway_sandboxes",
  "doorway_jobs",
  "doorway_tools",
  "doorway_messages",
  "doorway_races",
  "doorway_runs",
];

export interface RowChange<T extends RealtimeTable = RealtimeTable> {
  table: T;
  type: "INSERT" | "UPDATE";
  row: RealtimeRows[T];
}

// "live" = rows are pushed (Realtime or the mock stream); "down" = poll instead.
export type BusStatus = "connecting" | "live" | "down";

export interface LiveBus {
  subscribe(table: RealtimeTable, cb: (change: RowChange) => void): () => void;
  status(): BusStatus;
  onStatus(cb: (status: BusStatus) => void): () => void;
}

// ── The client surface. lib/doorway.ts picks the HTTP or mock implementation. ──
export interface DoorwayApi {
  // reads (public)
  metrics(): Promise<Metrics>;
  sites(): Promise<Site[]>;
  site(id: string): Promise<SiteDetail>;
  tools(siteId?: string): Promise<Tool[]>;
  tool(id: number): Promise<ToolDetail>;
  graph(): Promise<Graph>;
  sandboxes(): Promise<Sandbox[]>;
  jobs(status?: JobStatus): Promise<Job[]>;
  patterns(): Promise<Pattern[]>;
  messages(since?: number): Promise<Message[]>;
  events(opts?: { siteId?: string; since?: number }): Promise<DoorwayEvent[]>;
  race(id: string): Promise<Race>;
  // dashboard actions (🔒 Bearer token)
  addSite(body: { url: string; name?: string; goal?: string }): Promise<{ site: Site; job_id: number }>;
  rediscover(siteId: string): Promise<{ job_id: number }>;
  breakSite(siteId: string): Promise<{ version: string }>;
  resetSite(siteId: string): Promise<{ version: string }>;
  startRace(body: { site_id: string; task: string; inputs?: Record<string, unknown> }): Promise<{ race_id: string }>;
  runTool(toolId: number, body: RunToolBody): Promise<RunToolResult>;
  profile(): Promise<Profile>;
  saveProfile(fields: Profile["fields"]): Promise<Profile>;
  consents(): Promise<Consent[]>;
  grantConsent(siteId: string, fields: string[]): Promise<Consent>;
  revokeConsent(id: number): Promise<void>;
  // agent-facing broker
  request(body: { website: string; task: string; inputs?: Record<string, unknown> }): Promise<AgentRequestCreated>;
  getRequest(id: string): Promise<AgentRequest>;
}

// One typed client for the Doorway API (contract: backend/DOORWAY_API.md).
//
// NEXT_PUBLIC_DOORWAY_MOCK=1 swaps in lib/doorway/mock.ts: fixtures plus a fake live
// stream that runs in the browser. Flipping it to 0 needs no code changes.
//
// Base URL: DOORWAY_API_URL on the server, NEXT_PUBLIC_DOORWAY_API_URL in the browser.
// Write actions (🔒) send the Supabase session's access token. When nobody is signed
// in, the browser quietly starts an anonymous Supabase session so the demo never asks
// anyone to log in (needs "Anonymous sign-ins" enabled in Supabase Auth). If that fails the
// call goes out without a token, which the backend accepts as a shared demo user when it
// runs with DOORWAY_DEMO_OPEN=1.

import { createClient } from "@/lib/supabase/client";
import { mockApi, mockBus } from "@/lib/doorway/mock";
import { supabaseBus } from "@/lib/doorway/bus";
import { DoorwayError, parseDetail } from "@/lib/doorway/errors";
import type {
  AgentRequest,
  AgentRequestCreated,
  Consent,
  DoorwayApi,
  DoorwayEvent,
  Graph,
  Job,
  JobStatus,
  LiveBus,
  LiveView,
  Message,
  Metrics,
  Pattern,
  Profile,
  Race,
  RunToolBody,
  RunToolResult,
  Sandbox,
  Site,
  SiteDetail,
  Tool,
  ToolDetail,
} from "@/lib/doorway/types";

export * from "@/lib/doorway/types";
export { DoorwayError, describeError } from "@/lib/doorway/errors";

export const DOORWAY_MOCK = process.env.NEXT_PUBLIC_DOORWAY_MOCK === "1";

export function doorwayBaseUrl(): string {
  const url =
    typeof window === "undefined"
      ? (process.env.DOORWAY_API_URL ?? process.env.NEXT_PUBLIC_DOORWAY_API_URL)
      : process.env.NEXT_PUBLIC_DOORWAY_API_URL;
  return (url ?? "").replace(/\/+$/, "");
}

// What agents paste to connect (shown in "Connect your agent").
export function mcpUrl(siteId?: string): string {
  const base = process.env.NEXT_PUBLIC_DOORWAY_API_URL?.replace(/\/+$/, "") || "http://localhost:8000";
  return siteId ? `${base}/doorway/sites/${siteId}/mcp` : `${base}/doorway/mcp`;
}

// ── Auth ───────────────────────────────────────────────────────────────────

let anonFailed = false;
// Parallel first calls share one anonymous sign-in instead of creating several users.
let anonSignIn: Promise<string | null> | null = null;

async function accessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null; // server-side calls are public reads
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return null;
  }
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  if (anonFailed) return null;
  // Nobody signed in: start an invisible anonymous session instead of a login wall.
  anonSignIn ??= supabase.auth.signInAnonymously().then(({ data: anon, error }) => {
    anonSignIn = null;
    if (error || !anon.session) {
      anonFailed = true;
      return null;
    }
    return anon.session.access_token;
  });
  return anonSignIn;
}

// ── HTTP implementation ────────────────────────────────────────────────────

type Init = { method?: string; body?: unknown; auth?: boolean };

async function http<T>(path: string, { method = "GET", body, auth = false }: Init = {}): Promise<T> {
  const base = doorwayBaseUrl();
  if (!base) {
    throw new DoorwayError(503, "not_configured", {
      error: "not_configured",
      missing: ["NEXT_PUBLIC_DOORWAY_API_URL"],
    });
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = await accessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new DoorwayError(0, "unreachable");
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw parseDetail(res.status, json);
  return json as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

const enc = encodeURIComponent;

export const httpApi: DoorwayApi = {
  metrics: () => http<Metrics>("/doorway/metrics"),
  sites: () => http<Site[]>("/doorway/sites"),
  site: (id) => http<SiteDetail>(`/doorway/sites/${enc(id)}`),
  tools: (siteId) => http<Tool[]>(`/doorway/tools${qs({ site_id: siteId })}`),
  tool: (id) => http<ToolDetail>(`/doorway/tools/${id}`),
  graph: () => http<Graph>("/doorway/graph"),
  sandboxes: () => http<Sandbox[]>("/doorway/sandboxes"),
  jobs: (status?: JobStatus) => http<Job[]>(`/doorway/jobs${qs({ status })}`),
  patterns: () => http<Pattern[]>("/doorway/patterns"),
  messages: (since) => http<Message[]>(`/doorway/messages${qs({ since })}`),
  events: (opts = {}) =>
    http<DoorwayEvent[]>(`/doorway/events${qs({ site_id: opts.siteId, since: opts.since })}`),
  race: (id) => http<Race>(`/doorway/races/${enc(id)}`),

  addSite: (body) => http("/doorway/sites", { method: "POST", body, auth: true }),
  rediscover: (siteId) => http(`/doorway/sites/${enc(siteId)}/rediscover`, { method: "POST", auth: true }),
  breakSite: (siteId) => http(`/doorway/sites/${enc(siteId)}/break`, { method: "POST", auth: true }),
  resetSite: (siteId) => http(`/doorway/sites/${enc(siteId)}/reset`, { method: "POST", auth: true }),
  startRace: (body) => http("/doorway/race", { method: "POST", body, auth: true }),
  runTool: (toolId, body: RunToolBody) =>
    http<RunToolResult>(`/doorway/tools/${toolId}/run`, { method: "POST", body, auth: true }),
  profile: () => http<Profile>("/doorway/profile", { auth: true }),
  saveProfile: (fields) => http<Profile>("/doorway/profile", { method: "PUT", body: { fields }, auth: true }),
  consents: () => http<Consent[]>("/doorway/consents", { auth: true }),
  grantConsent: (siteId, fields) =>
    http<Consent>("/doorway/consents", { method: "POST", body: { site_id: siteId, fields }, auth: true }),
  revokeConsent: (id) => http<void>(`/doorway/consents/${id}`, { method: "DELETE", auth: true }),

  request: (body) => http<AgentRequestCreated>("/doorway/requests", { method: "POST", body }),
  getRequest: (id) => http<AgentRequest>(`/doorway/requests/${enc(id)}`),
};

export const doorway: DoorwayApi = DOORWAY_MOCK ? mockApi : httpApi;

// The live sandbox view always comes from the real backend, even in mock mode:
// it streams the actual Supabase Compute workers.
export const fetchLiveView = () => http<LiveView>("/doorway/live");

// Push channel for live views: the mock stream, or Supabase Realtime.
export function liveBus(): LiveBus {
  return DOORWAY_MOCK ? mockBus : supabaseBus();
}

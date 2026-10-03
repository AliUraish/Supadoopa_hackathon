// The mock's world at startup: four demo sites with their tools, versions and capabilities,
// three shared patterns, four Supabase Compute sandboxes and ~3 hours of history.
// Pure data: createWorld(now) builds it (seeded, so every load looks the same).

import { DOCTORS, isoDay } from "@/lib/doorway/mock-data";
import {
  STRATEGIES,
  type AgentRequestStatus,
  type Capability,
  type Consent,
  type DoorwayEvent,
  type EventKind,
  type Job,
  type JobKind,
  type JsonSchema,
  type Message,
  type MessageKind,
  type Pattern,
  type Race,
  type Run,
  type RunMode,
  type Sandbox,
  type Site,
  type Strategy,
  type StrategyResult,
  type Tool,
  type ToolKind,
  type ToolVersion,
  type VersionSource,
} from "@/lib/doorway/types";

export type ApiVersion = "v1" | "v2";

export interface Booking {
  tool_id: number;
  slot_id: string | null;
  confirmation: string;
  created_at: string;
}

export interface AgentRequestState {
  id: string;
  site_id: string;
  task: string;
  status: AgentRequestStatus;
  inputs: Record<string, unknown>;
  tool_id: number | null;
  result: unknown;
  run: Run | null;
  error: string | null;
}

export interface World {
  sites: Site[]; // newest first
  capabilities: Capability[];
  tools: Tool[];
  versions: Map<number, ToolVersion[]>; // per tool, oldest first
  patterns: Pattern[];
  sandboxes: Sandbox[];
  sandboxJobs: Map<string, number[]>; // jobs a sandbox is running right now
  jobs: Job[];
  runs: Run[];
  messages: Message[];
  events: DoorwayEvent[];
  races: Map<string, Race>;
  requests: Map<string, AgentRequestState>;
  profile: Record<string, string>;
  consents: Consent[];
  siteApi: Map<string, ApiVersion>; // the demo site's live private API
  toolApi: Map<number, ApiVersion>; // the API version a tool was compiled against
  bookings: Map<string, Booking[]>;
  flows: Map<string, Promise<void>>; // running discover flows, by site
  healing: Map<string, Promise<void>>; // running heal flows, by site
  heals: number; // heal.done events so far
  next: { event: number; message: number; run: number; job: number; tool: number; cap: number; consent: number };
}

export const SANDBOX_IDS = ["sandbox-1", "sandbox-2", "sandbox-3", "sandbox-4"] as const;

// Deterministic jitter for fixtures (mulberry32).
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "string",
  description,
  ...extra,
});

interface VersionSeed {
  source: VersionSource;
  by: string;
  ago: number; // minutes
}

interface ToolSeed {
  site: string;
  name: string;
  kind: ToolKind;
  description: string;
  props: Record<string, JsonSchema>;
  required: string[];
  best: Strategy;
  p50: number;
  success: number;
  runs: number;
  pattern: number | null;
  profile?: Record<string, string>;
  noApi?: boolean; // no private JSON endpoint: form is the fastest path
  noForm?: boolean; // the HTML form path fails verification
  versions: VersionSeed[];
}

function toolSeeds(day: string): ToolSeed[] {
  const date = str("Day as YYYY-MM-DD", { format: "date", examples: [day] });
  const slot = str("Slot id from list_open_slots", { examples: ["s_0900"] });
  const phone = str("Contact phone number", { examples: ["555-0100"] });
  const fullName = (description: string) => str(description, { examples: ["Ada Lovelace"] });
  const party: JsonSchema = { type: "integer", description: "Number of guests", minimum: 1, maximum: 12, examples: [2] };
  return [
    {
      site: "sunrise-clinic",
      name: "list_doctors",
      kind: "read",
      description: "List the clinic's doctors with their id, name and specialty. Use the id with list_open_slots.",
      props: {},
      required: [],
      best: "api",
      p50: 62,
      success: 0.99,
      runs: 214,
      pattern: null,
      versions: [{ source: "seed", by: "sandbox-2", ago: 170 }],
    },
    {
      site: "sunrise-clinic",
      name: "list_open_slots",
      kind: "read",
      description: "List open appointment slots (id and time) for one doctor on one day.",
      props: {
        doctor_id: str("Doctor id from list_doctors", { enum: DOCTORS.map((d) => d.id), examples: ["dr-rivera"] }),
        date,
      },
      required: ["doctor_id", "date"],
      best: "api",
      p50: 84,
      success: 0.98,
      runs: 388,
      pattern: 4,
      versions: [
        { source: "discover", by: "sandbox-2", ago: 170 },
        { source: "heal", by: "sandbox-2", ago: 92 },
      ],
    },
    {
      site: "sunrise-clinic",
      name: "book_appointment",
      kind: "action",
      description: "Book an open slot for a patient. Returns the appointment reference.",
      props: { slot_id: slot, patient_name: fullName("Patient's full name"), phone },
      required: ["slot_id", "patient_name", "phone"],
      best: "api",
      p50: 91,
      success: 0.97,
      runs: 142,
      pattern: 4,
      profile: { patient_name: "full_name", phone: "phone" },
      versions: [
        { source: "discover", by: "sandbox-2", ago: 170 },
        { source: "heal", by: "sandbox-2", ago: 92 },
      ],
    },
    {
      site: "sunrise-clinic",
      name: "contact_clinic",
      kind: "action",
      description: "Send the clinic's front desk a message through its contact form.",
      props: {
        full_name: fullName("Your full name"),
        email: str("Reply-to email", { format: "email", examples: ["ada@example.com"] }),
        message: str("What you need", { examples: ["Can I bring my referral letter to the appointment?"] }),
      },
      required: ["full_name", "email", "message"],
      best: "form",
      p50: 640,
      success: 0.96,
      runs: 31,
      pattern: 6,
      profile: { full_name: "full_name", email: "email" },
      noApi: true,
      versions: [{ source: "discover", by: "sandbox-1", ago: 169 }],
    },
    {
      site: "bella-bistro",
      name: "list_open_slots",
      kind: "read",
      description: "List free tables for a party size on one evening.",
      props: { party_size: party, date },
      required: ["party_size", "date"],
      best: "api",
      p50: 71,
      success: 0.99,
      runs: 263,
      pattern: 4,
      versions: [{ source: "reuse", by: "sandbox-4", ago: 157 }],
    },
    {
      site: "bella-bistro",
      name: "book_table",
      kind: "action",
      description: "Reserve a table slot for a party. Returns the reservation code.",
      props: { slot_id: slot, guest_name: fullName("Name for the reservation"), phone, party_size: party },
      required: ["slot_id", "guest_name", "phone", "party_size"],
      best: "api",
      p50: 96,
      success: 0.98,
      runs: 97,
      pattern: 4,
      profile: { guest_name: "full_name", phone: "phone" },
      versions: [
        { source: "reuse", by: "sandbox-4", ago: 157 },
        { source: "reverify", by: "sandbox-3", ago: 70 },
      ],
    },
    {
      site: "bella-bistro",
      name: "get_menu",
      kind: "read",
      description: "Tonight's menu with prices.",
      props: { section: str("Only one section of the menu", { enum: ["Starters", "Mains", "Desserts"] }) },
      required: [],
      best: "api",
      p50: 58,
      success: 1,
      runs: 122,
      pattern: null,
      noForm: true,
      versions: [{ source: "discover", by: "sandbox-4", ago: 156 }],
    },
    {
      site: "pawsome-vet",
      name: "list_open_slots",
      kind: "read",
      description: "List open visit slots for a service on one day.",
      props: {
        service: str("Type of visit", { enum: ["checkup", "vaccination", "grooming"], examples: ["checkup"] }),
        date,
      },
      required: ["service", "date"],
      best: "api",
      p50: 77,
      success: 0.99,
      runs: 176,
      pattern: 4,
      versions: [{ source: "reuse", by: "sandbox-4", ago: 148 }],
    },
    {
      site: "pawsome-vet",
      name: "book_visit",
      kind: "action",
      description: "Book a vet visit for a pet in an open slot.",
      props: {
        slot_id: slot,
        owner_name: fullName("Owner's full name"),
        pet_name: str("Pet's name", { examples: ["Biscuit"] }),
        phone,
      },
      required: ["slot_id", "owner_name", "pet_name", "phone"],
      best: "api",
      p50: 102,
      success: 0.97,
      runs: 64,
      pattern: 4,
      profile: { owner_name: "full_name", phone: "phone" },
      versions: [{ source: "reuse", by: "sandbox-4", ago: 148 }],
    },
    {
      site: "city-library",
      name: "search_books",
      kind: "read",
      description: "Search the catalog by title or author, optionally only books on the shelf.",
      props: {
        query: str("Title or author", { examples: ["dune"] }),
        available_only: { type: "boolean", description: "Only copies on the shelf right now", default: false },
      },
      required: ["query"],
      best: "api",
      p50: 118,
      success: 0.99,
      runs: 301,
      pattern: 5,
      versions: [
        { source: "discover", by: "sandbox-2", ago: 136 },
        { source: "heal", by: "sandbox-4", ago: 61 },
        { source: "reverify", by: "sandbox-1", ago: 45 },
      ],
    },
    {
      site: "city-library",
      name: "place_hold",
      kind: "action",
      description: "Place a hold on a book for pickup at the front desk.",
      props: {
        book_id: str("Book id from search_books", { examples: ["bk_1041"] }),
        full_name: fullName("Card holder's full name"),
        email: str("Email for the pickup notice", { format: "email", examples: ["ada@example.com"] }),
        library_card: str("Library card number", { examples: ["LIB-20931"] }),
      },
      required: ["book_id", "full_name", "email", "library_card"],
      best: "api",
      p50: 134,
      success: 0.95,
      runs: 58,
      pattern: 5,
      profile: { full_name: "full_name", email: "email" },
      versions: [{ source: "discover", by: "sandbox-2", ago: 136 }],
    },
  ];
}

const SITES: [id: string, name: string, port: number, goal: string, ago: number][] = [
  ["sunrise-clinic", "Sunrise Family Clinic", 8790, "Book a doctor's appointment", 92],
  ["bella-bistro", "Bella Bistro", 8791, "Reserve a table", 70],
  ["pawsome-vet", "Pawsome Vet", 8792, "Book a vet visit", 148],
  ["city-library", "City Library", 8793, "Search books and place a hold", 45],
];

type Data = Record<string, unknown>;

export function createWorld(now: number): World {
  const rnd = seeded(20261003);
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const jitter = (base: number, spread: number) => Math.round(base + (rnd() - 0.5) * 2 * spread);
  const day = isoDay(now + 86_400_000);

  const sites: Site[] = SITES.map(([id, name, port, goal, updated]) => ({
    id,
    name,
    base_url: `http://localhost:${port}/`,
    goal,
    status: "ready",
    tools_count: 0,
    verified_count: 0,
    updated_at: ago(updated),
  }));

  // Tools, their versions and one capability each.
  const tools: Tool[] = [];
  const versions = new Map<number, ToolVersion[]>();
  const capabilities: Capability[] = [];
  let capId = 1;
  let toolId = 31;
  for (const seed of toolSeeds(day)) {
    const id = toolId++;
    const history: ToolVersion[] = seed.versions.map((v, i) => {
      const latest = i === seed.versions.length - 1;
      const formFlaky = !latest && rnd() < 0.3;
      const strategies: Partial<Record<Strategy, StrategyResult>> = {
        api: seed.noApi ? { ms: null, passed: false } : { ms: latest ? seed.p50 : jitter(seed.p50, 12), passed: true },
        form: seed.noForm
          ? { ms: null, passed: false }
          : { ms: seed.best === "form" && latest ? seed.p50 : jitter(620, 80), passed: !formFlaky },
        browser: { ms: jitter(4200, 400), passed: true },
      };
      // A heal retires everything before it (it targeted the old private API).
      const healedLater = seed.versions.slice(i + 1).some((n) => n.source === "heal");
      return {
        version: i + 1,
        status: healedLater ? "broken" : "verified",
        source: v.source,
        verified_by: v.by,
        strategies,
        created_at: ago(v.ago),
      };
    });
    versions.set(id, history);
    const latest = history[history.length - 1];
    tools.push({
      id,
      site_id: seed.site,
      name: seed.name,
      description: seed.description,
      kind: seed.kind,
      status: "verified",
      version: latest.version,
      best_strategy: seed.best,
      p50_ms: seed.p50,
      success_rate: seed.success,
      runs_count: seed.runs,
      price_cents: seed.kind === "action" ? 50 : 0,
      pattern_id: seed.pattern,
      input_schema: { type: "object", properties: seed.props, required: seed.required },
      profile_fields: seed.profile ?? {},
      updated_at: latest.created_at,
      strategies: STRATEGIES.filter((s) => latest.strategies[s]?.passed),
    });
    capabilities.push({
      id: capId++,
      site_id: seed.site,
      name: seed.name,
      description: seed.description,
      kind: seed.kind,
      status: "verified",
      tool_id: id,
    });
    if (seed.name === "contact_clinic") {
      // Seen on the confirmation page but behind a login: observed, never compiled.
      capabilities.push({
        id: capId++,
        site_id: "sunrise-clinic",
        name: "cancel_appointment",
        description: "Cancel a booked appointment (behind the patient login; not compiled yet).",
        kind: "action",
        status: "observed",
        tool_id: null,
      });
    }
  }
  const tid = (site: string, name: string) => tools.find((t) => t.site_id === site && t.name === name)?.id ?? null;

  const patterns: Pattern[] = [
    {
      id: 4,
      name: "slot_booking",
      description: "list slots → book slot with name + phone",
      created_by: "sandbox-1",
      source_site_id: "sunrise-clinic",
      used_by: ["bella-bistro", "pawsome-vet"],
      success_count: 9,
      created_at: ago(171),
    },
    {
      id: 5,
      name: "catalog_search",
      description: "search a catalog → hold an item with name + email",
      created_by: "sandbox-3",
      source_site_id: "city-library",
      used_by: [],
      success_count: 4,
      created_at: ago(137),
    },
    {
      id: 6,
      name: "contact_form",
      description: "fill name + email + message → submit the contact form",
      created_by: "sandbox-1",
      source_site_id: "sunrise-clinic",
      used_by: [],
      success_count: 2,
      created_at: ago(168),
    },
  ];

  const jobsDone = [14, 11, 17, 9];
  const sandboxes: Sandbox[] = SANDBOX_IDS.map((id, i) => ({
    id,
    status: "idle",
    current_job_id: null,
    site_id: null,
    job_kind: null,
    jobs_done: jobsDone[i],
    last_heartbeat: new Date(now).toISOString(),
    started_at: ago(181 - i),
  }));

  // [kind, site, tool, sandbox, minutes ago, seconds it took, result]
  const JOBS: [JobKind, string, string | null, string, number, number, Data][] = [
    ["discover", "sunrise-clinic", null, "sandbox-1", 175, 6, { capabilities: 5, tools: 4 }],
    ["verify", "sunrise-clinic", null, "sandbox-2", 170, 4, { passed: 4 }],
    ["discover", "bella-bistro", null, "sandbox-3", 160, 5, { capabilities: 3, tools: 3, pattern: "slot_booking" }],
    ["verify", "bella-bistro", null, "sandbox-4", 157, 4, { passed: 3 }],
    ["discover", "pawsome-vet", null, "sandbox-1", 150, 4, { capabilities: 2, tools: 2, pattern: "slot_booking" }],
    ["verify", "pawsome-vet", null, "sandbox-4", 148, 3, { passed: 2 }],
    ["discover", "city-library", null, "sandbox-3", 140, 6, { capabilities: 2, tools: 2 }],
    ["verify", "city-library", null, "sandbox-2", 136, 4, { passed: 2 }],
    ["optimize", "bella-bistro", "book_table", "sandbox-2", 120, 3, { best: "api", ms: 96 }],
    ["race", "sunrise-clinic", null, "sandbox-1", 110, 5, { broker_ms: 302, browser_ms: 4870 }],
    ["optimize", "sunrise-clinic", "list_doctors", "sandbox-3", 100, 3, { best: "api", ms: 62 }],
    ["heal", "sunrise-clinic", null, "sandbox-4", 95, 7, { healed: ["list_open_slots", "book_appointment"] }],
    ["verify", "sunrise-clinic", null, "sandbox-2", 93, 3, { passed: 2 }],
    ["race", "bella-bistro", null, "sandbox-3", 80, 5, { broker_ms: 288, browser_ms: 4420 }],
    ["heal", "city-library", "search_books", "sandbox-1", 62, 6, { healed: ["search_books"] }],
    ["verify", "city-library", null, "sandbox-4", 61, 3, { passed: 1 }],
    ["optimize", "city-library", "search_books", "sandbox-2", 45, 3, { best: "api", ms: 118 }],
    ["race", "sunrise-clinic", null, "sandbox-4", 30, 6, { broker_ms: 296, browser_ms: 5130 }],
    ["optimize", "pawsome-vet", "book_visit", "sandbox-1", 5, 3, { best: "api", ms: 102 }],
    ["optimize", "sunrise-clinic", "book_appointment", "sandbox-3", 2, 3, { best: "api", ms: 91 }],
  ];
  const jobs: Job[] = JOBS.map(([kind, site, tool, sandbox, minutes, secs, result], i) => ({
    id: 70 + i,
    kind,
    site_id: site,
    tool_id: tool ? tid(site, tool) : null,
    status: "done",
    claimed_by: sandbox,
    attempts: 1,
    result,
    error: null,
    created_at: ago(minutes + 0.05),
    started_at: ago(minutes),
    finished_at: ago(minutes - secs / 60),
  }));

  // [minutes ago, site, tool, mode, ms, paid, extra]
  const RUNS: [number, string, string, RunMode, number, boolean, Partial<Run>?][] = [
    [118, "sunrise-clinic", "list_open_slots", "broker", 82, false],
    [116, "sunrise-clinic", "book_appointment", "broker", 94, true],
    [110, "sunrise-clinic", "book_appointment", "browser_agent", 4870, false, { steps: 7, tokens: 18_900 }],
    [105, "bella-bistro", "list_open_slots", "broker", 69, false],
    [101, "bella-bistro", "book_table", "broker", 97, true],
    [96, "sunrise-clinic", "book_appointment", "broker", 412, false, { status: "failure", error: "404 /api/v1/appointments" }],
    [90, "sunrise-clinic", "book_appointment", "broker", 101, true],
    [84, "city-library", "search_books", "broker", 121, false],
    [80, "bella-bistro", "book_table", "browser_agent", 4420, false, { steps: 7, tokens: 16_200 }],
    [75, "sunrise-clinic", "list_doctors", "broker", 61, false],
    [70, "pawsome-vet", "list_open_slots", "broker", 77, false],
    [66, "pawsome-vet", "book_visit", "broker", 104, true],
    [60, "city-library", "place_hold", "dashboard", 138, true],
    [55, "bella-bistro", "get_menu", "broker", 57, false],
    [50, "sunrise-clinic", "list_open_slots", "dashboard", 85, false],
    [44, "city-library", "search_books", "broker", 117, false],
    [40, "sunrise-clinic", "book_appointment", "broker", 91, true],
    [35, "sunrise-clinic", "contact_clinic", "broker", 652, false, { strategy: "form" }],
    [30, "sunrise-clinic", "book_appointment", "browser_agent", 5130, false, { steps: 7, tokens: 19_400 }],
    [26, "bella-bistro", "list_open_slots", "broker", 73, false],
    [22, "city-library", "search_books", "broker", 119, false],
    [15, "pawsome-vet", "book_visit", "broker", 99, true],
    [10, "pawsome-vet", "list_open_slots", "broker", 80, false],
    [6, "sunrise-clinic", "list_doctors", "broker", 63, false],
    [3, "bella-bistro", "book_table", "broker", 95, true],
  ];
  const ref = () => `pi_test_${Math.floor(rnd() * 36 ** 8).toString(36).padStart(8, "0")}${Math.floor(rnd() * 36 ** 8).toString(36)}`;
  const runs: Run[] = RUNS.map(([minutes, site, tool, mode, ms, paid, extra], i) => ({
    id: 900 + i,
    tool_id: tid(site, tool),
    site_id: site,
    mode,
    strategy: mode === "browser_agent" ? "browser" : "api",
    status: "success",
    ms,
    steps: 1,
    tokens: 0,
    paid_reference: paid ? ref() : null,
    error: null,
    created_at: ago(minutes),
    ...extra,
  }));

  // [minutes ago, from, to, kind, body]
  const MESSAGES: [number, string, string | null, MessageKind, Data][] = [
    [180, "sandbox-1", null, "hello", { text: "online · us-east-1 · warm Chromium ready" }],
    [180, "sandbox-2", null, "hello", { text: "online · us-east-1 · warm Chromium ready" }],
    [179, "sandbox-3", null, "hello", { text: "online · us-east-1 · warm Chromium ready" }],
    [178, "sandbox-4", null, "hello", { text: "online · us-east-1 · warm Chromium ready" }],
    [171, "sandbox-1", null, "pattern_published", { pattern_id: 4, name: "slot_booking", site_id: "sunrise-clinic" }],
    [168, "sandbox-1", null, "tool_published", { tool: "book_appointment", site_id: "sunrise-clinic", version: 1 }],
    [161, "sandbox-3", "sandbox-1", "need_tool", { site_id: "bella-bistro", tool: "list_open_slots" }],
    [137, "sandbox-3", null, "pattern_published", { pattern_id: 5, name: "catalog_search", site_id: "city-library" }],
    [95, "sandbox-4", null, "broken", { tool: "book_appointment", site_id: "sunrise-clinic", reason: "404 /api/v1/appointments" }],
    [92, "sandbox-2", null, "validated", { tool: "book_appointment", version: 2, site_id: "sunrise-clinic" }],
    [70, "sandbox-3", null, "validated", { tool: "book_table", version: 2, site_id: "bella-bistro" }],
    [12, "sandbox-2", "sandbox-1", "need_tool", { site_id: "pawsome-vet", tool: "list_open_slots" }],
  ];
  const messages: Message[] = MESSAGES.map(([minutes, from, to, kind, body], i) => ({
    id: 5000 + i,
    from_sandbox: from,
    to_sandbox: to,
    kind,
    body,
    created_at: ago(minutes),
  }));

  const t = (site: string, name: string) => ({ tool_id: tid(site, name), tool: name });
  const SUN = "sunrise-clinic";
  const BEL = "bella-bistro";
  const PAW = "pawsome-vet";
  const LIB = "city-library";
  // [minutes ago, kind, site, sandbox, message, data]
  const EVENTS: [number, EventKind, string | null, string | null, string, Data][] = [
    [181, "sandbox.online", null, "sandbox-1", "sandbox-1 online (Supabase Compute, us-east-1)", { region: "us-east-1" }],
    [180.5, "sandbox.online", null, "sandbox-2", "sandbox-2 online (Supabase Compute, us-east-1)", { region: "us-east-1" }],
    [180, "sandbox.online", null, "sandbox-3", "sandbox-3 online (Supabase Compute, us-east-1)", { region: "us-east-1" }],
    [179.5, "sandbox.online", null, "sandbox-4", "sandbox-4 online (Supabase Compute, us-east-1)", { region: "us-east-1" }],
    [175, "discover.start", SUN, "sandbox-1", "sandbox-1 opened http://localhost:8790/ in a fresh Chromium", { job_id: 70, url: "http://localhost:8790/" }],
    [174.6, "explore.action", SUN, "sandbox-1", "click 'Book an appointment'", { job_id: 70, action: "click", target: "Book an appointment" }],
    [174.2, "explore.api", SUN, "sandbox-1", "GET /api/v1/slots?doctor=dr-rivera → 200 JSON", { job_id: 70, method: "GET", path: "/api/v1/slots", status: 200 }],
    [173.8, "observe.capability", SUN, "sandbox-1", "book_appointment (action)", { name: "book_appointment", kind: "action" }],
    [172, "compile.tool", SUN, "sandbox-1", "compiled book_appointment (api + form + browser)", { ...t(SUN, "book_appointment"), strategies: ["api", "form", "browser"] }],
    [170, "verify.pass", SUN, "sandbox-2", "book_appointment passed (api, 88 ms)", { ...t(SUN, "book_appointment"), strategy: "api", ms: 88 }],
    [169.5, "verify.fail", SUN, "sandbox-2", "contact_clinic: api failed (no JSON endpoint), form passed", { ...t(SUN, "contact_clinic"), strategy: "api", error: "no JSON endpoint" }],
    [168, "publish.tool", SUN, "sandbox-2", "Sunrise Family Clinic is ready: 4 verified tools on MCP", { site_id: SUN, tools: 4 }],
    [160, "reuse.pattern", BEL, "sandbox-3", "trying shared pattern slot_booking from sandbox-1", { pattern_id: 4, pattern: "slot_booking", from_sandbox: "sandbox-1" }],
    [158, "compile.tool", BEL, "sandbox-3", "compiled book_table from slot_booking", { ...t(BEL, "book_table"), pattern_id: 4 }],
    [156, "verify.pass", BEL, "sandbox-4", "book_table passed (api, 96 ms)", { ...t(BEL, "book_table"), strategy: "api", ms: 96 }],
    [150, "reuse.pattern", PAW, "sandbox-1", "trying shared pattern slot_booking from sandbox-1", { pattern_id: 4, pattern: "slot_booking", from_sandbox: "sandbox-1" }],
    [148, "verify.pass", PAW, "sandbox-4", "book_visit passed (api, 102 ms)", { ...t(PAW, "book_visit"), strategy: "api", ms: 102 }],
    [140, "discover.start", LIB, "sandbox-3", "sandbox-3 opened http://localhost:8793/ in a fresh Chromium", { job_id: 76, url: "http://localhost:8793/" }],
    [139.6, "explore.action", LIB, "sandbox-3", "type 'dune' into search", { job_id: 76, action: "type", target: "search" }],
    [139, "observe.capability", LIB, "sandbox-3", "search_books (read)", { name: "search_books", kind: "read" }],
    [135, "verify.pass", LIB, "sandbox-2", "search_books passed (api, 121 ms)", { ...t(LIB, "search_books"), strategy: "api", ms: 121 }],
    [120, "optimize.result", BEL, "sandbox-2", "book_table: api 96 ms beats form 610 ms and browser 4.3 s", { ...t(BEL, "book_table"), strategy: "api", ms: 96 }],
    [96, "tool.broken", SUN, "sandbox-4", "book_appointment broke: 404 /api/v1/appointments", { ...t(SUN, "book_appointment"), error: "404 /api/v1/appointments" }],
    [95, "heal.start", SUN, "sandbox-4", "sandbox-4 re-exploring Sunrise Family Clinic: private API changed", { job_id: 81, from: "v1", to: "v2" }],
    [94.5, "explore.api", SUN, "sandbox-4", "found /api/v2/slots (fields renamed)", { method: "GET", path: "/api/v2/slots", status: 200 }],
    [92, "heal.done", SUN, "sandbox-2", "list_open_slots healed → v2 (api, 84 ms)", { ...t(SUN, "list_open_slots"), version: 2, strategy: "api", ms: 84 }],
    [92, "heal.done", SUN, "sandbox-2", "book_appointment healed → v2 (api, 91 ms)", { ...t(SUN, "book_appointment"), version: 2, strategy: "api", ms: 91 }],
    [61, "heal.done", LIB, "sandbox-4", "search_books healed → v2 (api, 118 ms)", { ...t(LIB, "search_books"), version: 2, strategy: "api", ms: 118 }],
    [40, "request.received", SUN, null, "Agent request: Book the earliest appointment", { agent: "claude-desktop", via: "mcp" }],
    [39.9, "lookup.hit", SUN, null, "Found book_appointment (v2, api)", t(SUN, "book_appointment")],
    [39.8, "execute.call", SUN, null, "book_appointment → api (91 ms)", { ...t(SUN, "book_appointment"), strategy: "api", ms: 91 }],
    [39.7, "payment.challenge", SUN, null, "book_appointment: sent a $0.50 payment challenge", { ...t(SUN, "book_appointment"), amount_cents: 50 }],
    [39.6, "payment.paid", SUN, null, "Paid $0.50 for book_appointment", { ...t(SUN, "book_appointment"), amount_cents: 50, reference: runs[16].paid_reference }],
    [22, "request.received", LIB, null, "Agent request: Find a copy of Dune", { agent: "claude-code", via: "mcp" }],
    [21.9, "lookup.hit", LIB, null, "Found search_books (v3, api)", t(LIB, "search_books")],
    [21.8, "execute.call", LIB, null, "search_books → api (119 ms)", { ...t(LIB, "search_books"), strategy: "api", ms: 119 }],
    [5, "optimize.result", PAW, "sandbox-1", "book_visit: api 102 ms beats form 590 ms and browser 4.1 s", { ...t(PAW, "book_visit"), strategy: "api", ms: 102 }],
  ];
  const events: DoorwayEvent[] = EVENTS.map(([minutes, kind, site, sandbox, message, data], i) => ({
    id: 1000 + i,
    site_id: site,
    sandbox_id: sandbox,
    kind,
    message,
    data,
    created_at: ago(minutes),
  }));

  const siteApi = new Map<string, ApiVersion>(sites.map((s) => [s.id, "v1"]));
  const toolApi = new Map<number, ApiVersion>(tools.map((tool) => [tool.id, "v1"]));

  return {
    sites,
    capabilities,
    tools,
    versions,
    patterns,
    sandboxes,
    sandboxJobs: new Map(),
    jobs,
    runs,
    messages,
    events,
    races: new Map(),
    requests: new Map(),
    profile: { full_name: "Ada Lovelace", email: "ada@example.com", phone: "555-0100" },
    consents: [{ id: 1, site_id: "sunrise-clinic", fields: ["full_name", "phone"], granted_at: ago(150) }],
    siteApi,
    toolApi,
    bookings: new Map(),
    flows: new Map(),
    healing: new Map(),
    heals: events.filter((e) => e.kind === "heal.done").length,
    next: {
      event: 1000 + events.length,
      message: 5000 + messages.length,
      run: 900 + runs.length,
      job: 70 + jobs.length,
      tool: toolId,
      cap: capId,
      consent: 2,
    },
  };
}

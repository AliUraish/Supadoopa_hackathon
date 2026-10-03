// Plausible tool outputs and specs for the mock backend: slots, bookings, menus, book
// searches, sample arguments and the declarative spec GET /doorway/tools/{id} returns.

import { STRATEGIES, type JsonSchema, type Strategy, type Tool } from "@/lib/doorway/types";

export type Json = Record<string, unknown>;

export const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export const DOCTORS = [
  { id: "dr-rivera", name: "Dr. Ana Rivera", specialty: "Family medicine" },
  { id: "dr-chen", name: "Dr. Wei Chen", specialty: "Pediatrics" },
  { id: "dr-okafor", name: "Dr. Ngozi Okafor", specialty: "Internal medicine" },
];

export const BOOKS = [
  { id: "bk_1041", title: "Dune", author: "Frank Herbert", available: true },
  { id: "bk_1042", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", available: false },
  { id: "bk_1043", title: "Neuromancer", author: "William Gibson", available: true },
  { id: "bk_1044", title: "Dune Messiah", author: "Frank Herbert", available: true },
  { id: "bk_1045", title: "Kindred", author: "Octavia E. Butler", available: true },
  { id: "bk_1046", title: "The Dispossessed", author: "Ursula K. Le Guin", available: true },
  { id: "bk_1047", title: "Notes on the Analytical Engine", author: "Ada Lovelace", available: false },
  { id: "bk_1048", title: "Project Hail Mary", author: "Andy Weir", available: true },
];

const MENU: { name: string; items: [string, number][] }[] = [
  { name: "Starters", items: [["Burrata, heirloom tomato", 14], ["Arancini", 11], ["Calamari fritti", 13]] },
  { name: "Mains", items: [["Cacio e pepe", 19], ["Margherita pizza", 17], ["Branzino al limone", 28]] },
  { name: "Desserts", items: [["Tiramisu", 9], ["Panna cotta", 8]] },
];

const TIMES = {
  clinic: ["09:00", "09:30", "10:30", "11:00", "14:00", "15:30"],
  dinner: ["17:30", "18:00", "18:30", "19:45", "20:15", "21:00"],
  vet: ["08:30", "09:15", "10:00", "13:30", "15:00", "16:45"],
  generic: ["10:00", "11:30", "13:00", "14:30", "16:00", "17:30"],
};

/** YYYY-MM-DD (local) for a ms timestamp. */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}

const slotId = (time: string) => `s_${time.replace(":", "")}`;
const slotTime = (id: unknown) => {
  const m = /^s_(\d{2})(\d{2})$/.exec(String(id ?? ""));
  return m ? `${m[1]}:${m[2]}` : "09:00";
};

/** "SUN-4821" style confirmation codes, prefixed by the site. */
export function confirmationCode(siteId: string): string {
  const prefix = (siteId.replace(/[^a-z]/gi, "").slice(0, 3) || "DWY").toUpperCase();
  return `${prefix}-${1000 + Math.floor(Math.random() * 9000)}`;
}

export interface ResultCtx {
  date: string; // default day (tomorrow)
  code: string; // confirmation code to hand out
  booked: Set<string>; // slot ids already taken on this site
}

function flavor(tool: Tool): keyof typeof TIMES {
  const props = tool.input_schema.properties ?? {};
  if ("doctor_id" in props) return "clinic";
  if ("party_size" in props) return "dinner";
  if ("service" in props) return "vet";
  return "generic";
}

function slots(tool: Tool, args: Json, ctx: ResultCtx) {
  const date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : ctx.date;
  const kind = flavor(tool);
  const doctor = DOCTORS.find((d) => d.id === args.doctor_id)?.name ?? DOCTORS[0].name;
  const suffix =
    kind === "clinic"
      ? ` · ${doctor}`
      : kind === "dinner"
        ? ` · table for ${Number(args.party_size) || 2}`
        : kind === "vet"
          ? ` · ${String(args.service ?? "checkup")}`
          : "";
  return {
    date,
    slots: TIMES[kind]
      .map((time) => ({
        id: slotId(time),
        start: `${date}T${time}`,
        label: `${dayLabel(date)} · ${time}${suffix}`,
      }))
      .filter((s) => !ctx.booked.has(s.id)),
  };
}

function search(tool: Tool, args: Json) {
  const query = String(args.query ?? "").trim();
  const q = query.toLowerCase();
  if (tool.site_id === "city-library" || tool.name === "search_books") {
    let hits = BOOKS.filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q));
    if (!hits.length) hits = BOOKS.slice(0, 3);
    if (args.available_only === true) hits = hits.filter((b) => b.available);
    return { query, results: hits };
  }
  const word = query || "special";
  return {
    query,
    results: [1, 2, 3].map((i) => ({
      id: `it_${100 + i}`,
      title: `${word[0].toUpperCase()}${word.slice(1)} ${["classic", "deluxe", "for two"][i - 1]}`,
      available: i !== 2,
    })),
  };
}

/** What a successful run of `tool` returns for `args`. */
export function toolResult(tool: Tool, args: Json, ctx: ResultCtx): unknown {
  const name = tool.name;
  if (name === "list_doctors") return { doctors: DOCTORS };
  if (name.includes("slot")) return slots(tool, args, ctx);
  if (name.startsWith("search")) return search(tool, args);
  if (name === "get_menu") {
    return {
      sections: MENU.map((s) => ({ name: s.name, items: s.items.map(([dish, price]) => ({ name: dish, price_usd: price })) })),
    };
  }
  if (name.startsWith("book_")) {
    const time = slotTime(args.slot_id);
    return { confirmation: ctx.code, status: "confirmed", start: `${ctx.date}T${time}`, ...args };
  }
  if (name === "place_hold") {
    const book = BOOKS.find((b) => b.id === args.book_id) ?? BOOKS[0];
    const pickup = new Date(`${ctx.date}T12:00:00`);
    pickup.setDate(pickup.getDate() + 6);
    return {
      confirmation: ctx.code,
      status: "on_hold",
      book_id: book.id,
      title: book.title,
      pickup_by: Number.isNaN(pickup.getTime()) ? ctx.date : isoDay(pickup.getTime()),
      full_name: args.full_name,
    };
  }
  if (name.includes("contact")) {
    return { ticket: ctx.code.replace(/^[A-Z]+/, "MSG"), status: "sent", reply_within: "1 business day" };
  }
  return { ok: true, ...args };
}

/** "6 slots", "confirmed SUN-4821", "3 results". */
export function summarize(data: unknown): string {
  if (!isRecord(data)) return "ok";
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  if (Array.isArray(data.slots)) return `${n(data.slots)} slots`;
  if (Array.isArray(data.results)) return `${n(data.results)} results`;
  if (Array.isArray(data.doctors)) return `${n(data.doctors)} doctors`;
  if (Array.isArray(data.sections)) {
    const dishes = data.sections.reduce((sum: number, s: unknown) => sum + (isRecord(s) ? n(s.items) : 0), 0);
    return `${dishes} dishes`;
  }
  if (typeof data.confirmation === "string") return `confirmed ${data.confirmation}`;
  if (typeof data.ticket === "string") return `sent ${data.ticket}`;
  return "ok";
}

function sampleValue(name: string, prop: JsonSchema, date: string): unknown {
  if (prop.examples?.length) return prop.examples[0];
  if (prop.default !== undefined) return prop.default;
  if (prop.enum?.length) return prop.enum[0];
  if (prop.format === "date" || name === "date") return date;
  if (prop.type === "integer" || prop.type === "number") return prop.minimum ?? 2;
  if (prop.type === "boolean") return false;
  if (name.includes("email")) return "ada@example.com";
  if (name.includes("phone")) return "555-0100";
  if (name.includes("name")) return "Ada Lovelace";
  return "example";
}

/** `given` plus a sample value for every missing required input. */
export function sampleArgs(tool: Tool, date: string, given: Json = {}): Json {
  const props = tool.input_schema.properties ?? {};
  const out: Json = { ...given };
  for (const name of tool.input_schema.required ?? []) {
    if (out[name] === undefined || out[name] === null || out[name] === "") {
      out[name] = sampleValue(name, props[name] ?? {}, date);
    }
  }
  return out;
}

/** "list_open_slots(doctor_id=dr-rivera, date=2026-10-04)"; short keeps the first arg. */
export function fmtCall(name: string, args: Json, short = false): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  const shown = short && parts.length > 1 ? [parts[0], "…"] : parts;
  return `${name}(${shown.join(", ")})`;
}

/** The site's private API path a tool's api strategy calls, e.g. "slots". */
export function resourceFor(toolName: string): string {
  if (toolName.includes("slot")) return "slots";
  const noun = toolName.replace(/^(list|get|book|search|place|submit|contact|cancel)_/, "");
  if (toolName.startsWith("contact") || noun.includes("contact")) return "messages";
  if (noun === "menu" || noun.endsWith("s")) return noun;
  return `${noun}s`;
}

/** The declarative spec a sandbox compiled (shape of backend tests/fixtures/clinic_v1_tools.json). */
export function specFor(tool: Tool, apiVersion: string): Json {
  const props = Object.keys(tool.input_schema.properties ?? {});
  const resource = resourceFor(tool.name);
  const read = tool.kind === "read";
  const strategies: Partial<Record<Strategy, Json>> = {};
  const have = tool.strategies ?? [...STRATEGIES];
  if (have.includes("api")) {
    strategies.api = {
      request: read
        ? { method: "GET", path: `api/${apiVersion}/${resource}`, query: Object.fromEntries(props.map((p) => [p, `{{${p}}}`])) }
        : { method: "POST", path: `api/${apiVersion}/${resource}`, body: Object.fromEntries(props.map((p) => [p, `{{${p}}}`])) },
      response: { select: read ? resource : resource.replace(/s$/, "") },
    };
  }
  if (have.includes("form")) {
    strategies.form = {
      path: "",
      fields: props.map((p) => ({ selector: `#${p}`, action: "fill", value: `{{${p}}}` })),
      submit: read ? "#find" : "#submit",
      result: { selector: read ? `#${resource} li` : "#result", many: read },
    };
  }
  if (have.includes("browser")) {
    strategies.browser = {
      steps: [
        { action: "goto", path: "" },
        ...props.map((p) => ({ action: "fill", selector: `#${p}`, value: `{{${p}}}` })),
        { action: "click", selector: read ? "#find" : "#submit" },
        { action: "wait", selector: read ? `#${resource}` : "#result" },
      ],
      result: { selector: read ? `#${resource} li` : "#result", many: read },
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    input_schema: tool.input_schema,
    profile_fields: tool.profile_fields,
    strategies,
    preferred: tool.best_strategy,
  };
}

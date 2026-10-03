# Doorway API contract (v1)

Doorway turns websites with no API/MCP into verified, self-healing, paid MCP tools.
This file is the single source of truth between `backend/` (Python, FastAPI) and
`frontend/` (Next.js). Change it first, then both sides.

Pipeline: **Request → Lookup → Discover → Observe → Compile → Verify → Publish → Execute → Pay → Heal**

- Base URL: `DOORWAY_API_URL` (local `http://localhost:8000`). All JSON, snake_case, ISO timestamps.
- Auth: dashboard calls send `Authorization: Bearer <supabase access_token>` (marked 🔒).
  Agent calls (MCP, `/doorway/run/*`, `/doorway/requests`) need no account; actions are paid via MPP.
- Errors: `{"detail": "..."}` or `{"detail": {"error": "<code>", ...}}`. 401 / 402 / 404 / 409 / 422 / 503.

## Concepts

| Concept | Meaning |
|---|---|
| **site** | A website. `id` is a slug (`sunrise-clinic`). |
| **capability** | Something a human can do there ("book appointment", "search doctors"). Found by Observe. |
| **tool** | The compiled, verified callable for a capability (`book_appointment`). Has versions. |
| **strategy** | How a tool runs: `api` (replay the site's private JSON call, fastest), `form` (submit the HTML form), `browser` (click through with Playwright, fallback). The optimizer picks the fastest that passes. |
| **pattern** | Shared memory: a reusable tool template learned on one site (e.g. `slot_booking`). Other sandboxes try patterns before exploring from scratch. |
| **sandbox** | An isolated worker (Supabase Compute instance) with its own browser. Claims jobs from the shared queue. |
| **job** | Queue item: `discover`, `verify`, `heal`, `optimize`, `race`. `verify` always runs on a *different* sandbox than the one that compiled the tool. |
| **message** | Sandbox-to-sandbox blackboard post (`tool_published`, `pattern_published`, `need_tool`, `validated`, `broken`). |
| **profile / consent** | A user's saved form details (name, phone, …) and per-site permission to reuse them. |

Status values:
- site: `new` `queued` `discovering` `verifying` `ready` `broken` `healing` `failed`
- tool: `draft` `verified` `broken` `repairing`
- job: `queued` `running` `done` `failed`
- sandbox: `idle` `busy` `offline`
- run: `success` `failure`

## Objects

```jsonc
// Site
{ "id": "sunrise-clinic", "name": "Sunrise Family Clinic", "base_url": "http://localhost:8790/",
  "goal": "Book a doctor's appointment", "status": "ready",
  "tools_count": 3, "verified_count": 3, "updated_at": "…" }

// Capability
{ "id": 12, "site_id": "sunrise-clinic", "name": "book_appointment", "description": "…",
  "kind": "action" /* or "read" */, "status": "verified", "tool_id": 31 }

// Tool
{ "id": 31, "site_id": "sunrise-clinic", "name": "book_appointment", "description": "…",
  "kind": "action", "status": "verified", "version": 2, "best_strategy": "api",
  "p50_ms": 84, "success_rate": 0.98, "price_cents": 50, "pattern_id": 4,
  "input_schema": { "type": "object", "properties": { … }, "required": [ … ] },
  "profile_fields": { "patient_name": "full_name", "phone": "phone" },  // inputs fillable from a profile
  "updated_at": "…" }

// ToolVersion
{ "version": 2, "status": "verified", "source": "heal" /* discover|reuse|heal|reverify|seed */,
  "verified_by": "sandbox-3", "strategies": { "api": { "ms": 84, "passed": true },
  "form": { "ms": 640, "passed": true }, "browser": { "ms": 4100, "passed": true } },
  "created_at": "…" }

// Run (one tool execution)
{ "id": 901, "tool_id": 31, "site_id": "sunrise-clinic", "mode": "broker" /* broker|browser_agent|dashboard */,
  "strategy": "api", "status": "success", "ms": 91, "steps": 1, "tokens": 0,
  "paid_reference": "pi_…", "error": null, "created_at": "…" }

// Sandbox
{ "id": "sandbox-2", "status": "busy", "current_job_id": 77, "site_id": "city-library",
  "job_kind": "discover", "last_heartbeat": "…", "jobs_done": 14 }

// Job
{ "id": 77, "kind": "discover", "site_id": "city-library", "tool_id": null, "status": "running",
  "claimed_by": "sandbox-2", "attempts": 1, "created_at": "…", "started_at": "…", "finished_at": null,
  "result": null }

// Pattern (shared memory)
{ "id": 4, "name": "slot_booking", "description": "list slots → book slot with name + phone",
  "created_by": "sandbox-1", "source_site_id": "sunrise-clinic", "used_by": ["bella-bistro", "pawsome-vet"],
  "success_count": 9, "created_at": "…" }

// Message (sandbox blackboard)
{ "id": 5021, "from_sandbox": "sandbox-1", "to_sandbox": null /* null = broadcast */,
  "kind": "pattern_published", "body": { "pattern_id": 4, "name": "slot_booking" }, "created_at": "…" }

// Event (live feed line)
{ "id": 88123, "site_id": "sunrise-clinic", "sandbox_id": "sandbox-1", "kind": "verify.pass",
  "message": "book_appointment passed (api, 84 ms)", "data": { … }, "created_at": "…" }

// Race
{ "id": "race_8f2a", "site_id": "sunrise-clinic", "task": "Book the earliest available appointment",
  "status": "running" /* queued|running|done|failed */,
  "browser": { "status": "running", "ms": 5200, "steps": 7, "tokens": 18400, "success": null,
               "log": [ { "step": 1, "action": "screenshot", "detail": "…", "screenshot_url": "…" } ] },
  "broker":  { "status": "done", "ms": 310, "steps": 2, "tokens": 0, "success": true,
               "log": [ { "step": 1, "action": "call", "detail": "list_open_slots" } ] },
  "created_at": "…" }
```

## Endpoints

### Agent-facing (the broker)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/doorway/requests` | `{ "website": "https://…", "task": "Book the earliest appointment", "inputs"?: {…} }` | `202 { "request_id", "site_id", "status": "executing" \| "discovering", "tool"?: Tool }` |
| GET | `/doorway/requests/{id}` | | `{ "status": "discovering" \| "executing" \| "done" \| "failed", "result"?, "tool"?, "run"?: Run }` |
| POST | `/doorway/mcp` | MCP (streamable HTTP, stateless) | every verified tool, named `<site_id>__<tool>` |
| POST | `/doorway/sites/{site_id}/mcp` | MCP | that site's tools |
| POST | `/doorway/run/{site_id}/{tool}` | `{ "arguments": {…} }` | `200 { "ok": true, "data", "strategy", "ms", "healed" }` + `Payment-Receipt`; actions without payment → `402` MPP challenge |
| GET | `/llms.txt` | | what agents can buy/call |

Paid action tools called over MCP return a `paymentLink` (`/doorway/run/...`) instead of running (Stripe's MCP pattern).

### Dashboard
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/doorway/sites` | | `Site[]` |
| POST 🔒 | `/doorway/sites` | `{ "url", "name"?, "goal"? }` | `202 { "site": Site, "job_id" }` |
| GET | `/doorway/sites/{id}` | | `{ "site", "capabilities": Capability[], "tools": Tool[], "events": Event[] }` |
| POST 🔒 | `/doorway/sites/{id}/rediscover` | | `202 { "job_id" }` |
| POST 🔒 | `/doorway/sites/{id}/break` | | demo: switch the demo site's private API (v1⇄v2) → `{ "version" }` |
| POST 🔒 | `/doorway/sites/{id}/reset` | | demo: restore v1 and clear bookings |
| GET | `/doorway/tools?site_id=` | | `Tool[]` |
| GET | `/doorway/tools/{id}` | | `{ "tool", "versions": ToolVersion[], "runs": Run[] }` |
| POST 🔒 | `/doorway/tools/{id}/run` | `{ "arguments": {…}, "use_profile"?: true, "remember"?: true, "pay"?: "test" }` | `{ "ok", "data", "run": Run, "filled_from_profile": ["phone", …], "payment"?: { "reference", "amount_cents", "receipt" } }` |
| POST 🔒 | `/doorway/race` | `{ "site_id", "task", "inputs"?: {…} }` | `202 { "race_id" }` |
| GET | `/doorway/races/{id}` | | `Race` |
| GET | `/doorway/graph` | | `{ "nodes": [{ "id": "site:x" \| "cap:12" \| "tool:31" \| "pattern:4", "type": "site" \| "capability" \| "tool" \| "pattern", "label", "status" }], "edges": [{ "from", "to", "type": "has" \| "compiled_to" \| "reuses" }] }` |
| GET | `/doorway/sandboxes` | | `Sandbox[]` |
| GET | `/doorway/jobs?status=` | | `Job[]` (latest 100) |
| GET | `/doorway/patterns` | | `Pattern[]` |
| GET | `/doorway/messages?since=<id>` | | `Message[]` |
| GET | `/doorway/events?site_id=&since=<id>` | | `Event[]` (latest 200) |
| GET | `/doorway/metrics` | | `{ "sites", "tools_verified", "runs", "success_rate", "broker_p50_ms", "browser_p50_ms", "heals", "revenue_cents", "patterns", "reuse_count" }` |
| GET 🔒 | `/doorway/profile` | | `{ "fields": { "full_name"?, "email"?, "phone"?, "address"?, … } }` |
| PUT 🔒 | `/doorway/profile` | `{ "fields": {…} }` | same |
| GET 🔒 | `/doorway/consents` | | `[{ "id", "site_id", "fields": [ … ], "granted_at" }]` |
| POST 🔒 | `/doorway/consents` | `{ "site_id", "fields": ["full_name", "phone"] }` | consent |
| DELETE 🔒 | `/doorway/consents/{id}` | | `204` |

Billing endpoints (`/billing/*`) are unchanged; see README.md.

### Implementation notes (as built)
- `POST /doorway/requests`: read tasks return `executing` and run in the background (poll
  GET for `done`/`failed` with `result` + `run`). Action tasks return `done` immediately with
  `result` = the paymentLink payload (agents pay at `/doorway/run/...`). Unknown sites return
  `discovering`; each GET re-checks and moves on once a matching tool is verified.
- `POST /doorway/run/{site}/{tool}`: `422 missing_inputs` is checked before any charge. A
  failed run returns `400` (input/site rule, e.g. slot taken) or `502` (tool broken and
  healing failed) with `{ ok: false, error, healed, payment_reference?, refundable? }`.
- MCP endpoints are POST only (GET/DELETE → 405).
- Extra fields: `Site.mcp_url`; `Tool.strategies` (available strategy names); `GET
  /doorway/tools/{id}` also returns `spec`. The dashboard run response also has `error`,
  `strategy`, `ms`, `healed`. `filled_from_profile` lists tool input names.
- `repairing`: a call that only succeeded through a fallback strategy (e.g. the API changed but
  the form still works) returns the result and marks the tool `repairing` while a heal job
  fixes the fast path. `repairing` tools still run. A total failure marks the tool `broken`,
  waits up to 60 s for the heal, and retries once (`healed: true`).
- `Race.inputs` holds input names only (values stay private).
- `/llms.txt` lists billing items plus every Doorway tool with its run URL and price.
- Lessons (shared memory of fixed mistakes, from the team's Skeleton Key):
  `GET /doorway/lessons?status=&scope=` → `[{ id, lesson, scope: explore|spec|session|verify,
  site_id, sandbox_id, failure, fix, status: proposed|approved|rejected, source: auto|curated }]`;
  `POST 🔒 /doorway/lessons/{id} { status }`. Explorers read approved lessons before every site.
- `GET /doorway/sites/{id}/openapi.json`: the site's verified tools as OpenAPI 3.1.
- Specs carry `side_effect: read | reversible_write | irreversible_write` (+ `undo`). Irreversible
  writes are never auto-verified; they stay `draft` until a human approves.
- Local dev: `DOORWAY_DEMO_OPEN=1` lets 🔒 calls without a token run as a shared demo user.
  CORS allows any `http://localhost:<port>`.

`use_profile` fills missing inputs from the user's saved details, but only fields they consented
to for that site (mapping: `tool.profile_fields`). `remember` saves the submitted inputs back to
the profile. Consent stays a separate, explicit step.

## Event and message kinds

Event `kind`: `request.received` `lookup.hit` `lookup.miss` `discover.start` `explore.action`
`explore.api` `observe.capability` `compile.tool` `reuse.pattern` `verify.start` `verify.pass`
`verify.fail` `publish.tool` `optimize.result` `execute.call` `payment.challenge` `payment.paid`
`tool.broken` `heal.start` `heal.done` `heal.fail` `sandbox.online` `sandbox.offline`.

Message `kind`: `hello` `tool_published` `pattern_published` `need_tool` `validated` `broken`.

## Realtime (Supabase, read-only for the browser)

Subscribe with supabase-js `postgres_changes` (INSERT/UPDATE) on schema `public`:
`doorway_events`, `doorway_sandboxes`, `doorway_jobs`, `doorway_tools`, `doorway_messages`,
`doorway_races`, `doorway_runs`. Rows have the same fields as the objects above. Anyone can
read these tables (demo dashboard); only the backend writes. Profiles/consents are private.

Screenshots/logs live in Supabase Storage bucket `doorway-artifacts` (public read); URLs come in
`Race.browser.log[].screenshot_url` and `Event.data.screenshot_url`.

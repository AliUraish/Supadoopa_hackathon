// Doorway: turns websites into verified, self-healing MCP tools.
// Routes:
//   POST /s/:site/mcp        MCP endpoint agents connect to (stateless streamable HTTP)
//   GET  /sites[/:site]      sites, current tools and recent events
//   POST /sites/:site/verify re-run every tool's test against the live site (admin)
//   GET  /events?since=N     live feed for the dashboard
import { createServer } from "node:http";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execute, verify } from "./tools.mjs";
import { MemoryStore } from "./store.mjs";
import { explore } from "./explorer.mjs";
import { charge, isPaid, paymentInstructions } from "./payments.mjs";

const port = Number(process.env.PORT ?? 8787);
const publicUrl = (process.env.DOORWAY_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
const adminToken = process.env.DOORWAY_ADMIN_TOKEN;
const store = new MemoryStore();
const canExplore = Boolean(process.env.ANTHROPIC_API_KEY);

// One exploration per site at a time; concurrent heals share the same run.
const running = new Map();
function exploreOnce(site, options) {
  if (!running.has(site.id)) {
    const onEvent = (kind, message, data) => store.event(site.id, kind, message, data);
    running.set(site.id, explore(site, { ...options, onEvent }).finally(() => running.delete(site.id)));
  }
  return running.get(site.id);
}

const healer = canExplore
  ? async (site, { brokenTool, error }) => {
      const current = await store.getTools(site.id);
      await store.event(site.id, "heal.start", `Re-exploring ${site.name} to repair ${brokenTool}`);
      return exploreOnce(site, { previous: current?.specs ?? null, broken: { tool: brokenTool, error } });
    }
  : null;

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};
const isAdmin = (req) => adminToken && req.headers.authorization === `Bearer ${adminToken}`;
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

async function verifyAndSave(site, specs, source) {
  await store.event(site.id, "verify.start", `Verifying ${specs.length} tools against the live site`);
  const results = await verify(specs, site.base_url);
  const passed = results.every((r) => r.passed);
  for (const r of results) {
    await store.event(site.id, r.passed ? "verify.pass" : "verify.fail", `${r.name}: ${r.passed ? `passed (HTTP ${r.status}, ${r.ms} ms)` : r.error}`, r);
  }
  if (!passed) return { passed, results };
  const saved = await store.saveTools(site.id, { specs, status: "verified", verification: results, source });
  await store.event(site.id, "tools.published", `Published ${specs.length} verified tools (v${saved.version})`, { version: saved.version });
  return { passed, results, version: saved.version };
}

// One tool call, healing once if the site changed underneath the tool.
async function callTool(site, name, args) {
  const current = await store.getTools(site.id);
  const spec = current?.specs.find((s) => s.name === name);
  if (!spec) return { ok: false, error: `unknown tool ${name}` };

  // Log input names only: values can hold personal details (a patient's name or phone).
  await store.event(site.id, "call", `Agent called ${name}`, { inputs: Object.keys(args ?? {}) });
  let r = await execute(spec, args, site.base_url);
  if (r.ok || !r.broken) return r;

  await store.event(site.id, "tool.broken", `${name} broke: ${r.error}`, { status: r.status });
  if (!healer) return { ...r, error: `${r.error} (site changed; self-healing not configured)` };

  const started = Date.now();
  try {
    const specs = await healer(site, { brokenTool: name, error: r.error, store });
    const outcome = await verifyAndSave(site, specs, "heal");
    if (!outcome.passed) throw new Error("repaired tools failed verification");
  } catch (err) {
    await store.event(site.id, "heal.fail", `Healing failed: ${err.message}`);
    return { ...r, error: `${r.error} (healing failed)` };
  }
  const healed = (await store.getTools(site.id)).specs.find((s) => s.name === name);
  if (!healed) return { ok: false, error: `${name} no longer exists on this site` };
  r = await execute(healed, args, site.base_url);
  await store.event(site.id, "heal.done", `Healed ${name} in ${Math.round((Date.now() - started) / 1000)} s and retried: ${r.ok ? "success" : r.error}`);
  return { ...r, healed: true };
}

function mcpServerFor(site) {
  const server = new Server({ name: `doorway-${site.id}`, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const current = await store.getTools(site.id);
    return {
      tools: (current?.specs ?? []).map((s) => ({ name: s.name, description: s.description, inputSchema: s.input_schema })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const spec = (await store.getTools(site.id))?.specs.find((s) => s.name === request.params.name);
    if (spec && isPaid(spec)) {
      await store.event(site.id, "payment.requested", `${spec.name} needs payment; sent the agent a payment link`);
      return { content: [{ type: "text", text: JSON.stringify(paymentInstructions(publicUrl, site.id, spec, args)) }] };
    }
    const r = await callTool(site, request.params.name, args);
    const text = r.ok
      ? JSON.stringify(r.data) + (r.healed ? "\n(note: the site changed; Doorway repaired this tool automatically)" : "")
      : `Error: ${r.error}`;
    return { content: [{ type: "text", text }], isError: !r.ok };
  });
  return server;
}

async function handleMcp(req, res, site) {
  if (req.method !== "POST") return send(res, 405, { error: "use POST (stateless MCP)" });
  const server = mcpServerFor(site);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readJson(req));
}

// POST /run/:site/:tool {arguments}: plain-HTTP tool call, and the paymentLink target.
// Paid tools charge through the billing backend on every attempt (first try and retry).
async function handleRun(req, res, site, toolName) {
  const spec = (await store.getTools(site.id))?.specs.find((s) => s.name === toolName);
  if (!spec) return send(res, 404, { error: `unknown tool ${toolName}` });
  const body = (await readJson(req)) ?? {};
  const args = body.arguments ?? body;

  let receipt = null;
  if (isPaid(spec)) {
    const paid = await charge(site.id, toolName, req.headers.authorization);
    if (paid.status !== 200) {
      // 402 goes back verbatim so the agent's wallet can answer the challenge.
      const headers = { "content-type": paid.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
      const challenge = paid.headers.get("www-authenticate");
      if (challenge) headers["www-authenticate"] = challenge;
      if (paid.status === 402) await store.event(site.id, "payment.challenge", `${toolName}: sent a $0.50 payment challenge`);
      res.writeHead(paid.status, headers);
      return res.end(await paid.text());
    }
    const payment = await paid.json();
    receipt = payment.receipt;
    await store.event(site.id, "payment.paid", `Agent paid for ${toolName} (${payment.reference})`, { reference: payment.reference, tool: toolName });
  }

  const r = await callTool(site, toolName, args);
  res.writeHead(r.ok ? 200 : r.broken ? 502 : 400, {
    "content-type": "application/json",
    ...(receipt ? { "payment-receipt": receipt } : {}),
  });
  res.end(JSON.stringify(r.ok ? { ok: true, data: r.data, healed: r.healed ?? false } : { ok: false, error: r.error }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (req.method === "POST" && parts[0] === "run" && parts.length === 3) {
      const site = await store.getSite(parts[1]);
      return site ? handleRun(req, res, site, parts[2]) : send(res, 404, { error: "unknown site" });
    }
    if (parts[0] === "s" && parts[2] === "mcp") {
      const site = await store.getSite(parts[1]);
      return site ? handleMcp(req, res, site) : send(res, 404, { error: "unknown site" });
    }
    if (req.method === "GET" && url.pathname === "/sites") return send(res, 200, { sites: await store.listSites() });
    if (req.method === "POST" && url.pathname === "/sites") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      if (!canExplore) return send(res, 503, { error: "explorer_not_configured", missing: ["ANTHROPIC_API_KEY"] });
      const body = (await readJson(req)) ?? {};
      if (!/^[a-z0-9-]{2,40}$/.test(body.id ?? "") || !/^https?:\/\//.test(body.base_url ?? "") || !body.goal) {
        return send(res, 400, { error: "need id (slug), base_url (http/https) and goal" });
      }
      const site = await store.upsertSite({ id: body.id, name: body.name ?? body.id, base_url: body.base_url, goal: body.goal, status: "exploring" });
      // Explore in the background; the dashboard follows along through the event feed.
      exploreOnce(site, {})
        .then((specs) => verifyAndSave(site, specs, "explore"))
        .then((r) => store.upsertSite({ id: site.id, status: r.passed ? "ready" : "failed" }))
        .catch(async (err) => {
          await store.event(site.id, "explore.fail", `Exploration failed: ${err.message}`);
          await store.upsertSite({ id: site.id, status: "failed" });
        });
      return send(res, 202, { site, mcp_url: `/s/${site.id}/mcp` });
    }
    if (req.method === "GET" && parts[0] === "sites" && parts.length === 2) {
      const site = await store.getSite(parts[1]);
      if (!site) return send(res, 404, { error: "unknown site" });
      return send(res, 200, { site, tools: await store.getTools(site.id), events: (await store.listEvents(site.id)).slice(-50) });
    }
    if (req.method === "POST" && parts[0] === "sites" && parts[2] === "verify") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const site = await store.getSite(parts[1]);
      const current = site && (await store.getTools(site.id));
      if (!current) return send(res, 404, { error: "no tools for site" });
      return send(res, 200, await verifyAndSave(site, current.specs, "reverify"));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      return send(res, 200, { events: await store.listEvents(url.searchParams.get("site"), Number(url.searchParams.get("since") ?? 0)) });
    }
    return send(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
  }
});

// Optional seed for testing without Claude: the demo clinic with hand-written v1 tools.
if (process.env.DOORWAY_SEED === "1" && process.env.CLINIC_BASE_URL) {
  const site = await store.upsertSite({ id: "sunrise-clinic", name: "Sunrise Family Clinic", base_url: process.env.CLINIC_BASE_URL, goal: "Book a doctor's appointment" });
  const specs = JSON.parse(fs.readFileSync(new URL("./seed/sunrise-clinic.v1.json", import.meta.url), "utf8"));
  await verifyAndSave(site, specs, "seed");
}

server.listen(port, () => console.log(`doorway on http://localhost:${port}`));

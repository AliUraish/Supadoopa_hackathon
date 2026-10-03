// Tool specs are declarative HTTP recipes, never generated code: Compute injects the
// project's secret keys into every service, so we only run our own fixed executor.
//
// {
//   name, description, input_schema,              // JSON Schema shown to agents
//   request: { method, path, query?, headers?, body? },   // values may use {{input_name}}
//   response?: { select?: "dot.path" },           // part of the JSON to return
//   test?: { input: {...} }                       // inputs may use {{from:tool:dot.path}}
// }

const PLACEHOLDER = /\{\{\s*([\w.:-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*([\w.:-]+)\s*\}\}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_HEADERS = new Set(["host", "cookie", "authorization", "content-length"]);

export function getPath(value, path) {
  if (!path) return value;
  return path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), value);
}

// Fill {{name}} placeholders. A string that is only a placeholder keeps the value's type.
export function render(template, lookup) {
  if (typeof template === "string") {
    const whole = template.match(WHOLE);
    if (whole) return lookup(whole[1]);
    return template.replace(PLACEHOLDER, (_, key) => String(lookup(key) ?? ""));
  }
  if (Array.isArray(template)) return template.map((t) => render(t, lookup));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, render(v, lookup)]));
  }
  return template;
}

export function validateSpec(spec) {
  const errors = [];
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(spec?.name ?? "")) errors.push("name must be snake_case");
  if (!spec?.description) errors.push("description required");
  if (spec?.input_schema?.type !== "object") errors.push("input_schema must be an object schema");
  const req = spec?.request ?? {};
  if (!METHODS.has(req.method)) errors.push("request.method invalid");
  if (typeof req.path !== "string" || /^[a-z]+:|^\/\//i.test(req.path)) errors.push("request.path must be relative");
  for (const h of Object.keys(req.headers ?? {})) if (BLOCKED_HEADERS.has(h.toLowerCase())) errors.push(`header ${h} not allowed`);
  return errors;
}

// Resolve a spec path against the site base and refuse anything outside it (SSRF guard).
export function resolveUrl(siteBase, path, query) {
  const base = new URL(siteBase.endsWith("/") ? siteBase : `${siteBase}/`);
  const url = new URL(path.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error(`refusing to call ${url.href}: outside ${base.href}`);
  }
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  return url;
}

// A failure the agent caused (bad input, slot taken) vs. one that means the tool no longer
// matches the site (gone, renamed, shape changed) and needs healing.
const BROKEN_STATUSES = new Set([404, 405, 410]);

export async function execute(spec, input, siteBase, { timeoutMs = 20000 } = {}) {
  const required = spec.input_schema?.required ?? [];
  const missing = required.filter((k) => input?.[k] === undefined || input?.[k] === "");
  if (missing.length) return { ok: false, broken: false, status: 0, error: `missing input: ${missing.join(", ")}` };

  const lookup = (key) => input?.[key];
  const req = spec.request;
  let url;
  try {
    url = resolveUrl(siteBase, render(req.path, lookup), render(req.query ?? {}, lookup));
  } catch (err) {
    return { ok: false, broken: true, status: 0, error: err.message };
  }
  const headers = { accept: "application/json", ...render(req.headers ?? {}, lookup) };
  let body;
  if (req.body != null && req.method !== "GET") {
    body = JSON.stringify(render(req.body, lookup));
    headers["content-type"] ??= "application/json";
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  } catch (err) {
    return { ok: false, broken: false, status: 0, error: `request failed: ${err.message}`, ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, broken: true, status: res.status, error: "response is not JSON", ms };
  }
  if (BROKEN_STATUSES.has(res.status)) {
    return { ok: false, broken: true, status: res.status, error: data?.error ?? `HTTP ${res.status}`, ms };
  }
  if (!res.ok) return { ok: false, broken: false, status: res.status, error: data?.error ?? `HTTP ${res.status}`, data, ms };

  const selected = getPath(data, spec.response?.select);
  if (spec.response?.select && selected === undefined) {
    return { ok: false, broken: true, status: res.status, error: `response no longer has "${spec.response.select}"`, ms };
  }
  return { ok: true, broken: false, status: res.status, data: selected, ms };
}

// Run every tool's test against the live site, in order, so a test can use an earlier
// tool's real output ({{from:list_slots:0.id}}). Returns per-tool pass/fail.
export async function verify(specs, siteBase) {
  const outputs = {};
  const results = [];
  for (const spec of specs) {
    const errors = validateSpec(spec);
    if (errors.length) {
      results.push({ name: spec.name, passed: false, error: errors.join("; ") });
      continue;
    }
    let input;
    try {
      input = render(spec.test?.input ?? {}, (key) => {
        const [kind, tool, path] = key.split(":");
        if (kind !== "from") throw new Error(`unknown test placeholder ${key}`);
        if (!(tool in outputs)) throw new Error(`test depends on ${tool}, which has no output`);
        return getPath(outputs[tool], path);
      });
    } catch (err) {
      results.push({ name: spec.name, passed: false, error: err.message });
      continue;
    }
    const r = await execute(spec, input, siteBase);
    if (r.ok) outputs[spec.name] = r.data;
    results.push({ name: spec.name, passed: r.ok, status: r.status, ms: r.ms, error: r.ok ? undefined : r.error, sample: r.ok ? preview(r.data) : undefined });
  }
  return results;
}

function preview(data) {
  const s = JSON.stringify(data);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

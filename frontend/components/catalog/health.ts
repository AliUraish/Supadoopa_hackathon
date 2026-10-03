// Tool health: what "working" means, why a tool isn't, and which strategy still works.
// Pure helpers shared by the Tools catalog and its diagnosis rows.

import type { Job, Run, Strategy, Tool, ToolDetail, ToolVersion } from "@/lib/doorway";

/** A tool needs attention when it isn't verified or fewer than 90% of its calls succeed. */
export function needsAttention(tool: Tool): boolean {
  return tool.status !== "verified" || (tool.success_rate !== null && tool.success_rate < 0.9);
}

/** The MCP name agents see on the all-sites endpoint. */
export function mcpName(tool: Pick<Tool, "site_id" | "name">): string {
  return `${tool.site_id}__${tool.name}`;
}

export function priceLabel(cents: number): string {
  return cents > 0 ? `$${(cents / 100).toFixed(2)}` : "FREE";
}

/** Irreversible writes are never auto-verified: they wait for a human. */
export function sideEffect(detail: ToolDetail | undefined): string | null {
  if (!detail) return null;
  const spec = (detail.spec ?? (detail.tool as Tool & { spec?: unknown }).spec) as
    | { side_effect?: unknown }
    | null
    | undefined;
  return typeof spec?.side_effect === "string" ? spec.side_effect : null;
}

/** Plain-English meaning of the tool's status. */
export function statusReason(tool: Tool, detail?: ToolDetail): { title: string; body: string } {
  switch (tool.status) {
    case "broken":
      return {
        title: "Broken: the site changed and the fast path failed",
        body: "The last call failed on every strategy Doorway tried. Agents get an error for this tool until a heal job re-learns the page and re-verifies it.",
      };
    case "repairing":
      return {
        title: "Repairing: still works through a fallback",
        body: "The fast path stopped working, so calls now go through a slower fallback strategy. A heal job is fixing the fast path; agents keep getting results meanwhile.",
      };
    case "draft":
      return sideEffect(detail) === "irreversible_write"
        ? {
            title: "Draft: waiting for a human to approve it",
            body: "This tool makes an irreversible change on the site (for example it sends a message), so Doorway never test-runs it on its own. It stays out of MCP until someone approves it.",
          }
        : {
            title: "Draft: discovered but not verified yet",
            body: "A sandbox found this capability but hasn't proven it works end to end. It isn't offered to agents until a verify job passes.",
          };
    default: {
      if (tool.success_rate !== null && tool.success_rate < 0.9) {
        return {
          title: `Verified, but only ${Math.round(tool.success_rate * 100)}% of calls succeed`,
          body: "The tool passed verification, yet recent calls fail often. The failures below show whether the site refused the inputs or the tool itself broke.",
        };
      }
      return {
        title: "Healthy: verified and succeeding",
        body: "Doorway verified this tool against the live site and recent calls succeed.",
      };
    }
  }
}

/** First line of an error, without Playwright's call log. */
export function firstLine(error: string): string {
  return error.split("\n")[0].replace(/\s*Call log:\s*$/, "").trim();
}

/** A short explanation for common failure messages, or null. */
export function explainError(error: string): string | null {
  const e = error.toLowerCase();
  if (e.includes("browser unavailable") || e.includes("executable doesn't exist"))
    return "No browser was available where this call ran (the API server on Vercel has no Chromium). Browser strategies only run inside the Supabase Compute sandboxes; the api and form strategies don't need one.";
  if (e.includes("missing_inputs") || e.includes("missing input"))
    return "Required inputs were missing, so nothing ran.";
  if (e.includes("disabled") || (e.includes("timeout") && e.includes("click")))
    return "A button never became clickable. Usually the site disabled it (nothing left to book or hold) rather than the page changing.";
  if (e.includes("did not appear") || e.includes("no element") || e.includes("not found") || e.includes("selector"))
    return "A selector from the compiled spec no longer matches the page: the site's HTML changed.";
  if (e.includes("timeout")) return "The site didn't respond in time.";
  if (/\b404\b/.test(e)) return "The endpoint is gone (404): the site's API moved.";
  if (/\b5\d\d\b/.test(e)) return "The site returned a server error.";
  if (/^[a-z][a-z0-9_]+$/.test(error.trim()))
    return `The site refused this request (${error.trim().replaceAll("_", " ")}). The tool ran correctly; the inputs hit one of the site's rules.`;
  return null;
}

export function latestVersion(detail: ToolDetail | undefined): ToolVersion | undefined {
  if (!detail?.versions.length) return undefined;
  return [...detail.versions].sort((a, b) => b.version - a.version)[0];
}

export function failedRuns(detail: ToolDetail | undefined, limit = 3): Run[] {
  if (!detail) return [];
  return detail.runs
    .filter((r) => r.status === "failure")
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

export interface StrategyHealth {
  strategy: Strategy;
  passed: boolean;
  ms: number | null;
  error: string | null;
  source: "verify" | "optimize";
}

type OptimizeResult = {
  tools?: Record<string, { best?: string; strategies?: Record<string, { passed?: boolean; p50_ms?: number | null; error?: string | null }> }>;
};

/** The newest optimize job for a site, if any. */
export function latestOptimize(jobs: Job[] | undefined, siteId: string): Job | undefined {
  return jobs
    ?.filter((j) => j.kind === "optimize" && j.site_id === siteId && j.status === "done")
    .sort((a, b) => b.id - a.id)[0];
}

/**
 * Per-strategy health: the newest version's verify results, overridden by the newest
 * optimize job (it re-measures every strategy against the live site).
 */
export function strategyHealth(
  tool: Tool,
  version: ToolVersion | undefined,
  optimize: Job | undefined,
): StrategyHealth[] {
  const out = new Map<Strategy, StrategyHealth>();
  for (const [s, r] of Object.entries(version?.strategies ?? {})) {
    if (!r) continue;
    out.set(s as Strategy, { strategy: s as Strategy, passed: r.passed, ms: r.ms, error: null, source: "verify" });
  }
  const measured = (optimize?.result as OptimizeResult | null)?.tools?.[tool.name]?.strategies;
  for (const [s, r] of Object.entries(measured ?? {})) {
    if (typeof r?.passed !== "boolean") continue;
    out.set(s as Strategy, {
      strategy: s as Strategy,
      passed: r.passed,
      ms: r.p50_ms ?? null,
      error: r.error ?? null,
      source: "optimize",
    });
  }
  return [...out.values()].sort((a, b) => Number(b.passed) - Number(a.passed) || (a.ms ?? 1e9) - (b.ms ?? 1e9));
}

/** Fallback strategies (not the best one) that currently fail, from the newest optimize job. */
export function failingFallbacks(tool: Tool, optimize: Job | undefined): Strategy[] {
  const measured = (optimize?.result as OptimizeResult | null)?.tools?.[tool.name]?.strategies;
  return Object.entries(measured ?? {})
    .filter(([s, r]) => r?.passed === false && s !== tool.best_strategy)
    .map(([s]) => s as Strategy);
}

/** An example value for each input, for copyable calls. */
export function exampleArgs(schema: Tool["input_schema"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    if (prop.examples?.length) out[key] = prop.examples[0];
    else if (prop.default !== undefined) out[key] = prop.default;
    else if (prop.enum?.length) out[key] = prop.enum[0];
    else if (prop.type === "number" || prop.type === "integer") out[key] = 1;
    else if (prop.type === "boolean") out[key] = true;
    else if (/YYYY-MM-DD/.test(prop.description ?? "")) out[key] = "YYYY-MM-DD";
    else out[key] = `<${key}>`;
  }
  return out;
}

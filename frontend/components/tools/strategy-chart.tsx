"use client";

// Strategy latency bars: one bar per strategy (api / form / browser). Lengths use a
// square-root scale so an ~80 ms api call is still visible next to a ~4 s browser run;
// labels always show the real milliseconds.

import { motion, useReducedMotion } from "motion/react";
import { STRATEGIES, type Strategy, type StrategyResult, type Tool, type ToolVersion } from "@/lib/doorway";
import { fmtMs, speedup } from "@/lib/doorway/format";
import { Badge, cx } from "@/components/px/ui";

const BLURB: Record<Strategy, string> = {
  api: "Replay the private JSON call",
  form: "Submit the HTML form",
  browser: "Click through in Chromium",
};

type RowState = "chosen" | "passed" | "failed" | "untested";

function rowState(result: StrategyResult | undefined, chosen: boolean): RowState {
  if (!result) return "untested";
  if (!result.passed) return "failed";
  return chosen ? "chosen" : "passed";
}

const FILL: Record<Exclude<RowState, "untested">, string> = {
  chosen: "var(--color-green)",
  passed: "var(--color-line-2)",
  failed:
    "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-red) 80%, transparent) 0 4px, color-mix(in srgb, var(--color-red) 25%, transparent) 4px 8px)",
};

export function StrategyChart({ tool, version }: { tool: Tool; version: ToolVersion | undefined }) {
  const reduce = useReducedMotion();
  const fromVersion = version && Object.keys(version.strategies).length > 0;
  const results: Partial<Record<Strategy, StrategyResult>> = fromVersion
    ? version.strategies
    : tool.best_strategy
      ? { [tool.best_strategy]: { ms: tool.p50_ms, passed: true } }
      : {};

  const available = tool.strategies;
  if (!Object.keys(results).length && !available?.length) {
    return (
      <p className="text-[13px] text-faint">No benchmark yet: strategies are timed when the tool is verified.</p>
    );
  }

  const maxMs = Math.max(1, ...STRATEGIES.map((s) => results[s]?.ms ?? 0));
  const chosenMs = tool.best_strategy ? results[tool.best_strategy]?.ms : null;
  const browserMs = results.browser?.passed ? results.browser.ms : null;
  const x = tool.best_strategy && tool.best_strategy !== "browser" ? speedup(browserMs, chosenMs) : null;

  return (
    <figure className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {STRATEGIES.map((s, i) => {
          const r = results[s];
          const state = rowState(r, tool.best_strategy === s);
          const pct =
            r?.ms != null ? Math.max(2, (Math.sqrt(r.ms) / Math.sqrt(maxMs)) * 100) : state === "failed" ? 12 : 0;
          const notTimed = !available || available.includes(s) ? "not timed" : "n/a";
          const label = `${s}: ${r?.ms != null ? fmtMs(r.ms) : "no time"} · ${
            state === "untested" ? (notTimed === "n/a" ? "not available" : notTimed) : state
          }`;
          return (
            <li key={s} className="grid grid-cols-[104px_minmax(0,1fr)_128px] items-center gap-3" title={label}>
              <div className="min-w-0">
                <div className={cx("font-mono text-[13px]", state === "chosen" ? "text-green" : "text-text")}>{s}</div>
                <div className="truncate text-[11px] text-faint">{BLURB[s]}</div>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-bg-2 ring-1 ring-line" role="img" aria-label={label}>
                {state !== "untested" && (
                  <motion.div
                    className="h-full origin-left rounded-full"
                    style={{ width: `${pct}%`, background: FILL[state] }}
                    initial={reduce ? false : { scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.6, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                  />
                )}
              </div>
              <div className="flex items-center justify-end gap-2">
                <span
                  className={cx(
                    "font-mono text-xs tabular-nums",
                    state === "failed" ? "text-red" : r?.ms != null ? "text-text" : "text-faint",
                  )}
                >
                  {r?.ms != null ? fmtMs(r.ms) : "—"}
                </span>
                {state === "chosen" && <Badge tone="ok">Chosen</Badge>}
                {state === "failed" && <Badge tone="bad">Failed</Badge>}
                {state === "untested" && <span className="text-[11px] text-faint">{notTimed}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-line pt-3 text-xs text-muted">
        <span>
          The optimizer benchmarks all three and keeps the fastest that passes.
          {x && x > 1 && (
            <span className="text-green">
              {" "}
              {tool.best_strategy} is {x}× faster than the browser.
            </span>
          )}
        </span>
        <span className="font-mono text-[11px] text-faint">
          √ scale ·{" "}
          {fromVersion ? `v${version.version}${version.verified_by ? ` · ${version.verified_by}` : ""}` : "tool p50"}
        </span>
      </figcaption>
    </figure>
  );
}

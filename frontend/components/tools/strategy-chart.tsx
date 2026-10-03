// Strategy latency bars: one pixel bar per strategy (api / form / browser). Lengths use a
// square-root scale so an ~80 ms api call is still visible next to a ~4 s browser run;
// labels always show the real milliseconds.

import { STRATEGIES, type Strategy, type StrategyResult, type Tool, type ToolVersion } from "@/lib/doorway";
import { fmtMs, speedup } from "@/lib/doorway/format";
import { Badge } from "@/components/px/ui";

const SEGMENTS = 40;

const BLURB: Record<Strategy, string> = {
  api: "replay the private JSON call",
  form: "submit the HTML form",
  browser: "click through in Chromium",
};

type RowState = "chosen" | "passed" | "failed" | "untested";

function rowState(result: StrategyResult | undefined, chosen: boolean): RowState {
  if (!result) return "untested";
  if (!result.passed) return "failed";
  return chosen ? "chosen" : "passed";
}

const FILL: Record<Exclude<RowState, "untested">, string> = {
  chosen: "var(--color-green)",
  passed: "var(--color-muted)",
  failed: "repeating-linear-gradient(135deg, var(--color-red) 0 3px, transparent 3px 6px)",
};

export function StrategyChart({ tool, version }: { tool: Tool; version: ToolVersion | undefined }) {
  const fromVersion = version && Object.keys(version.strategies).length > 0;
  const results: Partial<Record<Strategy, StrategyResult>> = fromVersion
    ? version.strategies
    : tool.best_strategy
      ? { [tool.best_strategy]: { ms: tool.p50_ms, passed: true } }
      : {};

  const available = tool.strategies;
  if (!Object.keys(results).length && !available?.length) {
    return <p className="text-base text-faint">No benchmark yet: strategies are timed when the tool is verified.</p>;
  }

  const maxMs = Math.max(1, ...STRATEGIES.map((s) => results[s]?.ms ?? 0));
  const chosenMs = tool.best_strategy ? results[tool.best_strategy]?.ms : null;
  const browserMs = results.browser?.passed ? results.browser.ms : null;
  const x = tool.best_strategy && tool.best_strategy !== "browser" ? speedup(browserMs, chosenMs) : null;

  return (
    <figure className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2.5">
        {STRATEGIES.map((s) => {
          const r = results[s];
          const state = rowState(r, tool.best_strategy === s);
          const filled =
            r?.ms != null
              ? Math.max(1, Math.round((Math.sqrt(r.ms) / Math.sqrt(maxMs)) * SEGMENTS))
              : state === "failed"
                ? 4
                : 0;
          const label = `${s}: ${r?.ms != null ? fmtMs(r.ms) : "no time"} · ${
            state === "untested" ? (!available || available.includes(s) ? "not timed" : "not available") : state
          }`;
          return (
            <li key={s} className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3" title={label}>
              <div className="min-w-0">
                <div
                  className="font-pixel text-[9px] uppercase"
                  style={{ color: state === "chosen" ? "var(--color-green)" : "var(--color-text)" }}
                >
                  {s}
                </div>
                <div className="truncate text-xs text-faint">{BLURB[s]}</div>
              </div>
              <div className="px-inset flex h-5 gap-[2px] p-[3px]" role="img" aria-label={label}>
                {Array.from({ length: SEGMENTS }, (_, i) => (
                  <span
                    key={i}
                    className="h-full flex-1"
                    style={
                      i < filled && state !== "untested"
                        ? {
                            background: FILL[state],
                            boxShadow: state === "chosen" ? "0 0 6px var(--color-green)" : undefined,
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
              <div className="flex min-w-[132px] items-center justify-end gap-2">
                <span className="text-base tabular-nums text-text">{r?.ms != null ? fmtMs(r.ms) : "—"}</span>
                {state === "chosen" && <Badge tone="ok">Chosen</Badge>}
                {state === "failed" && <Badge tone="bad">failed</Badge>}
                {state === "untested" && (
                  <span className="text-sm text-faint">
                    {!available || available.includes(s) ? "not timed" : "n/a"}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm text-muted">
        <span>
          The optimizer benchmarks all three and keeps the fastest that passes.
          {x && x > 1 && (
            <span className="text-green">
              {" "}
              {tool.best_strategy} is {x}× faster than the browser.
            </span>
          )}
        </span>
        <span className="text-faint">
          √ scale ·{" "}
          {fromVersion ? `v${version.version}${version.verified_by ? ` · ${version.verified_by}` : ""}` : "tool p50"}
        </span>
      </figcaption>
    </figure>
  );
}

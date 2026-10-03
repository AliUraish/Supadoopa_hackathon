"use client";

// The expandable "Why" row of the Tools catalog: why a tool isn't working (status meaning,
// failing strategies, the latest failed calls) and how to work with it anyway (the strategy
// that still passes, re-discover & heal, try it by hand).

import { useState, type ReactNode } from "react";
import { useDashboardNav } from "@/components/dashboard/nav";
import { TimeAgo } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
import { Badge, Banner, Button, ButtonLink, cx, ErrorBanner, Skeleton } from "@/components/px/ui";
import { describeError, doorway, type Job, type Run, type Tool } from "@/lib/doorway";
import { fmtMs } from "@/lib/doorway/format";
import { useAction, useLive } from "@/lib/doorway/live";
import {
  explainError,
  failedRuns,
  firstLine,
  latestVersion,
  needsAttention,
  sideEffect,
  statusReason,
  strategyHealth,
  type StrategyHealth,
} from "./health";

const toolRow = (c: { table: string; row: unknown }, id: number) => {
  const row = c.row as { id?: number; tool_id?: number | null };
  return c.table === "doorway_runs" ? row.tool_id === id : row.id === id;
};

export function ToolDiagnosis({
  tool,
  siteName,
  optimize,
  siteJobs,
}: {
  tool: Tool;
  siteName: string;
  optimize: Job | undefined;
  /** Queued / running jobs for this tool's site (heal, discover, verify…). */
  siteJobs: Job[];
}) {
  const { goTo } = useDashboardNav();
  const detail = useLive(`catalog:tool:${tool.id}`, () => doorway.tool(tool.id), {
    tables: ["doorway_runs", "doorway_tools"],
    filter: (c) => toolRow(c, tool.id),
    pollMs: 5000,
    livePollMs: 8000,
  });
  const heal = useAction(doorway.rediscover);
  const [queued, setQueued] = useState<number | null>(null);

  const reason = statusReason(tool, detail.data);
  const version = latestVersion(detail.data);
  const strategies = strategyHealth(tool, version, optimize);
  const failures = failedRuns(detail.data);
  const irreversible = sideEffect(detail.data) === "irreversible_write";
  const passing = strategies.filter((s) => s.passed);
  const failing = strategies.filter((s) => !s.passed);
  const allRefusals =
    failures.length > 0 && failures.every((r) => r.error && /^[a-z][a-z0-9_]+$/.test(r.error.trim()));
  const otherPathFailures = [
    ...new Set(
      failures
        .map((r) => r.strategy)
        .filter((s): s is NonNullable<typeof s> => !!s && s !== passing[0]?.strategy),
    ),
  ];
  const tone = tool.status === "broken" ? "bad" : needsAttention(tool) ? "warn" : "ok";

  const onHeal = async () => {
    const res = await heal.run(tool.site_id);
    if (res) setQueued(res.job_id);
  };

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      {/* Why */}
      <div className="flex min-w-0 flex-col gap-4">
        <div>
          <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-faint">Why</div>
          <div className="flex items-start gap-2">
            <Icon
              name={tone === "bad" ? "broken" : tone === "ok" ? "verify" : "warn"}
              size={15}
              className={cx("mt-0.5 shrink-0", tone === "bad" ? "text-red" : tone === "ok" ? "text-green" : "text-amber")}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-text">{reason.title}</div>
              <p className="text-[13px] text-muted">{reason.body}</p>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-faint">Strategies</span>
            {version && (
              <span className="text-xs text-faint">
                v{version.version} · {version.source}
                {version.verified_by ? ` · ${version.verified_by}` : ""}
                {optimize ? " · re-measured by optimize job #" + optimize.id : ""}
              </span>
            )}
          </div>
          {detail.loading && !detail.data ? (
            <Skeleton className="h-8 w-full" />
          ) : strategies.length ? (
            <ul className="flex flex-col gap-1">
              {strategies.map((s) => (
                <StrategyRow key={s.strategy} s={s} best={s.strategy === tool.best_strategy} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">No strategy results recorded for this tool yet.</p>
          )}
        </div>

        <div>
          <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-faint">Latest failed calls</div>
          {detail.error ? (
            <ErrorBanner error={detail.error} />
          ) : detail.loading && !detail.data ? (
            <Skeleton className="h-10 w-full" />
          ) : failures.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {failures.map((r) => (
                <FailedRun key={r.id} run={r} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">
              {tool.runs_count ? "No failed calls in the recent history." : "No calls yet."}
            </p>
          )}
        </div>
      </div>

      {/* Workaround */}
      <div className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-panel p-3">
        <div className="font-mono text-[11px] uppercase tracking-wider text-faint">How to work with it</div>
        <ul className="flex flex-col gap-2 text-[13px] text-muted">
          {irreversible && tool.status === "draft" && (
            <Tip>
              Run it yourself from <span className="text-text">Try it</span>: you fill the inputs and confirm the one
              call. Agents see it once it&apos;s approved.
            </Tip>
          )}
          {passing.length > 0 && tool.status !== "verified" && (
            <Tip>
              Still works via <span className="font-mono text-text">{passing[0].strategy}</span>, ~
              {fmtMs(passing[0].ms)}. Calls keep succeeding on that path while the fast path is healed.
            </Tip>
          )}
          {passing.length > 0 && tool.status === "verified" && (
            <Tip>
              Fast path <span className="font-mono text-text">{passing[0].strategy}</span> works, ~{fmtMs(passing[0].ms)}.
              {failing.length > 0 &&
                ` Fallbacks ${failing.map((f) => f.strategy).join(", ")} fail; they only matter if the fast path breaks.`}
            </Tip>
          )}
          {!passing.length && !detail.loading && tool.status !== "draft" && (
            <Tip>No strategy passes right now. Re-discover so a sandbox re-learns the site and compiles a new version.</Tip>
          )}
          {otherPathFailures.length > 0 && passing.length > 0 && (
            <Tip>
              The failed calls used <span className="font-mono text-text">{otherPathFailures.join(", ")}</span>, not{" "}
              <span className="font-mono text-text">{passing[0].strategy}</span>. Agents and Try it run the best working
              strategy first, so they aren&apos;t affected.
            </Tip>
          )}
          {allRefusals && (
            <Tip>
              The failures are the site refusing specific inputs, not a broken tool. Retry with different inputs (for
              example another item that&apos;s available).
            </Tip>
          )}
          {failing.length > 0 && (
            <Tip>
              Re-discover &amp; heal queues a job: a free Supabase Compute sandbox re-explores {siteName}, recompiles the
              failing strategies and re-verifies them.
            </Tip>
          )}
        </ul>

        {siteJobs.length > 0 && (
          <div className="flex flex-col gap-1">
            {siteJobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-xs text-muted">
                <Badge status={j.status} />
                <span className="font-mono">
                  {j.kind} #{j.id}
                </span>
                {j.claimed_by && <span className="text-faint">on {j.claimed_by}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="heal" loading={heal.pending} onClick={onHeal}>
            Re-discover &amp; heal
          </Button>
          <ButtonLink size="sm" variant="ghost" icon="execute" href={`/tools/${tool.id}`}>
            Try it
          </ButtonLink>
          <ButtonLink size="sm" variant="ghost" icon="site" href={`/sites/${tool.site_id}`}>
            Open site
          </ButtonLink>
        </div>

        {queued !== null && (
          <Banner
            tone="ok"
            title={`Job #${queued} queued`}
            action={
              <Button size="sm" variant="ghost" onClick={() => goTo("sandboxes")}>
                Watch
              </Button>
            }
          >
            A sandbox picks it up within seconds. This row updates when the new version is verified.
          </Banner>
        )}
        {heal.error !== undefined && (
          <Banner tone="bad" title="Couldn't queue the job">
            {describeError(heal.error)}
          </Banner>
        )}
      </div>
    </div>
  );
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <Icon name="chevron" size={13} className="mt-1 shrink-0 text-faint" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function StrategyRow({ s, best }: { s: StrategyHealth; best: boolean }) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      <Icon name={s.passed ? "verify" : "broken"} size={13} className={cx("shrink-0", s.passed ? "text-green" : "text-red")} />
      <span className="w-14 shrink-0 font-mono text-text">{s.strategy}</span>
      <span className="w-16 shrink-0 font-mono tabular-nums text-muted">{s.passed ? fmtMs(s.ms) : "failed"}</span>
      {best && <Badge tone="ok">best</Badge>}
      {s.error && (
        <span className="min-w-0 truncate font-mono text-faint" title={s.error}>
          {s.error}
        </span>
      )}
    </li>
  );
}

function FailedRun({ run }: { run: Run }) {
  const error = run.error ?? "Failed without an error message";
  const why = run.error ? explainError(run.error) : null;
  return (
    <li className="flex flex-col gap-0.5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
        <TimeAgo iso={run.created_at} />
        {run.strategy && <span className="font-mono text-muted">{run.strategy}</span>}
        <span>{run.mode.replace("_", " ")}</span>
        {run.ms !== null && <span className="font-mono tabular-nums">{fmtMs(run.ms)}</span>}
      </div>
      <code className="break-words font-mono text-xs text-red" title={error}>
        {firstLine(error)}
      </code>
      {why && <span className="text-xs text-muted">{why}</span>}
    </li>
  );
}

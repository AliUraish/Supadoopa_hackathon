"use client";

// One tool, live: header stats, strategy benchmark, version history, recent runs and a
// "Try it" form. Refetches when this tool's row or one of its runs changes.

import Link from "next/link";
import { DoorwayError, doorway, type Run, type Tool } from "@/lib/doorway";
import { fmtInt, fmtMs, fmtPct, fmtUsd } from "@/lib/doorway/format";
import { useLive } from "@/lib/doorway/live";
import { TimeAgo } from "@/components/px/client";
import { Badge, Button, ButtonLink, Empty, ErrorBanner, JsonBlock, Panel, Skeleton, Tile } from "@/components/px/ui";
import { CopyText } from "./copy-text";
import { StrategyChart } from "./strategy-chart";
import { RunTable, VersionTable } from "./tool-tables";
import { TryIt } from "./try-it";

export function ToolPage({ id }: { id: number }) {
  const { data, error, loading, refresh } = useLive(`tool:${id}`, () => doorway.tool(id), {
    tables: ["doorway_tools", "doorway_runs"],
    filter: (c) =>
      c.table === "doorway_tools"
        ? (c.row as Tool).id === id
        : c.table === "doorway_runs" && (c.row as Run).tool_id === id,
  });

  if (loading) return <ToolSkeleton />;

  if (!data) {
    if (error instanceof DoorwayError && error.status === 404) {
      return (
        <div className="px-panel">
          <Empty
            icon="tool"
            title={`Tool #${id} not found`}
            hint="It may have been removed, or the link is wrong."
            action={
              <ButtonLink href="/dashboard?tab=sites" variant="ghost" size="sm" icon="site">
                Back to sites
              </ButtonLink>
            }
          />
        </div>
      );
    }
    return (
      <ErrorBanner
        error={error}
        action={
          <Button size="sm" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        }
      />
    );
  }

  const { tool, versions, runs, spec } = data;
  const latest = versions.length ? versions.reduce((a, b) => (b.version > a.version ? b : a)) : undefined;
  const isAction = tool.kind === "action";
  const successTone = tool.success_rate == null ? "muted" : tool.success_rate >= 0.9 ? "ok" : "warn";

  return (
    <div className="flex flex-col gap-4">
      {error !== undefined && <ErrorBanner error={error} />}

      <nav className="flex flex-wrap items-center gap-2 text-base text-muted">
        <Link href="/dashboard?tab=sites" className="hover:text-green">
          Sites
        </Link>
        <span className="text-faint">/</span>
        <Link href={`/sites/${tool.site_id}`} className="text-green hover:text-green-hi">
          ◂ {tool.site_id}
        </Link>
        <span className="text-faint">/</span>
        <span className="text-text">{tool.name}</span>
      </nav>

      <section className="px-panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-pixel mb-1 text-[8px] uppercase text-faint">MCP tool · #{tool.id}</div>
            <h1 className="font-pixel break-all text-[14px] leading-snug text-green px-glow sm:text-[16px]">
              <CopyText value={`${tool.site_id}__${tool.name}`} />
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge status={tool.status} />
            <Badge tone="muted" pulse={false}>
              v{tool.version}
            </Badge>
            <Badge tone={isAction ? "gold" : "info"} pulse={false}>
              {tool.kind}
            </Badge>
            {tool.best_strategy && (
              <Badge tone="ok" pulse={false}>
                ⚡ {tool.best_strategy}
              </Badge>
            )}
            {tool.pattern_id != null && (
              <Badge tone="violet" pulse={false}>
                pattern #{tool.pattern_id}
              </Badge>
            )}
          </div>
        </div>
        <p className="max-w-3xl text-lg text-text">
          {tool.description ?? <span className="text-faint">No description.</span>}
        </p>
      </section>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          icon="coin"
          label="Price"
          value={isAction ? fmtUsd(tool.price_cents) : "FREE"}
          sub={isAction ? "per successful call" : "reads are free"}
          tone={isAction ? "gold" : "ok"}
        />
        <Tile
          icon="bolt"
          label="Best strategy"
          value={tool.best_strategy ?? "—"}
          sub="fastest that passes"
          tone={tool.best_strategy ? "ok" : "muted"}
        />
        <Tile icon="clock" label="p50" value={fmtMs(tool.p50_ms)} sub="median latency" tone="info" />
        <Tile icon="verify" label="Success" value={fmtPct(tool.success_rate)} sub="of all runs" tone={successTone} />
        <Tile icon="execute" label="Runs" value={fmtInt(tool.runs_count)} sub="agents + dashboard" />
        <Tile icon="clock" label="Updated" value={<TimeAgo iso={tool.updated_at} />} sub={`version ${tool.version}`} tone="muted" />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Strategy benchmark" icon="bolt">
            <StrategyChart tool={tool} version={latest} />
          </Panel>
          <Panel title="Version history" icon="clock" bodyClassName="p-2">
            <VersionTable versions={versions} />
          </Panel>
          {spec != null && (
            <Panel title="Tool spec" icon="compile">
              <details>
                <summary className="font-pixel cursor-pointer text-[8px] uppercase text-muted hover:text-text">
                  Show the compiled spec
                </summary>
                <JsonBlock value={spec} className="mt-2 max-h-[420px]" />
              </details>
            </Panel>
          )}
        </div>
        <TryIt key={tool.id} tool={tool} onRan={refresh} />
      </div>

      <Panel title="Recent runs" icon="execute" bodyClassName="p-2">
        <RunTable runs={runs} />
      </Panel>
    </div>
  );
}

function ToolSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-[120px]" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[86px]" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-[320px]" />
        <Skeleton className="h-[320px]" />
      </div>
    </div>
  );
}

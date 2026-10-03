"use client";

// One tool, live: header stats, strategy benchmark, version history, recent runs and a
// "Try it" form. Refetches when this tool's row or one of its runs changes.

import Link from "next/link";
import { DoorwayError, doorway, type Run, type Tool } from "@/lib/doorway";
import { fmtInt, fmtMs, fmtPct, fmtUsd } from "@/lib/doorway/format";
import { useLive } from "@/lib/doorway/live";
import { TimeAgo } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
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
                Back to websites
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

      <nav className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted" aria-label="Breadcrumb">
        <Link href="/dashboard?tab=sites" className="hover:text-text">
          Websites
        </Link>
        <Icon name="chevron" size={13} className="text-faint" />
        <Link href={`/sites/${tool.site_id}`} className="font-mono text-xs hover:text-text">
          {tool.site_id}
        </Link>
        <Icon name="chevron" size={13} className="text-faint" />
        <span className="font-mono text-xs text-text">{tool.name}</span>
      </nav>

      <header className="flex flex-col gap-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-faint">
              MCP tool · #{tool.id}
            </div>
            <h1 className="break-all font-mono text-xl font-semibold tracking-tight text-text">
              <CopyText value={`${tool.site_id}__${tool.name}`} />
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge status={tool.status} />
            <Badge tone="muted" pulse={false} className="font-mono">
              v{tool.version}
            </Badge>
            <Badge tone={isAction ? "gold" : "info"} pulse={false}>
              {tool.kind}
            </Badge>
            {tool.best_strategy && (
              <Badge tone="ok" pulse={false} className="font-mono normal-case">
                {tool.best_strategy}
              </Badge>
            )}
            {tool.pattern_id != null && (
              <Badge tone="violet" pulse={false}>
                pattern #{tool.pattern_id}
              </Badge>
            )}
          </div>
        </div>
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted">
          {tool.description ?? <span className="text-faint">No description.</span>}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          icon="coin"
          label="Price"
          value={<span className="font-mono">{isAction ? fmtUsd(tool.price_cents) : "Free"}</span>}
          sub={isAction ? "per successful call" : "reads are free"}
          tone={isAction ? "gold" : "ok"}
        />
        <Tile
          icon="bolt"
          label="Best strategy"
          value={<span className="font-mono">{tool.best_strategy ?? "—"}</span>}
          sub="fastest that passes"
          tone={tool.best_strategy ? "ok" : "muted"}
        />
        <Tile icon="clock" label="p50" value={<span className="font-mono">{fmtMs(tool.p50_ms)}</span>} sub="median latency" tone="info" />
        <Tile icon="verify" label="Success" value={fmtPct(tool.success_rate)} sub="of all runs" tone={successTone} />
        <Tile icon="execute" label="Runs" value={fmtInt(tool.runs_count)} sub="agents + dashboard" />
        <Tile icon="clock" label="Updated" value={<TimeAgo iso={tool.updated_at} />} sub={`version ${tool.version}`} tone="muted" />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Strategy benchmark" icon="bolt">
            <StrategyChart tool={tool} version={latest} />
          </Panel>
          <Panel title="Version history" icon="clock" bodyClassName="p-0">
            <VersionTable versions={versions} />
          </Panel>
          {spec != null && (
            <section className="px-panel">
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-[13px] font-medium text-text hover:bg-panel-2 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2">
                    <Icon name="compile" size={15} className="text-muted" />
                    Tool spec
                  </span>
                  <span className="flex items-center gap-1 text-xs font-normal text-faint">
                    <span className="group-open:hidden">Show compiled spec</span>
                    <span className="hidden group-open:inline">Hide</span>
                    <Icon name="chevron" size={13} className="transition-transform group-open:rotate-90" />
                  </span>
                </summary>
                <div className="border-t border-line p-4">
                  <JsonBlock value={spec} className="max-h-[420px]" />
                </div>
              </details>
            </section>
          )}
        </div>
        <TryIt key={tool.id} tool={tool} onRan={refresh} />
      </div>

      <Panel title="Recent runs" icon="execute" bodyClassName="p-0">
        <RunTable runs={runs} />
      </Panel>
    </div>
  );
}

function ToolSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-4 w-56" />
      <div className="flex flex-col gap-2 border-b border-line pb-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-80 max-w-full" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[82px] rounded-lg" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-[320px] rounded-lg" />
        <Skeleton className="h-[320px] rounded-lg" />
      </div>
    </div>
  );
}

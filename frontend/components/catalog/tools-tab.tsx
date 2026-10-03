"use client";

// Tools catalog: every tool Doorway has built, its health, and for any tool that isn't
// working, why it isn't and how to work with it anyway (expandable "Why" rows).

import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useDashboardNav } from "@/components/dashboard/nav";
import { TimeAgo } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
import { Badge, Button, cx, Empty, ErrorBanner, Input, Select, Skeleton } from "@/components/px/ui";
import { doorway, type Job, type Site, type Tool } from "@/lib/doorway";
import { fmtInt, fmtMs, fmtPct } from "@/lib/doorway/format";
import { useLive } from "@/lib/doorway/live";
import { failingFallbacks, latestOptimize, needsAttention, priceLabel } from "./health";
import { Segmented } from "./segmented";
import { ToolDiagnosis } from "./tool-diagnosis";

type KindFilter = "all" | "read" | "action";
type HealthFilter = "all" | "working" | "attention";

const ACTIVE_JOBS = new Set(["queued", "running"]);
const COLS = 12;

export function ToolsTab({ active }: { active: boolean }) {
  const { tab, intent, goTo } = useDashboardNav();
  const tools = useLive(active ? "catalog:tools" : null, () => doorway.tools(), {
    tables: ["doorway_tools", "doorway_runs"],
  });
  const sites = useLive(active ? "catalog:sites" : null, () => doorway.sites(), { pollMs: 10000, livePollMs: 15000 });
  const jobs = useLive(active ? "catalog:jobs" : null, () => doorway.jobs(), {
    tables: ["doorway_jobs"],
    pollMs: 4000,
    livePollMs: 8000,
  });

  const [q, setQ] = useState("");
  const [site, setSite] = useState(intent.siteId ?? "all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [health, setHealth] = useState<HealthFilter>("all");
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());

  // A "Tools" hand-off from another tab (e.g. a site card) preselects the site.
  const [seenIntent, setSeenIntent] = useState(intent);
  if (intent !== seenIntent) {
    setSeenIntent(intent);
    if (tab === "tools" && intent.siteId) setSite(intent.siteId);
  }

  const siteName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sites.data ?? []) m.set(s.id, s.name);
    return (id: string) => m.get(id) ?? id;
  }, [sites.data]);

  const all = useMemo(
    () =>
      [...(tools.data ?? [])].sort(
        (a, b) =>
          Number(needsAttention(b)) - Number(needsAttention(a)) ||
          a.site_id.localeCompare(b.site_id) ||
          a.id - b.id,
      ),
    [tools.data],
  );
  const attention = all.filter(needsAttention).length;

  const needle = q.trim().toLowerCase();
  const rows = all.filter((t) => {
    if (site !== "all" && t.site_id !== site) return false;
    if (kind !== "all" && t.kind !== kind) return false;
    if (health === "working" && needsAttention(t)) return false;
    if (health === "attention" && !needsAttention(t)) return false;
    if (!needle) return true;
    return [t.name, t.site_id, siteName(t.site_id), t.description ?? ""].some((s) => s.toLowerCase().includes(needle));
  });
  const filtered = site !== "all" || kind !== "all" || health !== "all" || needle !== "";

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!active) return null;

  const siteOptions = siteOptionsFrom(sites.data, all);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        {tools.data ? (
          <>
            <span className="text-text">
              <span className="font-mono tabular-nums">{fmtInt(all.length)}</span> tools
            </span>
            <span className="flex items-center gap-1.5 text-muted">
              <span className="size-2 rounded-full bg-green" />
              <span className="font-mono tabular-nums text-text">{fmtInt(all.length - attention)}</span> working
            </span>
            <button
              type="button"
              onClick={() => setHealth(health === "attention" ? "all" : "attention")}
              className={cx("flex items-center gap-1.5", attention ? "text-amber" : "text-muted")}
            >
              <span className={cx("size-2 rounded-full", attention ? "bg-amber" : "bg-line-2")} />
              <span className="font-mono tabular-nums">{fmtInt(attention)}</span> need attention
            </button>
          </>
        ) : (
          <Skeleton className="h-5 w-64" />
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Icon name="lookup" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            className="pl-8"
          />
        </div>
        <Select
          value={site}
          onChange={(e) => setSite(e.target.value)}
          aria-label="Website"
          className="w-auto min-w-40"
        >
          <option value="all">All websites</option>
          {siteOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Segmented
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "read", label: "Read" },
            { value: "action", label: "Action" },
          ]}
        />
        <Segmented
          label="Status"
          value={health}
          onChange={setHealth}
          options={[
            { value: "all", label: "All" },
            { value: "working", label: "Working" },
            { value: "attention", label: "Needs attention", count: attention || undefined },
          ]}
        />
      </div>

      {tools.error !== undefined && (
        <ErrorBanner
          error={tools.error}
          action={
            <Button size="sm" variant="ghost" onClick={tools.refresh}>
              Retry
            </Button>
          }
        />
      )}

      {/* Table */}
      <div className="px-panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs text-faint">
                <Th>Tool</Th>
                <Th className="hidden lg:table-cell">Website</Th>
                <Th className="hidden md:table-cell">Kind</Th>
                <Th>Status</Th>
                <Th className="hidden 2xl:table-cell" right>
                  Ver
                </Th>
                <Th className="hidden lg:table-cell">Best</Th>
                <Th className="hidden md:table-cell" right>
                  p50
                </Th>
                <Th right>Success</Th>
                <Th className="hidden md:table-cell" right>
                  Price
                </Th>
                <Th className="hidden xl:table-cell" right>
                  Runs
                </Th>
                <Th className="hidden xl:table-cell">Updated</Th>
                <Th>
                  <span className="sr-only">Details</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {!tools.data && !tools.error
                ? [0, 1, 2, 3].map((i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td colSpan={COLS} className="px-4 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    </tr>
                  ))
                : rows.map((t) => (
                    <Fragment key={t.id}>
                      <ToolRow
                        tool={t}
                        siteName={siteName(t.site_id)}
                        optimize={latestOptimize(jobs.data, t.site_id)}
                        open={open.has(t.id)}
                        onToggle={() => toggle(t.id)}
                      />
                      {open.has(t.id) && (
                        <tr className="border-b border-line bg-bg-2 last:border-0">
                          <td colSpan={COLS} className="p-0">
                            <ToolDiagnosis
                              tool={t}
                              siteName={siteName(t.site_id)}
                              optimize={latestOptimize(jobs.data, t.site_id)}
                              siteJobs={activeJobs(jobs.data, t.site_id)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
            </tbody>
          </table>
        </div>

        {tools.data && !rows.length && (
          filtered ? (
            <Empty
              icon="lookup"
              title="No tools match these filters"
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQ("");
                    setSite("all");
                    setKind("all");
                    setHealth("all");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <Empty
              icon="tool"
              title="No tools yet"
              hint="Add a website: sandboxes discover it, compile its tools, verify them and list them here."
              action={
                <Button size="sm" icon="plus" onClick={() => goTo("sites")}>
                  Add a website
                </Button>
              }
            />
          )
        )}
      </div>
    </div>
  );
}

function Th({ children, className, right }: { children: ReactNode; className?: string; right?: boolean }) {
  return (
    <th scope="col" className={cx("whitespace-nowrap px-3 py-2 font-normal first:pl-4 last:pr-4", right && "text-right", className)}>
      {children}
    </th>
  );
}

function ToolRow({
  tool,
  siteName,
  optimize,
  open,
  onToggle,
}: {
  tool: Tool;
  siteName: string;
  optimize: Job | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const attention = needsAttention(tool);
  const fallbacks = failingFallbacks(tool, optimize);
  const rate = tool.success_rate;
  const rateClass = rate === null ? "text-faint" : rate < 0.5 ? "text-red" : rate < 0.9 ? "text-amber" : "text-text";
  const td = "whitespace-nowrap px-3 py-2.5 align-middle first:pl-4 last:pr-4";

  return (
    <tr className={cx("border-b border-line transition-colors last:border-0 hover:bg-panel-2", open && "bg-panel-2")}>
      <td className={td}>
        <Link
          href={`/tools/${tool.id}`}
          className="font-mono text-[13px] text-text hover:text-green"
          title={tool.description ?? undefined}
        >
          <span className="text-faint">{tool.site_id}__</span>
          {tool.name}
        </Link>
        <div className="mt-0.5 text-xs text-faint lg:hidden">
          {siteName}
          <span className="md:hidden"> · {tool.kind}</span>
        </div>
      </td>
      <td className={cx(td, "hidden max-w-40 whitespace-normal lg:table-cell")}>
        <Link href={`/sites/${tool.site_id}`} className="text-muted hover:text-text">
          {siteName}
        </Link>
      </td>
      <td className={cx(td, "hidden md:table-cell")}>
        <Badge tone={tool.kind === "action" ? "gold" : "info"}>{tool.kind}</Badge>
      </td>
      <td className={td}>
        <Badge status={tool.status} />
      </td>
      <td className={cx(td, "hidden text-right font-mono tabular-nums text-muted 2xl:table-cell")}>v{tool.version}</td>
      <td className={cx(td, "hidden lg:table-cell")}>
        <span className="font-mono text-muted">{tool.best_strategy ?? "—"}</span>
        {fallbacks.length > 0 && (
          <div className="text-xs text-amber" title={`Fallback strategies failing: ${fallbacks.join(", ")}`}>
            {fallbacks.length} fallback{fallbacks.length > 1 ? "s" : ""} down
          </div>
        )}
      </td>
      <td className={cx(td, "hidden text-right font-mono tabular-nums text-muted md:table-cell")}>{fmtMs(tool.p50_ms)}</td>
      <td className={cx(td, "text-right font-mono tabular-nums", rateClass)} title={rate === null ? "No calls yet" : undefined}>
        {fmtPct(rate)}
      </td>
      <td className={cx(td, "hidden text-right font-mono tabular-nums md:table-cell", tool.price_cents ? "text-text" : "text-faint")}>
        {priceLabel(tool.price_cents)}
      </td>
      <td className={cx(td, "hidden text-right font-mono tabular-nums text-muted xl:table-cell")}>{fmtInt(tool.runs_count)}</td>
      <td className={cx(td, "hidden whitespace-nowrap text-xs text-faint xl:table-cell")}>
        <TimeAgo iso={tool.updated_at} />
      </td>
      <td className={cx(td, "text-right")}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cx(
            "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs transition-colors",
            attention
              ? "border border-amber/40 bg-amber/10 text-amber hover:bg-amber/15"
              : "text-muted hover:bg-panel-3 hover:text-text",
          )}
        >
          {attention ? "Why" : "Details"}
          <Icon name="chevron" size={13} className={cx("transition-transform", open && "rotate-90")} />
        </button>
      </td>
    </tr>
  );
}

function activeJobs(jobs: Job[] | undefined, siteId: string): Job[] {
  return (jobs ?? []).filter((j) => j.site_id === siteId && ACTIVE_JOBS.has(j.status)).slice(0, 4);
}

function siteOptionsFrom(sites: Site[] | undefined, tools: Tool[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const s of sites ?? []) m.set(s.id, s.name);
  for (const t of tools) if (!m.has(t.site_id)) m.set(t.site_id, t.site_id);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

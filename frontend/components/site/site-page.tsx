"use client";

// /sites/[id]: one site, live. Header + demo controls (rediscover / break / reset), the
// capabilities Doorway observed, the tools it compiled, this site's event feed and its MCP URL.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  doorway,
  doorwayBaseUrl,
  DoorwayError,
  type Capability,
  type RowChange,
  type Site,
  type SiteDetail,
  type Tool,
} from "@/lib/doorway";
import { fmtInt, fmtMs, fmtPct, fmtUsd, isPulsing, type Tone } from "@/lib/doorway/format";
import { useAction, useLive } from "@/lib/doorway/live";
import { ConnectAgent } from "@/components/connect-agent";
import { EventFeed } from "@/components/feeds/event-feed";
import { LiveBadge, TimeAgo } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  Empty,
  ErrorBanner,
  Meter,
  Panel,
  Skeleton,
  StatusDot,
} from "@/components/px/ui";
import { ExternalLink, FileJson } from "lucide-react";

const kindTone = (kind: string): Tone => (kind === "action" ? "gold" : "info");

function BackLink() {
  return (
    <Link
      href="/dashboard?tab=sites"
      className="inline-flex w-fit items-center gap-1 text-xs text-muted transition-colors hover:text-text"
    >
      <Icon name="chevron" size={13} className="rotate-180" />
      Websites
    </Link>
  );
}

// ── Header + demo controls ─────────────────────────────────────────────────

type Notice = { tone: Tone; text: ReactNode };

function DemoControls({ siteId, onDone }: { siteId: string; onDone: () => void }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const rediscover = useAction(() => doorway.rediscover(siteId));
  const breaker = useAction(() => doorway.breakSite(siteId));
  const resetter = useAction(() => doorway.resetSite(siteId));
  const error = rediscover.error ?? breaker.error ?? resetter.error;
  const busy = rediscover.pending || breaker.pending || resetter.pending;
  const apiLabel = (v: string) => `API ${v.startsWith("v") ? v : `v${v}`}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-faint">
        <Icon name="bolt" size={12} className="text-amber" />
        Demo controls
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Demo controls">
        <Button
          size="sm"
          variant="ghost"
          icon="discover"
          loading={rediscover.pending}
          disabled={busy}
          onClick={async () => {
            const r = await rediscover.run();
            if (r) {
              setNotice({ tone: "info", text: `Rediscovery queued · job #${r.job_id}` });
              onDone();
            }
          }}
        >
          Rediscover
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="broken"
          loading={breaker.pending}
          disabled={busy}
          onClick={async () => {
            const r = await breaker.run();
            if (r) {
              setNotice({ tone: "bad", text: `Site switched to ${apiLabel(r.version)}. Tools should break, then self-heal.` });
              onDone();
            }
          }}
        >
          Break site
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="heal"
          loading={resetter.pending}
          disabled={busy}
          onClick={async () => {
            const r = await resetter.run();
            if (r) {
              setNotice({ tone: "ok", text: `Site reset to ${apiLabel(r.version)}, bookings cleared.` });
              onDone();
            }
          }}
        >
          Reset
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        <span className="text-text">Break site</span> flips the site&apos;s private API from v1 to v2. Watch its tools
        go <span className="text-green">verified</span> → <span className="text-red">broken</span> →{" "}
        <span className="text-amber">repairing</span> → <span className="text-green">verified</span> on their own.
      </p>
      {error ? (
        <ErrorBanner
          error={error}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                rediscover.reset();
                breaker.reset();
                resetter.reset();
              }}
            >
              Dismiss
            </Button>
          }
        />
      ) : (
        notice && (
          <Banner tone={notice.tone} icon={notice.tone === "bad" ? "broken" : notice.tone === "ok" ? "verify" : "discover"}>
            {notice.text}
          </Banner>
        )
      )}
    </div>
  );
}

function SiteHeader({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const openapi = `${doorwayBaseUrl()}/doorway/sites/${encodeURIComponent(site.id)}/openapi.json`;
  return (
    <Panel tone={site.status === "broken" || site.status === "failed" ? "bad" : undefined} bodyClassName="p-5!">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-md border border-line bg-panel-2 text-muted">
              <Icon name="globe" size={18} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-text">{site.name}</h1>
                <Badge status={site.status} pulse={isPulsing(site.status) || site.status === "queued"} />
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
                <a
                  href={site.base_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-muted transition-colors hover:text-green"
                >
                  <span className="truncate">{site.base_url}</span>
                  <ExternalLink size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
                </a>
                <a
                  href={openapi}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted transition-colors hover:text-green"
                >
                  <FileJson size={12} strokeWidth={1.75} aria-hidden />
                  OpenAPI
                </a>
                <span>
                  id <span className="font-mono text-muted">{site.id}</span>
                </span>
                <span>
                  updated <TimeAgo iso={site.updated_at} />
                </span>
              </div>
            </div>
          </div>
          {site.goal && (
            <p className="text-[13px] leading-relaxed text-muted">
              <span className="mr-2 font-mono text-[11px] uppercase tracking-wider text-faint">Goal</span>
              {site.goal}
            </p>
          )}
          <div className="flex max-w-md flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-faint">Tools verified</span>
              <span className="font-mono tabular-nums">
                <span className="text-green">{fmtInt(site.verified_count)}</span>
                <span className="text-faint"> / {fmtInt(site.tools_count)}</span>
              </span>
            </div>
            <Meter value={site.verified_count} max={Math.max(1, site.tools_count)} />
          </div>
        </div>
        <div className="px-inset rounded-md p-4">
          <DemoControls siteId={site.id} onDone={onChanged} />
        </div>
      </div>
    </Panel>
  );
}

// ── Tools ──────────────────────────────────────────────────────────────────

const TH = "px-3 py-2 text-xs font-medium text-faint";
const NUM = "px-3 py-2.5 text-right font-mono text-xs tabular-nums";

function ToolsPanel({ tools }: { tools: Tool[] }) {
  const sorted = [...tools].sort((a, b) => a.id - b.id);
  return (
    <Panel title={`Tools · ${tools.length}`} icon="tool" actions={<LiveBadge />} bodyClassName="p-0! overflow-x-auto">
      {!sorted.length ? (
        <Empty icon="tool" title="No tools yet" hint="Discovery compiles one tool per capability. Try Rediscover." />
      ) : (
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel-2 text-left">
              <th className={`${TH} pl-4`}>Tool</th>
              <th className={TH}>Status</th>
              <th className={`${TH} text-right`}>Version</th>
              <th className={TH}>Strategy</th>
              <th className={`${TH} text-right`}>p50</th>
              <th className={`${TH} text-right`}>Success</th>
              <th className={`${TH} text-right`}>Price</th>
              <th className={`${TH} pr-4 text-right`}>Runs</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id} className="border-b border-line transition-colors last:border-0 hover:bg-panel-2">
                <td className="max-w-[340px] py-2.5 pl-4 pr-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/tools/${t.id}`}
                      className="truncate font-mono text-[12.5px] text-text transition-colors hover:text-green"
                    >
                      {t.name}
                    </Link>
                    <Badge tone={kindTone(t.kind)}>{t.kind}</Badge>
                  </div>
                  {t.description && <div className="mt-0.5 truncate text-xs text-faint">{t.description}</div>}
                </td>
                <td className="px-3 py-2.5">
                  <Badge status={t.status} />
                </td>
                <td className={`${NUM} text-muted`}>v{t.version}</td>
                <td className="px-3 py-2.5 text-xs text-muted">{t.best_strategy ?? "—"}</td>
                <td className={`${NUM} text-text`}>{fmtMs(t.p50_ms)}</td>
                <td className={`${NUM} text-text`}>{fmtPct(t.success_rate)}</td>
                <td className={NUM}>
                  {t.price_cents > 0 ? (
                    <span className="text-gold">{fmtUsd(t.price_cents)}</span>
                  ) : (
                    <span className="font-sans text-faint">free</span>
                  )}
                </td>
                <td className={`${NUM} pr-4 text-muted`}>{fmtInt(t.runs_count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ── Capabilities ───────────────────────────────────────────────────────────

function CapabilitiesPanel({ capabilities, tools }: { capabilities: Capability[]; tools: Tool[] }) {
  const toolName = new Map(tools.map((t) => [t.id, t.name]));
  const sorted = [...capabilities].sort((a, b) => a.id - b.id);
  return (
    <Panel title={`Capabilities · ${capabilities.length}`} icon="observe">
      {!sorted.length ? (
        <Empty
          icon="observe"
          title="Nothing observed yet"
          hint="A sandbox explores the site and lists what a visitor can do there."
        />
      ) : (
        <ul className="-my-1 flex flex-col">
          {sorted.map((c) => (
            <li key={c.id} className="flex items-start gap-3 border-b border-line py-3 last:border-0">
              <StatusDot status={c.status} size={7} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-text">{c.name}</span>
                  <Badge tone={kindTone(c.kind)}>{c.kind}</Badge>
                  <Badge status={c.status} />
                </div>
                {c.description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{c.description}</p>}
              </div>
              {c.tool_id !== null ? (
                <Link
                  href={`/tools/${c.tool_id}`}
                  className="mt-0.5 inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md border border-line bg-panel-2 px-2 py-0.5 font-mono text-xs text-muted transition-colors hover:border-line-2 hover:text-green"
                >
                  <Icon name="tool" size={12} className="shrink-0" />
                  <span className="truncate">{toolName.get(c.tool_id) ?? `tool #${c.tool_id}`}</span>
                  <Icon name="chevron" size={12} className="shrink-0" />
                </Link>
              ) : (
                <span className="mt-1 shrink-0 text-xs text-faint">Not compiled</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Page states ────────────────────────────────────────────────────────────

function SiteSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-[200px]" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[260px]" />
          <Skeleton className="h-[220px]" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[360px]" />
          <Skeleton className="h-[160px]" />
        </div>
      </div>
    </div>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <Panel tone="bad" bodyClassName="p-6!">
      <Empty
        icon="broken"
        title="Site not found"
        hint={`Doorway has no site with id "${id}". It may not be discovered yet.`}
        action={
          <ButtonLink href="/dashboard?tab=sites" variant="ghost" size="sm" icon="globe" className="mt-2">
            Back to websites
          </ButtonLink>
        }
      />
    </Panel>
  );
}

const forSite = (id: string) => (c: RowChange) => (c.row as { site_id?: string | null }).site_id === id;

export function SitePage({ id }: { id: string }) {
  const { data, error, loading, refresh } = useLive<SiteDetail>(`site:${id}`, () => doorway.site(id), {
    tables: ["doorway_tools", "doorway_events", "doorway_jobs"],
    filter: forSite(id),
  });

  let body: ReactNode;
  if (loading) body = <SiteSkeleton />;
  else if (!data && error instanceof DoorwayError && error.status === 404) body = <NotFound id={id} />;
  else if (!data)
    body = (
      <div className="flex flex-col gap-3">
        <BackLink />
        <ErrorBanner
          error={error}
          action={
            <Button size="sm" variant="ghost" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </div>
    );
  else
    body = (
      <>
        <BackLink />
        <SiteHeader site={data.site} onChanged={refresh} />
        {error ? <ErrorBanner error={error} /> : null}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <ToolsPanel tools={data.tools} />
            <CapabilitiesPanel capabilities={data.capabilities} tools={data.tools} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <EventFeed siteId={id} title="Site events" />
            <ConnectAgent siteId={id} />
          </div>
        </div>
      </>
    );

  return <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-5 lg:px-6">{body}</div>;
}

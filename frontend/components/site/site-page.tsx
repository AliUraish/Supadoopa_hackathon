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
import { PixelIcon } from "@/components/px/icons";
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

const kindTone = (kind: string): Tone => (kind === "action" ? "gold" : "info");

function BackLink() {
  return (
    <Link
      href="/dashboard?tab=graph"
      className="font-pixel inline-flex items-center gap-1.5 text-[9px] uppercase text-muted hover:text-green"
    >
      <PixelIcon name="chevron" size={10} className="rotate-180" />
      Back to graph
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
      <div className="font-pixel flex items-center gap-2 text-[9px] uppercase text-amber">
        <PixelIcon name="bolt" size={12} />
        Demo controls
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
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
          variant="danger"
          icon="broken"
          loading={breaker.pending}
          disabled={busy}
          onClick={async () => {
            const r = await breaker.run();
            if (r) {
              setNotice({ tone: "bad", text: `Site switched to ${apiLabel(r.version)} — tools should break, then self-heal.` });
              onDone();
            }
          }}
        >
          Break site
        </Button>
        <Button
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
      <p className="text-base text-muted">
        <span className="text-red">Break site</span> flips the site&apos;s private API v1 → v2. Watch the tools go{" "}
        <span className="text-green">verified</span> → <span className="text-red">broken</span> →{" "}
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
  return (
    <Panel tone={site.status === "broken" || site.status === "failed" ? "bad" : undefined} bodyClassName="p-4!">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <BackLink />
          <div className="flex flex-wrap items-center gap-3">
            <PixelIcon name="globe" size={22} className="text-green" />
            <h1 className="font-pixel min-w-0 break-words text-[16px] uppercase leading-snug text-text px-glow">
              {site.name}
            </h1>
            <Badge status={site.status} pulse={isPulsing(site.status) || site.status === "queued"} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-base">
            <a
              href={site.base_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 truncate text-green underline decoration-dotted underline-offset-4 hover:text-green-hi"
            >
              <PixelIcon name="site" size={12} className="shrink-0" />
              <span className="truncate">{site.base_url}</span>
              <span aria-hidden>↗</span>
            </a>
            <span className="text-faint">id {site.id}</span>
            <span className="text-faint">
              updated <TimeAgo iso={site.updated_at} />
            </span>
            <a
              href={`${doorwayBaseUrl()}/doorway/sites/${encodeURIComponent(site.id)}/openapi.json`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-muted underline decoration-dotted underline-offset-4 hover:text-green"
            >
              <PixelIcon name="copy" size={12} />
              OpenAPI
            </a>
          </div>
          {site.goal && (
            <p className="text-lg text-muted">
              <span className="font-pixel mr-2 text-[8px] uppercase text-faint">Goal</span>
              {site.goal}
            </p>
          )}
          <div className="flex max-w-md flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-base">
              <span className="font-pixel text-[8px] uppercase text-faint">Tools verified</span>
              <span>
                <span className="text-green">{fmtInt(site.verified_count)}</span>
                <span className="text-muted"> / {fmtInt(site.tools_count)}</span>
              </span>
            </div>
            <Meter value={site.verified_count} max={Math.max(1, site.tools_count)} segments={16} />
          </div>
        </div>
        <div className="border-line lg:border-l-2 lg:pl-5">
          <DemoControls siteId={site.id} onDone={onChanged} />
        </div>
      </div>
    </Panel>
  );
}

// ── Tools ──────────────────────────────────────────────────────────────────

function ToolsPanel({ tools }: { tools: Tool[] }) {
  const sorted = [...tools].sort((a, b) => a.id - b.id);
  return (
    <Panel title={`Tools · ${tools.length}`} icon="tool" actions={<LiveBadge />} bodyClassName="p-0! overflow-x-auto">
      {!sorted.length ? (
        <Empty icon="tool" title="No tools yet" hint="Discovery compiles one tool per capability. Try Rediscover." />
      ) : (
        <table className="w-full min-w-[720px] border-collapse text-base">
          <thead>
            <tr className="font-pixel border-b-2 border-line text-left text-[8px] uppercase text-faint">
              <th className="px-3 py-2 font-normal">Tool</th>
              <th className="px-2 py-2 font-normal">Status</th>
              <th className="px-2 py-2 text-right font-normal">Ver</th>
              <th className="px-2 py-2 font-normal">Best</th>
              <th className="px-2 py-2 text-right font-normal">p50</th>
              <th className="px-2 py-2 text-right font-normal">Success</th>
              <th className="px-2 py-2 text-right font-normal">Price</th>
              <th className="px-3 py-2 text-right font-normal">Runs</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id} className="border-b border-line/60 last:border-0 hover:bg-panel-2">
                <td className="max-w-[320px] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Link href={`/tools/${t.id}`} className="truncate text-green hover:text-green-hi hover:underline">
                      {t.name}
                    </Link>
                    <Badge tone={kindTone(t.kind)}>{t.kind}</Badge>
                  </div>
                  {t.description && <div className="truncate text-sm text-faint">{t.description}</div>}
                </td>
                <td className="px-2 py-2">
                  <Badge status={t.status} />
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-muted">v{t.version}</td>
                <td className="px-2 py-2 text-muted">{t.best_strategy ?? "—"}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtMs(t.p50_ms)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtPct(t.success_rate)}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {t.price_cents > 0 ? (
                    <span className="text-gold">{fmtUsd(t.price_cents)}</span>
                  ) : (
                    <span className="text-faint">free</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtInt(t.runs_count)}</td>
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
        <ul className="flex flex-col">
          {sorted.map((c) => (
            <li key={c.id} className="flex items-start gap-3 border-b border-line/60 py-2 last:border-0">
              <StatusDot status={c.status} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg leading-tight text-text">{c.name}</span>
                  <Badge tone={kindTone(c.kind)}>{c.kind}</Badge>
                  <Badge status={c.status} />
                </div>
                {c.description && <p className="text-base leading-tight text-muted">{c.description}</p>}
              </div>
              {c.tool_id !== null ? (
                <Link
                  href={`/tools/${c.tool_id}`}
                  className="font-pixel mt-1 inline-flex shrink-0 items-center gap-1 text-[8px] uppercase text-green hover:text-green-hi"
                >
                  <PixelIcon name="tool" size={10} />
                  {toolName.get(c.tool_id) ?? `tool #${c.tool_id}`}
                  <PixelIcon name="chevron" size={10} />
                </Link>
              ) : (
                <span className="font-pixel mt-1 shrink-0 text-[8px] uppercase text-faint">not compiled</span>
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
      <Skeleton className="h-[190px]" />
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
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <ButtonLink href="/dashboard?tab=graph" variant="ghost" size="sm" icon="graph">
              Back to graph
            </ButtonLink>
            <ButtonLink href="/dashboard?tab=sites" size="sm" icon="plus">
              Add a site
            </ButtonLink>
          </div>
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

  return <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4">{body}</main>;
}

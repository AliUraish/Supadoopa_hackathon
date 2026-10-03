"use client";

// Live list of the sites Doorway knows (never hard-coded): status and their tools.

import Link from "next/link";
import { useMemo } from "react";
import { doorway, DOORWAY_MOCK, type Tool } from "@/lib/doorway";
import { fmtUsd } from "@/lib/doorway/format";
import { useLive } from "@/lib/doorway/live";
import { LiveBadge } from "@/components/px/client";
import { Badge, Button, Empty, ErrorBanner, Panel, Skeleton, StatusDot, cx } from "@/components/px/ui";

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function DemoSites({ className }: { className?: string }) {
  const sites = useLive("landing:sites", () => doorway.sites(), { tables: ["doorway_tools"], pollMs: 10000 });
  const tools = useLive("landing:tools", () => doorway.tools(), { tables: ["doorway_tools"], pollMs: 10000 });

  const toolsBySite = useMemo(() => {
    const map = new Map<string, Tool[]>();
    for (const t of tools.data ?? []) map.set(t.site_id, [...(map.get(t.site_id) ?? []), t]);
    return map;
  }, [tools.data]);

  return (
    <Panel title="Sites on Doorway" icon="site" actions={<LiveBadge />} className={className}>
      {sites.loading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : sites.error ? (
        <div className="flex flex-col gap-2">
          <ErrorBanner
            error={sites.error}
            action={
              <Button variant="ghost" size="sm" onClick={sites.refresh}>
                Retry
              </Button>
            }
          />
          {!DOORWAY_MOCK && (
            <p className="text-sm text-faint">
              Start the backend, or set <code className="text-text">NEXT_PUBLIC_DOORWAY_MOCK=1</code> for the
              in-browser demo.
            </p>
          )}
        </div>
      ) : !sites.data?.length ? (
        <Empty icon="site" title="No sites yet" hint="Add any website from the dashboard and watch it get discovered." />
      ) : (
        <ul className="flex flex-col">
          {sites.data.map((site) => {
            const siteTools = toolsBySite.get(site.id) ?? [];
            return (
              <li key={site.id} className="flex flex-col gap-1.5 border-t-2 border-line py-2.5 first:border-t-0 first:pt-0">
                <div className="flex min-w-0 items-center gap-2">
                  <StatusDot status={site.status} />
                  <Link href={`/sites/${site.id}`} className="truncate text-lg text-text hover:text-green">
                    {site.name}
                  </Link>
                  <Badge status={site.status} />
                  <span className="ml-auto shrink-0 text-sm text-faint">
                    {site.verified_count}/{site.tools_count} verified
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pl-5">
                  {siteTools.length ? (
                    siteTools.map((t) => (
                      <span
                        key={t.id}
                        className="px-frame inline-flex items-center gap-1.5 px-1.5 text-sm text-muted"
                        title={t.description ?? t.name}
                      >
                        <StatusDot status={t.status} size={6} />
                        {t.name}
                        <span className={cx(t.price_cents ? "text-gold" : "text-green")}>
                          {t.price_cents ? fmtUsd(t.price_cents) : "free"}
                        </span>
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-faint">
                      {tools.error ? "tools unavailable" : tools.loading ? "loading tools…" : "no tools yet"}
                    </span>
                  )}
                  <span className="ml-auto truncate text-sm text-faint">{host(site.base_url)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

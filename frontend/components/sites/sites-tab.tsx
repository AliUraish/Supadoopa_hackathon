"use client";

// Sites tab: add a website (starts discovery) and watch every site's tools come online.
// Each card carries the demo buttons that break a site's private API to show self-healing.

import Link from "next/link";
import { useState } from "react";
import { doorway, type Site } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";
import { useDashboardNav } from "@/components/dashboard/dashboard-tabs";
import { Banner, Button, Empty, ErrorBanner, SectionTitle } from "@/components/px/ui";
import { AddSiteForm, type SiteAdded } from "./add-site-form";
import { SiteCard, SiteCardSkeleton } from "./site-card";

function summary(sites: Site[]): string {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(" · ");
}

export function SitesTab({ active }: { active: boolean }) {
  const { goTo } = useDashboardNav();
  const [started, setStarted] = useState<SiteAdded | null>(null);
  const { data: sites, error, loading, refresh, mutate } = useLive("sites", () => doorway.sites(), {
    tables: ["doorway_events", "doorway_tools", "doorway_jobs"],
    // Stay subscribed while hidden (cards keep their demo state); only the fallback poll pauses.
    poll: active,
  });

  const onAdded = (added: SiteAdded) => {
    setStarted(added);
    mutate((prev) => [added.site, ...(prev ?? []).filter((s) => s.id !== added.site.id)]);
    refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <AddSiteForm onAdded={onAdded} />

      {started && (
        <Banner
          tone="ok"
          icon="discover"
          title="Discovery started"
          action={
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button size="sm" icon="graph" onClick={() => goTo("graph")}>
                Watch on Graph
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStarted(null)} aria-label="Dismiss">
                ×
              </Button>
            </div>
          }
        >
          Discovery started — job #{started.job_id} for{" "}
          <Link href={`/sites/${started.site.id}`} className="text-green underline">
            {started.site.name}
          </Link>
          . Watch it on the Graph.
        </Banner>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle icon="site">Websites{sites ? ` · ${sites.length}` : ""}</SectionTitle>
        {sites && sites.length > 0 && <span className="text-sm text-faint">{summary(sites)}</span>}
      </div>

      {sites && error !== undefined && <ErrorBanner error={error} />}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <SiteCardSkeleton key={i} />
          ))}
        </div>
      ) : !sites ? (
        <ErrorBanner
          error={error}
          action={
            <Button size="sm" variant="ghost" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : !sites.length ? (
        <div className="px-panel">
          <Empty
            icon="site"
            title="No websites yet"
            hint="Paste a URL above. A sandbox discovers what people do there and compiles it into verified tools your agent can call."
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sites.map((site) => (
            <SiteCard key={site.id} site={site} fresh={started?.site.id === site.id} />
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

// Websites tab: add a website (starts discovery) and watch every site's tools come online.
// Each card carries the demo buttons that break a site's private API to show self-healing.

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { doorway, type Site } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";
import { Icon } from "@/components/px/icons";
import { Banner, Button, ButtonLink, Empty, ErrorBanner } from "@/components/px/ui";
import { AddSiteForm, type SiteAdded } from "./add-site-form";
import { SiteCard, SiteCardSkeleton } from "./site-card";

function summary(sites: Site[]): string {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(" · ");
}

const GRID = "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

export function SitesTab({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
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

      <AnimatePresence initial={false}>
        {started && (
          <motion.div
            key={started.job_id}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            <Banner
              tone="ok"
              icon="discover"
              title="Discovery started"
              action={
                <div className="flex shrink-0 items-center gap-1.5">
                  <ButtonLink size="sm" icon="site" href={`/sites/${started.site.id}`}>
                    Open site
                  </ButtonLink>
                  <Button size="sm" variant="ghost" onClick={() => setStarted(null)} aria-label="Dismiss" className="px-1.5">
                    <Icon name="close" size={13} />
                  </Button>
                </div>
              }
            >
              Job <span className="font-mono tabular-nums text-text">#{started.job_id}</span> is exploring{" "}
              <Link href={`/sites/${started.site.id}`} className="text-text underline-offset-2 hover:text-green hover:underline">
                {started.site.name}
              </Link>
              .
            </Banner>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="flex items-baseline gap-2 text-[13px] font-medium text-text">
          Websites
          {sites && <span className="font-mono text-xs tabular-nums text-faint">{sites.length}</span>}
        </h2>
        {sites && sites.length > 0 && <span className="text-xs text-faint">{summary(sites)}</span>}
      </div>

      {sites && error !== undefined && <ErrorBanner error={error} />}

      {loading ? (
        <div className={GRID}>
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
        <div className={GRID}>
          {sites.map((site) => (
            <SiteCard key={site.id} site={site} fresh={started?.site.id === site.id} />
          ))}
        </div>
      )}
    </div>
  );
}

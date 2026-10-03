"use client";

import { doorway } from "@/lib/doorway";
import { fmtInt, fmtMs, fmtPct, fmtUsd, speedup } from "@/lib/doorway/format";
import { useLive } from "@/lib/doorway/live";
import { ErrorBanner, Skeleton, Tile } from "@/components/px/ui";

/** Live metric tiles across the top of the dashboard. */
export function MetricsBar() {
  const { data: m, error, loading } = useLive("metrics", () => doorway.metrics(), {
    tables: ["doorway_events", "doorway_runs", "doorway_tools"],
    debounceMs: 400,
  });

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[86px]" />
        ))}
      </div>
    );
  }
  if (!m) return <ErrorBanner error={error} />;

  const x = speedup(m.browser_p50_ms, m.broker_p50_ms);
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      <Tile icon="site" label="Sites" value={fmtInt(m.sites)} sub={`${fmtInt(m.patterns)} shared patterns`} />
      <Tile
        icon="verify"
        label="Verified tools"
        value={fmtInt(m.tools_verified)}
        sub={`reused ${fmtInt(m.reuse_count)}× across sites`}
      />
      <Tile
        icon="bolt"
        label="Broker p50"
        value={fmtMs(m.broker_p50_ms)}
        sub={
          <>
            browser {fmtMs(m.browser_p50_ms)}
            {x && <span className="text-green"> · {x}× faster</span>}
          </>
        }
      />
      <Tile icon="execute" label="Runs" value={fmtInt(m.runs)} sub={`${fmtPct(m.success_rate)} success`} />
      <Tile icon="heal" label="Self-heals" value={fmtInt(m.heals)} tone="warn" sub="broken → verified" />
      <Tile icon="coin" label="Revenue" value={fmtUsd(m.revenue_cents)} tone="gold" sub="Stripe test mode" />
    </div>
  );
}

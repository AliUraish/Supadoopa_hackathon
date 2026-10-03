"use client";

// One website: status, discovery progress, verified-tool meter and the demo buttons
// (break the private API → watch the tools self-heal; reset; race; open).

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { describeError, doorway, type Site, type SiteStatus } from "@/lib/doorway";
import { TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useAction, useNow } from "@/lib/doorway/live";
import { useDashboardNav } from "@/components/dashboard/dashboard-tabs";
import { TimeAgo } from "@/components/px/client";
import { PixelIcon } from "@/components/px/icons";
import { Badge, Button, ButtonLink, cx, Meter } from "@/components/px/ui";
import { PhaseStrip } from "./phase-strip";

const BUSY: SiteStatus[] = ["queued", "discovering", "verifying", "healing"];
/** Statuses that are mid-cycle: keep the "API v2" note up until the site settles again. */
const UNSETTLED: SiteStatus[] = [...BUSY, "new", "broken"];
/** Show a returned API version for at least this long. */
const NOTE_MIN_MS = 6000;

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function meterTone(site: Site): Tone {
  if (site.status === "broken" || site.status === "failed") return "bad";
  if (site.status === "healing") return "warn";
  if (site.tools_count > 0 && site.verified_count >= site.tools_count) return "ok";
  return "info";
}

interface ApiNote {
  version: string;
  at: number;
  updatedAt: string;
}

export function SiteCard({ site, fresh }: { site: Site; fresh?: boolean }) {
  const { goTo } = useDashboardNav();
  const now = useNow();
  const [note, setNote] = useState<ApiNote | null>(null);
  const breakIt = useAction((id: string) => doorway.breakSite(id));
  const resetIt = useAction((id: string) => doorway.resetSite(id));

  const busy = BUSY.includes(site.status);
  const actionError = breakIt.error ?? resetIt.error;
  const pending = breakIt.pending || resetIt.pending;

  // The note stays until the site's status changes and settles (and at least NOTE_MIN_MS).
  const showNote =
    note !== null &&
    (now - note.at < NOTE_MIN_MS || site.updated_at === note.updatedAt || UNSETTLED.includes(site.status));

  const demo = async (action: typeof breakIt) => {
    breakIt.reset();
    resetIt.reset();
    setNote(null);
    const updatedAt = site.updated_at;
    const res = await action.run(site.id);
    if (res?.version) setNote({ version: res.version, at: Date.now(), updatedAt });
  };

  const frame: Tone | null =
    site.status === "broken" || site.status === "failed" ? "bad" : site.status === "healing" ? "warn" : fresh ? "ok" : null;
  const segments = site.tools_count > 0 && site.tools_count <= 16 ? site.tools_count : 16;

  return (
    <article
      className={cx("px-panel flex min-w-0 flex-col", fresh && "px-rise")}
      style={frame ? ({ "--frame": TONE_COLOR[frame] } as CSSProperties) : undefined}
    >
      <header className="flex items-start justify-between gap-3 border-b-2 border-line bg-panel-2 px-3 py-2.5">
        <div className="min-w-0">
          <Link
            href={`/sites/${site.id}`}
            className="font-pixel block truncate text-[11px] uppercase text-green hover:text-green-hi px-glow"
            title={`Open ${site.name}`}
          >
            {site.name}
          </Link>
          <a
            href={site.base_url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 flex min-w-0 items-center gap-1 text-sm text-muted hover:text-green"
            title={site.base_url}
          >
            <PixelIcon name="globe" size={10} className="shrink-0" />
            <span className="truncate">{hostOf(site.base_url)}</span>
            <span aria-hidden className="shrink-0">↗</span>
          </a>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge status={site.status} pulse={busy}>
            {site.status}
          </Badge>
          {showNote && note && (
            <Badge tone={/^v?1$/i.test(note.version) ? "info" : "warn"} pulse={false}>
              API {/^v/i.test(note.version) ? note.version : `v${note.version}`}
            </Badge>
          )}
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3">
        <p className="min-h-[2.5em] text-base leading-tight">
          {site.goal ? (
            <>
              <span className="text-green">▸ </span>
              <span className="text-text">{site.goal}</span>
            </>
          ) : (
            <span className="text-faint">No goal set: Doorway maps every capability it finds.</span>
          )}
        </p>

        <PhaseStrip status={site.status} />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-base">
              {site.tools_count > 0 ? (
                <>
                  <span style={{ color: TONE_COLOR[meterTone(site)] }}>
                    {site.verified_count}/{site.tools_count}
                  </span>{" "}
                  <span className="text-muted">verified</span>
                </>
              ) : (
                <span className="text-faint">{busy ? "finding tools…" : "no tools yet"}</span>
              )}
            </span>
            <span className="text-sm text-faint">
              {site.id} · <TimeAgo iso={site.updated_at} />
            </span>
          </div>
          <Meter value={site.verified_count} max={Math.max(1, site.tools_count)} segments={segments} tone={meterTone(site)} />
        </div>

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="danger"
            icon="broken"
            loading={breakIt.pending}
            disabled={pending && !breakIt.pending}
            onClick={() => demo(breakIt)}
            title="Flip the private API v1 → v2; tools will self-heal"
          >
            Break
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={resetIt.pending}
            disabled={pending && !resetIt.pending}
            onClick={() => demo(resetIt)}
            title="Restore API v1 and clear demo bookings"
          >
            Reset
          </Button>
          <Button size="sm" variant="ghost" icon="race" onClick={() => goTo("race", { siteId: site.id })}>
            Race
          </Button>
          <ButtonLink size="sm" variant="ghost" icon="chevron" href={`/sites/${site.id}`} className="ml-auto">
            Open
          </ButtonLink>
        </div>

        {actionError !== undefined && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-red">
            <PixelIcon name="warn" size={10} className="mt-1 shrink-0" />
            <span>{describeError(actionError)}</span>
          </p>
        )}
      </div>
    </article>
  );
}

/** Placeholder card while the list loads. */
export function SiteCardSkeleton() {
  return (
    <div className="px-panel flex flex-col gap-3 p-3" aria-hidden>
      <div className="flex justify-between gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-3 w-2/3 animate-pulse-px bg-panel-3" />
          <div className="h-3 w-1/2 animate-pulse-px bg-panel-3" />
        </div>
        <div className="h-5 w-16 animate-pulse-px bg-panel-3" />
      </div>
      <div className="h-8 animate-pulse-px bg-panel-3" />
      <div className="grid grid-cols-4 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-1.5 animate-pulse-px bg-panel-3" />
        ))}
      </div>
      <div className="h-3 animate-pulse-px bg-panel-3" />
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-7 w-16 animate-pulse-px bg-panel-3" />
        ))}
      </div>
    </div>
  );
}

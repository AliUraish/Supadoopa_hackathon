"use client";

// One website: status, discovery progress, verified-tool meter and the demo buttons
// (break the private API → watch the tools self-heal; reset; open).

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { describeError, doorway, type Site, type SiteStatus } from "@/lib/doorway";
import { TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useAction, useNow } from "@/lib/doorway/live";
import { TimeAgo } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
import { Badge, Button, ButtonLink, cx, Meter, Skeleton } from "@/components/px/ui";
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
  const tone = meterTone(site);

  return (
    <article
      className={cx("px-panel flex min-w-0 flex-col transition-colors duration-300", fresh && "animate-rise")}
      style={
        frame
          ? ({ "--frame": `color-mix(in srgb, ${TONE_COLOR[frame]} 45%, transparent)` } as CSSProperties)
          : undefined
      }
    >
      <div className="flex flex-1 flex-col gap-4 p-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/sites/${site.id}`}
              className="block truncate text-[14px] font-medium text-text hover:text-green"
              title={`Open ${site.name}`}
            >
              {site.name}
            </Link>
            <a
              href={site.base_url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-xs text-faint hover:text-green"
              title={site.base_url}
            >
              <span className="truncate">{hostOf(site.base_url)}</span>
              <Icon name="external" size={12} className="shrink-0" />
            </a>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Badge status={site.status} pulse={busy}>
              {site.status}
            </Badge>
            {showNote && note && (
              <Badge tone={/^v?1$/i.test(note.version) ? "info" : "warn"} pulse={false} className="font-mono normal-case">
                API {/^v/i.test(note.version) ? note.version : `v${note.version}`}
              </Badge>
            )}
          </div>
        </header>

        <p className="line-clamp-2 min-h-[2lh] text-[13px] leading-snug text-muted">
          {site.goal ?? <span className="text-faint">No goal set: Doorway maps every capability it finds.</span>}
        </p>

        <PhaseStrip status={site.status} />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            {site.tools_count > 0 ? (
              <span className="text-muted">
                <span className="font-mono tabular-nums text-text">
                  {site.verified_count}/{site.tools_count}
                </span>{" "}
                tools verified
              </span>
            ) : (
              <span className="text-faint">{busy ? "Finding tools" : "No tools yet"}</span>
            )}
            <span className="flex min-w-0 items-center gap-1 text-faint">
              <Icon name="clock" size={12} className="shrink-0" />
              <TimeAgo iso={site.updated_at} className="truncate" />
            </span>
          </div>
          <Meter value={site.verified_count} max={Math.max(1, site.tools_count)} tone={tone} />
        </div>

        {actionError !== undefined && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-red">
            <Icon name="warn" size={13} className="mt-px shrink-0" />
            <span>{describeError(actionError)}</span>
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2.5">
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
        <ButtonLink size="sm" variant="ghost" href={`/sites/${site.id}`} className="ml-auto">
          Open
          <Icon name="chevron" size={13} />
        </ButtonLink>
      </footer>
    </article>
  );
}

/** Placeholder card while the list loads. */
export function SiteCardSkeleton() {
  return (
    <div className="px-panel flex flex-col" aria-hidden>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex justify-between gap-3">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-8" />
        <div className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-3" />
          ))}
        </div>
        <Skeleton className="h-1.5" />
      </div>
      <div className="flex gap-2 border-t border-line px-3 py-2.5">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-7 w-16" />
        ))}
      </div>
    </div>
  );
}

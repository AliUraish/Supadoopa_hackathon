"use client";

// Shared patterns: the fleet's memory. A pattern learned on one site (e.g. slot_booking) is
// tried first on the next site, so every booking site ends up with the same tool interface.

import type { CSSProperties } from "react";
import type { Pattern } from "@/lib/doorway";
import { fmtInt } from "@/lib/doorway/format";
import type { LiveResult } from "@/lib/doorway/live";
import { TimeAgo } from "@/components/px/client";
import { PixelIcon } from "@/components/px/icons";
import { Empty, ErrorBanner, Loading, Panel } from "@/components/px/ui";
import { PanelNote, SandboxName, SiteChip, SiteLink, StaleNote } from "./shared";

const CARD_FRAME = { "--frame": "color-mix(in srgb, var(--color-violet) 45%, var(--color-line))" } as CSSProperties;

export function SharedPatterns({ result, className }: { result: LiveResult<Pattern[]>; className?: string }) {
  const { data, error, loading } = result;
  const sorted = [...(data ?? [])].sort(
    (a, b) =>
      (b.used_by?.length ?? 0) - (a.used_by?.length ?? 0) || b.success_count - a.success_count || a.id - b.id,
  );
  return (
    <Panel
      title="Shared patterns"
      icon="pattern"
      className={className}
      bodyClassName="max-h-[640px] overflow-y-auto"
      actions={data ? <span className="text-base text-muted">{fmtInt(data.length)} learned</span> : undefined}
    >
      <PanelNote icon="pattern">
        A pattern learned on one site is tried first on the next — same tool interface everywhere.
      </PanelNote>
      {loading ? (
        <Loading label="Recalling" />
      ) : !data ? (
        <ErrorBanner error={error} />
      ) : !data.length ? (
        <Empty
          icon="pattern"
          title="Nothing learned yet"
          hint="When a sandbox compiles a tool that generalises, it publishes the pattern here for every other sandbox."
        />
      ) : (
        <>
          <StaleNote error={error} className="mb-2" />
          <ul className="flex flex-col gap-3">
            {sorted.map((p) => (
              <PatternCard key={p.id} pattern={p} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function PatternCard({ pattern: p }: { pattern: Pattern }) {
  const reusedOn = [...new Set(p.used_by ?? [])].filter((id) => id !== p.source_site_id);
  const sites = reusedOn.length + (p.source_site_id ? 1 : 0);
  return (
    <li className="px-inset flex flex-col gap-1.5 p-2.5" style={CARD_FRAME}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-pixel flex min-w-0 items-center gap-1.5 text-[10px] text-violet">
          <PixelIcon name="pattern" size={12} className="shrink-0" />
          <span className="truncate">{p.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-lg text-green" title="Successful runs through this pattern">
          <PixelIcon name="verify" size={10} />
          {fmtInt(p.success_count)}
        </span>
      </div>
      {p.description && <p className="text-lg leading-tight text-text">{p.description}</p>}
      <p className="text-base leading-tight text-muted">
        learned by <SandboxName id={p.created_by} />
        {p.source_site_id && (
          <>
            {" "}
            on <SiteLink id={p.source_site_id} />
          </>
        )}
        <span className="text-faint"> · </span>
        <TimeAgo iso={p.created_at} className="text-faint" />
      </p>
      <div className="font-pixel text-[8px] uppercase text-faint">
        used by <span className="text-violet">{sites}</span> site{sites === 1 ? "" : "s"}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {p.source_site_id && (
          <>
            <SiteChip id={p.source_site_id} origin />
            <span className="text-faint" aria-hidden>
              →
            </span>
          </>
        )}
        {reusedOn.length ? (
          reusedOn.map((id) => <SiteChip key={id} id={id} />)
        ) : (
          <span className="text-base text-faint">not reused yet</span>
        )}
      </div>
    </li>
  );
}

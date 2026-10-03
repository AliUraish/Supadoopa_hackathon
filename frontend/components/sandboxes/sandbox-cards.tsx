"use client";

// Sandbox cards: one per worker — status, current job, heartbeat age, jobs done, uptime.

import type { CSSProperties } from "react";
import type { Job, Sandbox, SandboxStatus } from "@/lib/doorway";
import { fmtInt, timeAgo, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useNow, type LiveResult } from "@/lib/doorway/live";
import { PixelIcon } from "@/components/px/icons";
import { PALETTE, Sprite } from "@/components/px/sprite";
import { Badge, cx, Empty, ErrorBanner, Skeleton, StatusDot } from "@/components/px/ui";
import { ageMs, byNaturalId, fmtDuration, jobKindStyle, SandboxName, SiteLink, StaleNote } from "./shared";

const GRID = "grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]";

// Screen glyphs + LED recoloured per status (the sprite's G = screen text, A = LED).
const SPRITE_PALETTE: Record<SandboxStatus, Record<string, string>> = {
  idle: { ...PALETTE, G: PALETTE.g, A: PALETTE.G },
  busy: { ...PALETTE, G: PALETTE.H, A: PALETTE.A },
  offline: { ...PALETTE, G: PALETTE.s, A: PALETTE.R, d: PALETTE.K },
};

const BEAT_WARN_MS = 10_000;
const BEAT_DEAD_MS = 30_000;

function heartbeatTone(ms: number | null, status: SandboxStatus): Tone {
  if (status === "offline") return "bad";
  if (ms === null) return "muted";
  if (ms > BEAT_DEAD_MS) return "bad";
  if (ms > BEAT_WARN_MS) return "warn";
  return "ok";
}

export function SandboxGrid({ result, jobs }: { result: LiveResult<Sandbox[]>; jobs: Job[] | undefined }) {
  const { data, error, loading } = result;

  if (loading) {
    return (
      <div className={GRID}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[138px]" />
        ))}
      </div>
    );
  }
  if (!data) return <ErrorBanner error={error} />;
  if (!data.length) {
    return (
      <div className="px-panel">
        <Empty
          icon="sandbox"
          title="No sandboxes registered"
          hint="Workers appear here when they boot on Supabase Compute and send their first heartbeat."
        />
      </div>
    );
  }

  const jobsById = new Map((jobs ?? []).map((j) => [j.id, j]));
  const sorted = [...data].sort((a, b) => byNaturalId(a.id, b.id));
  return (
    <div className="flex flex-col gap-2">
      <StaleNote error={error} />
      <ul className={GRID}>
        {sorted.map((s) => (
          <SandboxCard
            key={s.id}
            sandbox={s}
            job={typeof s.current_job_id === "number" ? jobsById.get(s.current_job_id) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

function SandboxCard({ sandbox: s, job }: { sandbox: Sandbox; job?: Job }) {
  const now = useNow();
  const busy = s.status === "busy";
  const offline = s.status === "offline";
  const beat = ageMs(s.last_heartbeat, now);
  const beatTone = heartbeatTone(beat, s.status);
  const frame = busy
    ? "var(--color-blue)"
    : offline
      ? "color-mix(in srgb, var(--color-red) 45%, var(--color-line-2))"
      : undefined;

  return (
    <li
      className="px-panel flex min-w-0 flex-col"
      style={frame ? ({ "--frame": frame } as CSSProperties) : undefined}
    >
      <div className="flex items-start gap-3 p-3">
        <div className={cx("flex shrink-0 flex-col items-center gap-1.5", offline && "opacity-50")}>
          <Sprite name="sandbox" palette={SPRITE_PALETTE[s.status] ?? PALETTE} scale={3} title={`${s.id}: ${s.status}`} />
          <span aria-hidden className={cx("h-[2px] w-full", busy && "px-wire")} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-pixel flex min-w-0 items-center gap-2 text-[11px]">
              <StatusDot status={s.status} size={8} />
              <SandboxName id={s.id} className="truncate" />
            </h3>
            <Badge status={s.status} />
          </div>
          <CurrentJob sandbox={s} job={job} now={now} />
        </div>
      </div>
      <dl className="mt-auto grid grid-cols-3 border-t-2 border-line bg-panel-2">
        <Stat
          label="Heartbeat"
          value={s.last_heartbeat ? timeAgo(s.last_heartbeat, now) : "never"}
          color={TONE_COLOR[beatTone]}
          title={s.last_heartbeat ?? undefined}
        />
        <Stat label="Jobs done" value={fmtInt(s.jobs_done)} />
        <Stat
          label="Uptime"
          value={offline ? "—" : fmtDuration(ageMs(s.started_at, now))}
          title={s.started_at ? `Started ${s.started_at}` : undefined}
        />
      </dl>
    </li>
  );
}

function CurrentJob({ sandbox: s, job, now }: { sandbox: Sandbox; job?: Job; now: number }) {
  if (s.status === "offline") {
    return <p className="mt-1.5 text-base leading-tight text-red">Offline · not claiming jobs</p>;
  }
  if (s.status !== "busy") {
    return <p className="mt-1.5 text-base leading-tight text-faint">Idle · watching the queue</p>;
  }
  const kind = s.job_kind ?? job?.kind ?? null;
  const style = jobKindStyle(kind);
  const color = TONE_COLOR[style.tone];
  const site = s.site_id ?? job?.site_id ?? null;
  const elapsed = ageMs(job?.started_at, now);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-lg leading-tight">
      <span className="flex items-center gap-1.5" style={{ color }}>
        <PixelIcon name={style.icon} size={12} />
        <span className="font-pixel text-[9px] uppercase">{kind ?? "job"}</span>
      </span>
      {typeof s.current_job_id === "number" && <span className="text-text">#{s.current_job_id}</span>}
      {site && (
        <>
          <span className="text-faint">on</span>
          <SiteLink id={site} />
        </>
      )}
      {elapsed !== null && <span className="tabular-nums text-faint">· {fmtDuration(elapsed)}</span>}
    </div>
  );
}

function Stat({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-r-2 border-line px-2.5 py-1.5 last:border-r-0" title={title}>
      <dt className="font-pixel truncate text-[8px] uppercase text-faint">{label}</dt>
      <dd className="truncate text-lg leading-none tabular-nums" style={{ color: color ?? "var(--color-text)" }}>
        {value}
      </dd>
    </div>
  );
}

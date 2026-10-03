"use client";

// Job queue kanban: QUEUED → RUNNING → DONE. Every sandbox claims from this one Postgres
// queue; chips move column to column as jobs are claimed and finished.

import type { CSSProperties, ReactNode } from "react";
import type { Job } from "@/lib/doorway";
import { clockTime, fmtInt, fmtMs, timeAgo, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useNow, type LiveResult } from "@/lib/doorway/live";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { cx, Empty, ErrorBanner, Loading, Panel } from "@/components/px/ui";
import { ageMs, fmtDuration, jobKindStyle, PanelNote, SandboxName, SiteLink, spanMs, StaleNote, timestamp } from "./shared";

const DONE_CAP = 12;

export function JobQueue({ result, className }: { result: LiveResult<Job[]>; className?: string }) {
  const { data, error, loading } = result;
  const now = useNow();
  const jobs = data ?? [];

  const queued = jobs.filter((j) => j.status === "queued").sort((a, b) => a.id - b.id);
  const running = jobs
    .filter((j) => j.status === "running")
    .sort((a, b) => timestamp(a.started_at) - timestamp(b.started_at) || a.id - b.id);
  const finished = jobs
    .filter((j) => j.status === "done" || j.status === "failed")
    .sort((a, b) => timestamp(b.finished_at) - timestamp(a.finished_at) || b.id - a.id);
  const failed = finished.filter((j) => j.status === "failed").length;

  return (
    <Panel
      title="Job queue"
      icon="database"
      className={className}
      bodyClassName="max-h-[640px] overflow-y-auto"
      actions={
        data && (
          <span className="text-base text-muted">
            {fmtInt(queued.length)} queued · {fmtInt(running.length)} running
          </span>
        )
      }
    >
      <PanelNote icon="verify">
        <span className="text-green">verify</span> always runs on a different sandbox than the one that compiled the
        tool.
      </PanelNote>
      {loading ? (
        <Loading label="Reading queue" />
      ) : !data ? (
        <ErrorBanner error={error} />
      ) : !jobs.length ? (
        <Empty icon="database" title="No jobs yet" hint="Add a site, break one, or start a race and jobs land here." />
      ) : (
        <>
          <StaleNote error={error} className="mb-2" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Column title="Queued" icon="clock" tone="muted" count={queued.length} empty="Queue empty">
              {queued.map((j) => (
                <JobChip key={j.id} job={j} now={now} />
              ))}
            </Column>
            <Column title="Running" icon="execute" tone="info" count={running.length} empty="Nothing running">
              {running.map((j) => (
                <JobChip key={j.id} job={j} now={now} />
              ))}
            </Column>
            <Column
              title="Done"
              icon="verify"
              tone="ok"
              count={finished.length}
              sub={failed ? <span className="text-red">{failed} failed</span> : undefined}
              empty="Nothing finished yet"
            >
              {finished.slice(0, DONE_CAP).map((j) => (
                <JobChip key={j.id} job={j} now={now} />
              ))}
              {finished.length > DONE_CAP && (
                <li className="py-1 text-center text-sm text-faint">+{fmtInt(finished.length - DONE_CAP)} earlier</li>
              )}
            </Column>
          </div>
        </>
      )}
    </Panel>
  );
}

function Column({
  title,
  icon,
  tone,
  count,
  sub,
  empty,
  children,
}: {
  title: string;
  icon: IconName;
  tone: Tone;
  count: number;
  sub?: ReactNode;
  empty: string;
  children: ReactNode;
}) {
  const color = TONE_COLOR[tone];
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <header
        className="flex items-center justify-between gap-2 border-b-2 pb-1"
        style={{ borderColor: `color-mix(in srgb, ${color} 55%, transparent)` }}
      >
        <h3 className="font-pixel flex items-center gap-1.5 text-[9px] uppercase" style={{ color }}>
          <PixelIcon name={icon} size={10} />
          {title}
        </h3>
        <span className="flex items-baseline gap-2 text-base">
          {sub}
          <span className="font-pixel text-[10px]" style={{ color }}>
            {count}
          </span>
        </span>
      </header>
      {count ? (
        <ol className="flex flex-col gap-2">{children}</ol>
      ) : (
        <p className="px-inset px-2 py-3 text-center text-base text-faint">{empty}</p>
      )}
    </section>
  );
}

function timing(job: Job, now: number): string {
  if (job.status === "queued") return `wait ${fmtDuration(ageMs(job.created_at, now))}`;
  if (job.status === "running") return fmtDuration(ageMs(job.started_at ?? job.created_at, now));
  const took = spanMs(job.started_at, job.finished_at);
  return took !== null ? fmtMs(took) : timeAgo(job.finished_at, now);
}

function JobChip({ job, now }: { job: Job; now: number }) {
  const style = jobKindStyle(job.kind);
  const failed = job.status === "failed";
  const running = job.status === "running";
  const color = failed ? TONE_COLOR.bad : TONE_COLOR[style.tone];
  const frame = failed ? "var(--color-red)" : running ? "var(--color-blue)" : undefined;
  const title = [
    `created ${clockTime(job.created_at)}`,
    job.started_at && `started ${clockTime(job.started_at)}`,
    job.finished_at && `finished ${clockTime(job.finished_at)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      className="px-rise px-inset relative flex min-w-0 flex-col gap-0.5 py-1.5 pl-3 pr-2"
      style={frame ? ({ "--frame": frame } as CSSProperties) : undefined}
      title={title}
    >
      <span aria-hidden className={cx("absolute inset-y-0 left-0 w-[3px]", running && "animate-pulse-px")} style={{ background: color }} />
      {running && (
        <span
          aria-hidden
          className="animate-pulse-px pointer-events-none absolute inset-0"
          style={{ boxShadow: "inset 0 0 0 2px var(--color-blue)" }}
        />
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0" style={{ color }}>
          <PixelIcon name={style.icon} size={12} />
        </span>
        <span className="font-pixel text-[8px] uppercase" style={{ color }}>
          {job.kind}
        </span>
        <span className="text-base text-text">#{job.id}</span>
        <span className={cx("ml-auto shrink-0 text-base tabular-nums", failed ? "text-red" : "text-muted")}>
          {failed ? "failed" : timing(job, now)}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-base leading-tight">
        {job.site_id ? <SiteLink id={job.site_id} /> : <span className="text-faint">fleet</span>}
        <span className="text-faint">·</span>
        <SandboxName id={job.claimed_by} fallback="unclaimed" />
        {job.attempts > 0 && (
          <span className={job.attempts > 1 ? "text-amber" : "text-faint"}>· try {job.attempts}</span>
        )}
        {failed && <span className="text-faint">· {timing(job, now)}</span>}
      </div>
      {failed && job.error && <p className="break-words text-base leading-tight text-red">{job.error}</p>}
    </li>
  );
}

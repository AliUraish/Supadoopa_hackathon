"use client";

// Right of the workspace: the Supabase Compute room. One workstation per sandbox (its screen
// shows what it is doing), speech bubbles from the message board, and below the floor the
// shared memory: the Postgres brain with learned patterns and the job queue.

import type { CSSProperties, ReactNode } from "react";
import type { Job, Pattern, Sandbox } from "@/lib/doorway";
import { statusTone, timeAgo, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useNow } from "@/lib/doorway/live";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { cx, Empty, ErrorBanner, Skeleton, StatusDot } from "@/components/px/ui";
import { ageMs, truncate } from "./flow";
import {
  BrowserScreen,
  CodeLines,
  DeadScreen,
  IdleScreen,
  RoomLabel,
  ScreenSprite,
  SpeechBubble,
  StaticSprite,
} from "./scene-bits";
import { COMPUTE, COMPUTE_PALETTE, COMPUTE_SCREEN } from "./sprites";
import styles from "./workspace.module.css";

export interface SandboxBubble {
  key: number;
  icon: IconName;
  tone: Tone;
  text: string;
}

const BROWSER_JOBS = new Set(["discover", "race", "heal"]);

function HeartbeatAge({ iso }: { iso: string | null }) {
  const now = useNow();
  const age = ageMs(iso, now);
  const stale = age !== null && age > 10_000;
  return (
    <span className={stale ? "text-amber" : "text-faint"} suppressHydrationWarning>
      ♥ {iso && now ? timeAgo(iso, now) : "—"}
    </span>
  );
}

function Workstation({ sandbox, bubble }: { sandbox: Sandbox; bubble?: SandboxBubble }) {
  const { status } = sandbox;
  const busy = status === "busy";
  const offline = status === "offline";
  return (
    <div data-anchor={`sb:${sandbox.id}`} className="relative flex min-w-0 flex-col items-center gap-1 text-center">
      {bubble && (
        <SpeechBubble key={bubble.key} tone={bubble.tone} icon={bubble.icon}>
          {bubble.text}
        </SpeechBubble>
      )}
      <ScreenSprite
        map={COMPUTE}
        scale={5}
        screen={COMPUTE_SCREEN}
        palette={COMPUTE_PALETTE[status] ?? COMPUTE_PALETTE.idle}
        className={cx(offline && "opacity-50 grayscale", busy && styles.hum)}
      >
        {offline ? (
          <DeadScreen />
        ) : busy ? (
          sandbox.job_kind && BROWSER_JOBS.has(sandbox.job_kind) ? (
            <BrowserScreen />
          ) : (
            <CodeLines fast={sandbox.job_kind === "verify"} />
          )
        ) : (
          <IdleScreen label="idle" />
        )}
      </ScreenSprite>
      <div className="font-pixel mt-1 max-w-full truncate text-[9px] uppercase text-text">{sandbox.id}</div>
      <div className="flex items-center gap-1.5 text-sm" style={{ color: TONE_COLOR[statusTone(status)] }}>
        <StatusDot status={status} size={8} />
        {status}
      </div>
      <div className="min-h-[2.4em] max-w-full text-sm leading-tight text-muted">
        {busy ? (
          <>
            <span className="text-blue">{sandbox.job_kind ?? "job"}</span>
            {sandbox.site_id && <span className="block truncate">{sandbox.site_id}</span>}
          </>
        ) : offline ? (
          <span className="text-red">no heartbeat</span>
        ) : (
          "waiting for jobs"
        )}
      </div>
      <div className="flex flex-wrap justify-center gap-x-2 text-sm text-faint">
        <span>{sandbox.jobs_done} jobs</span>
        <HeartbeatAge iso={sandbox.last_heartbeat} />
      </div>
    </div>
  );
}

function PatternCard({ pattern, flashKey }: { pattern: Pattern; flashKey: number | null }) {
  return (
    <li
      className="px-frame relative flex min-w-[150px] flex-1 flex-col gap-0.5 bg-bg-2 px-2.5 py-2"
      style={{ "--frame": "var(--color-violet)" } as CSSProperties}
      title={pattern.description ?? undefined}
    >
      {flashKey !== null && (
        <span
          key={flashKey}
          className={cx("pointer-events-none absolute inset-0", styles.fade)}
          style={{ background: "color-mix(in srgb, var(--color-violet) 35%, transparent)" }}
        />
      )}
      <span className="font-pixel flex items-center gap-1.5 text-[8px] uppercase text-violet">
        <PixelIcon name="pattern" size={10} />
        <span className="truncate">{pattern.name}</span>
      </span>
      <span className="text-sm leading-tight text-muted">
        used by {pattern.used_by.length} site{pattern.used_by.length === 1 ? "" : "s"} · ✓{pattern.success_count}
      </span>
      {pattern.used_by.length > 0 && (
        <span className="truncate text-sm leading-tight text-faint">{truncate(pattern.used_by.join(", "), 48)}</span>
      )}
    </li>
  );
}

function QueueCount({ label, value, tone, pulse }: { label: string; value: number | null; tone: Tone; pulse?: boolean }) {
  const color = TONE_COLOR[tone];
  const blocks = Math.min(value ?? 0, 10);
  return (
    <div className="px-inset flex min-w-0 flex-1 flex-col gap-1 px-2.5 py-2">
      <span className="font-pixel text-[8px] uppercase text-faint">{label}</span>
      <span className={cx("font-pixel text-[16px] leading-none", pulse && "animate-pulse-px")} style={{ color }}>
        {value ?? "—"}
      </span>
      <span className="flex h-2 gap-[2px]" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="h-full flex-1" style={{ background: i < blocks ? color : "var(--color-line)" }} />
        ))}
      </span>
    </div>
  );
}

export function ComputeRoom({
  sandboxes,
  sandboxesLoading,
  sandboxesError,
  bubbles,
  patterns,
  patternsLoading,
  patternsError,
  patternFlash,
  jobs,
  jobsError,
}: {
  sandboxes: Sandbox[] | undefined;
  sandboxesLoading: boolean;
  sandboxesError: unknown;
  bubbles: Record<string, SandboxBubble>;
  patterns: Pattern[] | undefined;
  patternsLoading: boolean;
  patternsError: unknown;
  patternFlash: { patternId: number; key: number } | null;
  jobs: Job[] | undefined;
  jobsError: unknown;
}) {
  const list = sandboxes ?? [];
  const online = list.filter((s) => s.status !== "offline").length;
  const count = (status: Job["status"]) => (jobs ? jobs.filter((j) => j.status === status).length : null);
  const doneTotal = list.length ? list.reduce((n, s) => n + s.jobs_done, 0) : count("done");

  let floorContent: ReactNode;
  if (sandboxesLoading) {
    floorContent = Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[170px]" />);
  } else if (!list.length) {
    floorContent = (
      <div className="col-span-full">
        {sandboxesError ? (
          <ErrorBanner error={sandboxesError} />
        ) : (
          <Empty
            icon="sandbox"
            title="No sandboxes online"
            hint="Workers attach from Supabase Compute and claim jobs from the shared queue in Postgres."
          />
        )}
      </div>
    );
  } else {
    floorContent = list.map((s) => <Workstation key={s.id} sandbox={s} bubble={bubbles[s.id]} />);
  }

  return (
    <section data-anchor="room" className={cx(styles.wall, "relative flex flex-col")}>
      <div className="px-3 pt-2">
        <RoomLabel
          icon="bolt"
          title="Supabase Compute"
          sub={
            sandboxesLoading
              ? "booting sandboxes…"
              : `${online}/${list.length} sandboxes online · isolated Chromium workers`
          }
        />
      </div>
      <div data-anchor="ceiling" className={cx(styles.tray, "mx-2 mt-2 h-[6px]")} />
      <div
        data-measure
        className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-x-3 gap-y-16 px-4 pb-4 pt-[68px]"
      >
        {floorContent}
      </div>
      {sandboxesError && list.length > 0 ? <ErrorBanner error={sandboxesError} className="mx-3 mb-3" /> : null}
      <div data-anchor="floor" className={cx(styles.floor, "h-[10px]")} />

      <div data-measure className="flex flex-col gap-4 p-4 pt-6 sm:flex-row sm:items-start">
        <div className="flex shrink-0 flex-col items-center gap-1 text-center">
          <div data-anchor="db" className={styles.doorGlow}>
            <StaticSprite name="database" scale={5} title="Postgres" />
          </div>
          <span className="font-pixel mt-1 text-[9px] uppercase text-green">Postgres</span>
          <span className="text-sm text-muted">shared memory</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <div className="font-pixel mb-2 flex items-center gap-2 text-[9px] uppercase text-muted">
              <PixelIcon name="pattern" size={12} /> Learned patterns
            </div>
            {patternsLoading ? (
              <Skeleton className="h-14" />
            ) : patterns?.length ? (
              <ul className="flex flex-wrap gap-3">
                {patterns.map((p) => (
                  <PatternCard key={p.id} pattern={p} flashKey={patternFlash?.patternId === p.id ? patternFlash.key : null} />
                ))}
              </ul>
            ) : patternsError ? (
              <ErrorBanner error={patternsError} />
            ) : (
              <p className="text-base text-faint">No patterns yet: the first site a sandbox learns becomes one.</p>
            )}
          </div>
          <div>
            <div className="font-pixel mb-2 flex items-center gap-2 text-[9px] uppercase text-muted">
              <PixelIcon name="compile" size={12} /> Job queue
            </div>
            {jobsError && !jobs ? (
              <ErrorBanner error={jobsError} />
            ) : (
              <div className="flex gap-3">
                <QueueCount label="queued" value={count("queued")} tone="muted" />
                <QueueCount label="running" value={count("running")} tone="info" pulse={Boolean(count("running"))} />
                <QueueCount label="done" value={doneTotal} tone="ok" />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

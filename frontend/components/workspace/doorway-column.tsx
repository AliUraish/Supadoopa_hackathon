"use client";

// Centre of the workspace: the Doorway broker (a glowing door) above the 10-stage pipeline.
// The stage of the latest event glows in its tone; stages hit since then fade out over ~2 s.

import type { CSSProperties } from "react";
import type { DoorwayEvent } from "@/lib/doorway";
import { eventStyle, PIPELINE, STAGE_LABEL, TONE_COLOR, type Stage, type Tone } from "@/lib/doorway/format";
import { TimeAgo } from "@/components/px/client";
import { PixelIcon } from "@/components/px/icons";
import { cx, Empty, ErrorBanner, Loading } from "@/components/px/ui";
import { STAGE_ICON } from "./flow";
import { RoomLabel, StaticSprite } from "./scene-bits";
import styles from "./workspace.module.css";

export interface StageHit {
  key: number;
  tone: Tone;
}

export function DoorScene({ flashKey, flashTone }: { flashKey: number | null; flashTone: Tone }) {
  const color = TONE_COLOR[flashTone];
  return (
    <div className={cx(styles.wall, "relative h-[210px]")}>
      <div className="absolute inset-x-3 top-2">
        <RoomLabel icon="door" title="Doorway" sub="the broker · lookup → tool → pay" />
      </div>
      <div className={cx(styles.floor, "absolute inset-x-0 bottom-0 h-[10px]")} />
      <div className="absolute bottom-[10px] left-1/2 -translate-x-1/2">
        <div data-anchor="door" className={cx("relative", styles.doorGlow)}>
          {flashKey !== null && (
            <span
              key={flashKey}
              className={cx("absolute -inset-4", styles.flash)}
              style={{ background: `radial-gradient(closest-side, ${color}, transparent)` }}
            />
          )}
          <StaticSprite name="door" scale={7} title="Doorway" />
        </div>
      </div>
    </div>
  );
}

export function Pipeline({
  current,
  hits,
  counts,
}: {
  current: { stage: Stage; tone: Tone } | null;
  hits: Partial<Record<Stage, StageHit>>;
  counts: Partial<Record<Stage, number>>;
}) {
  return (
    <ol className="flex flex-col" aria-label="Doorway pipeline">
      {PIPELINE.map((stage, i) => {
        const lit = current?.stage === stage;
        const color = lit ? TONE_COLOR[current.tone] : null;
        const hit = hits[stage];
        return (
          <li key={stage} className="flex flex-col items-center">
            {i > 0 && <span className="h-2.5 w-[2px]" style={{ background: color ?? "var(--color-line-2)" }} />}
            <div
              className={cx("px-frame relative flex w-full items-center gap-2.5 px-2.5 py-1.5", lit && "px-glow")}
              aria-current={lit ? "step" : undefined}
              style={
                {
                  "--frame": color ?? "var(--color-line-2)",
                  background: color ? `color-mix(in srgb, ${color} 18%, var(--color-panel))` : "var(--color-bg-2)",
                  color: color ?? "var(--color-muted)",
                  boxShadow: color
                    ? `0 -2px 0 0 ${color}, 0 2px 0 0 ${color}, -2px 0 0 0 ${color}, 2px 0 0 0 ${color}, 0 0 16px ${color}`
                    : undefined,
                } as CSSProperties
              }
            >
              {hit && !lit && (
                <span
                  key={hit.key}
                  className={cx("pointer-events-none absolute inset-0", styles.fade)}
                  style={{
                    background: `color-mix(in srgb, ${TONE_COLOR[hit.tone]} 28%, transparent)`,
                    boxShadow: `0 0 12px ${TONE_COLOR[hit.tone]}`,
                  }}
                />
              )}
              <span className="font-pixel w-4 text-[8px] text-faint">{i + 1}</span>
              <PixelIcon name={STAGE_ICON[stage]} size={16} />
              <span className="font-pixel text-[10px] uppercase">{STAGE_LABEL[stage]}</span>
              {lit && <span className="animate-blink font-pixel text-[10px]">◀</span>}
              <span className="ml-auto text-sm tabular-nums text-faint">{counts[stage] ? `×${counts[stage]}` : ""}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** "verify.pass · book_appointment passed (api, 84 ms)" under the pipeline. */
export function CurrentEvent({
  event,
  loading,
  error,
}: {
  event: DoorwayEvent | undefined;
  loading: boolean;
  error: unknown;
}) {
  if (loading) return <Loading label="Tuning in" className="py-4" />;
  if (!event) {
    return error ? (
      <ErrorBanner error={error} />
    ) : (
      <Empty icon="request" title="Waiting for a request" hint="Ask your agent something and watch it flow." className="py-4" />
    );
  }
  const style = eventStyle(event.kind);
  const color = TONE_COLOR[style.tone];
  return (
    <div className="px-inset flex flex-col gap-1 p-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span style={{ color }}>
          <PixelIcon name={style.icon} size={14} />
        </span>
        <span className="font-pixel text-[9px] uppercase" style={{ color }}>
          {event.kind}
        </span>
        <TimeAgo iso={event.created_at} className="ml-auto text-sm text-faint" />
      </div>
      <p className="break-words text-lg leading-tight text-text">{event.message}</p>
      {(event.sandbox_id || event.site_id) && (
        <div className="flex flex-wrap gap-x-2 text-sm">
          {event.sandbox_id && <span className="text-violet">{event.sandbox_id}</span>}
          {event.site_id && <span className="text-muted">{event.site_id}</span>}
        </div>
      )}
      {error ? <ErrorBanner error={error} className="mt-1" /> : null}
    </div>
  );
}

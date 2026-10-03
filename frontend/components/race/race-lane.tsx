"use client";

// One side of the race: sprite, live stopwatch, step + token counters and the step log.
// The browser lane also shows what the agent "sees" (its latest screenshot).

import { useEffect, useRef, type CSSProperties } from "react";
import type { RaceLogEntry } from "@/lib/doorway";
import { fmtInt, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { PixelIcon } from "@/components/px/icons";
import { Sprite } from "@/components/px/sprite";
import { Badge, cx, Meter } from "@/components/px/ui";
import { ActionIcon, actionStyle, LANE_META } from "./race-art";
import { LaneTimer, useTween } from "./race-clock";
import type { Lane, LaneId } from "./race-model";

export interface Zoom {
  src: string;
  caption: string;
}

export function LaneColumn({
  id,
  lane,
  tokenScale,
  active,
  winner,
  onZoom,
}: {
  id: LaneId;
  lane: Lane;
  tokenScale: number;
  active: boolean;
  winner: boolean;
  onZoom: (zoom: Zoom) => void;
}) {
  const meta = LANE_META[id];
  const running = lane.status === "running";
  const finished = lane.status === "done" || lane.status === "failed";
  const latestShot = [...lane.log].reverse().find((e) => e.screenshot_url);

  return (
    <section
      className="px-panel flex min-w-0 flex-col"
      style={{ "--frame": winner ? "var(--color-gold)" : meta.color } as CSSProperties}
      aria-label={meta.title}
    >
      <header className="flex items-center gap-3 border-b-2 border-line bg-panel-2 px-3 py-2.5">
        <Sprite map={meta.sprite} scale={3} className={cx("shrink-0", running && "race-bob")} />
        <div className="min-w-0 flex-1">
          <h3 className="font-pixel truncate text-[11px] uppercase" style={{ color: meta.color }}>
            {meta.title}
          </h3>
          <p className="truncate text-sm text-muted">{meta.tagline}</p>
        </div>
        {winner ? (
          <Badge tone="gold" className="race-pop">
            Winner
          </Badge>
        ) : (
          <Badge status={lane.status}>{lane.status}</Badge>
        )}
      </header>

      <div className="grid grid-cols-[1fr_auto] items-end gap-x-4 gap-y-2 border-b-2 border-line px-3 py-3">
        <div>
          <div className="font-pixel mb-1 text-[8px] uppercase text-faint">Time</div>
          <LaneTimer status={lane.status} ms={lane.ms} active={active} color={meta.color} />
        </div>
        <div className="text-right">
          <div className="font-pixel mb-1 text-[8px] uppercase text-faint">{finished ? "Steps" : "Step"}</div>
          <div className="font-pixel text-[18px] leading-none text-text tabular-nums">
            {finished ? lane.steps : lane.current}
            {!finished && lane.total !== null && <span className="text-muted">/{lane.total}</span>}
          </div>
        </div>
        <LaneTokens tokens={lane.tokens} scale={tokenScale} tone={meta.tone} broker={id === "broker"} />
      </div>

      {id === "browser" && (
        <AgentView shot={latestShot} running={running} onZoom={onZoom} />
      )}

      <LaneLog id={id} lane={lane} onZoom={onZoom} />

      {lane.error && (
        <p className="border-t-2 border-line px-3 py-2 text-base text-red">
          <PixelIcon name="warn" size={12} className="mr-2 inline" />
          {lane.error}
        </p>
      )}
      <footer className="font-pixel border-t-2 border-line bg-bg-2 px-3 py-2 text-[8px] uppercase leading-relaxed text-muted">
        {meta.footer}
      </footer>
    </section>
  );
}

function LaneTokens({ tokens, scale, tone, broker }: { tokens: number; scale: number; tone: Tone; broker: boolean }) {
  const shown = useTween(tokens);
  return (
    <div className="col-span-2">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="font-pixel text-[8px] uppercase text-faint">LLM tokens</span>
        <span className="font-pixel text-[14px] tabular-nums" style={{ color: TONE_COLOR[broker ? "ok" : tone] }}>
          {fmtInt(shown)}
          {broker && <span className="ml-2 text-[8px] text-muted">fixed</span>}
        </span>
      </div>
      <Meter value={shown} max={scale} tone={tone} segments={24} />
    </div>
  );
}

/** The browser agent's viewport: its latest screenshot, framed like a tiny browser. */
function AgentView({
  shot,
  running,
  onZoom,
}: {
  shot: RaceLogEntry | undefined;
  running: boolean;
  onZoom: (zoom: Zoom) => void;
}) {
  return (
    <div className="border-b-2 border-line px-3 py-3">
      <div className="px-inset overflow-hidden">
        <div className="flex items-center gap-1.5 border-b-2 border-line bg-panel-3 px-2 py-1">
          <span className="size-2 bg-red" />
          <span className="size-2 bg-amber" />
          <span className="size-2 bg-green" />
          <span className="font-pixel ml-2 truncate text-[7px] uppercase text-faint">
            {shot ? `agent view · step ${shot.step}` : "agent view"}
          </span>
          {running && <span className="animate-blink ml-auto size-2 bg-red" title="recording" />}
        </div>
        {shot?.screenshot_url ? (
          <button
            type="button"
            className="block w-full cursor-zoom-in"
            onClick={() => onZoom({ src: shot.screenshot_url ?? "", caption: `Step ${shot.step} · ${shot.detail}` })}
            aria-label={`Enlarge screenshot of step ${shot.step}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={shot.screenshot_url}
              alt={`Browser agent screenshot, step ${shot.step}`}
              className="pixelated block h-36 w-full object-cover object-top"
            />
          </button>
        ) : (
          <div className="flex h-36 items-center justify-center text-base text-faint">
            {running ? "waiting for the first screenshot…" : "no screenshot yet"}
          </div>
        )}
      </div>
    </div>
  );
}

function splitDetail(detail: string): [string, string | null] {
  const m = detail.split(/\s*(?:→|->)\s*/);
  return m.length > 1 ? [m[0], m.slice(1).join(" → ")] : [detail, null];
}

function LaneLog({ id, lane, onZoom }: { id: LaneId; lane: Lane; onZoom: (zoom: Zoom) => void }) {
  const list = useRef<HTMLOListElement>(null);
  const count = lane.log.length;
  const running = lane.status === "running";

  // Keep the newest step in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, running]);

  if (!count && !running) {
    return (
      <div className="flex min-h-40 flex-1 items-center justify-center px-3 py-6 text-base text-faint">
        {lane.status === "queued" ? "On the start line…" : "No steps logged."}
      </div>
    );
  }

  return (
    <ol ref={list} className="max-h-[380px] min-h-40 flex-1 overflow-y-auto px-2 py-1" aria-label={`${LANE_META[id].title} steps`}>
      {lane.log.map((entry, i) => (
        <LogRow key={`${i}-${entry.step}`} lane={id} entry={entry} onZoom={onZoom} />
      ))}
      {running && (
        <li className="flex items-center gap-2 px-1 py-2 text-base text-muted">
          <span className="font-pixel w-7 text-[8px] text-faint">#{String(lane.current + 1).padStart(2, "0")}</span>
          <PixelIcon name="compile" size={12} className="px-spin" />
          {id === "browser" ? "reading the page…" : "calling…"}
          <span className="animate-blink inline-block h-4 w-2 bg-muted" />
        </li>
      )}
    </ol>
  );
}

function LogRow({ lane, entry, onZoom }: { lane: LaneId; entry: RaceLogEntry; onZoom: (zoom: Zoom) => void }) {
  const style = actionStyle(entry.action);
  const color = TONE_COLOR[style.tone];
  const [head, result] = lane === "broker" ? splitDetail(entry.detail) : [entry.detail, null];
  return (
    <li className="px-rise grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-line/60 px-1 py-1.5 last:border-0">
      <span className="font-pixel w-7 text-[8px] text-faint">#{String(entry.step).padStart(2, "0")}</span>
      <ActionIcon action={entry.action} />
      <div className="min-w-0">
        <div className="font-pixel text-[8px] uppercase" style={{ color }}>
          {style.label}
        </div>
        {lane === "broker" ? (
          <p className="break-words text-base leading-tight">
            <span className="text-green-hi">{head}</span>
            {result && (
              <>
                <span className="text-faint"> → </span>
                <span className="text-text">{result}</span>
              </>
            )}
          </p>
        ) : (
          <p className="break-words text-base leading-tight text-text">{head || "—"}</p>
        )}
      </div>
      {entry.screenshot_url ? (
        <button
          type="button"
          className="px-frame block cursor-zoom-in hover:[--frame:var(--color-green)]"
          onClick={() => onZoom({ src: entry.screenshot_url ?? "", caption: `Step ${entry.step} · ${entry.detail}` })}
          aria-label={`Enlarge screenshot of step ${entry.step}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={entry.screenshot_url}
            alt=""
            width={64}
            height={40}
            className="pixelated block h-10 w-16 object-cover object-top"
          />
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}

// ── Screenshot overlay ─────────────────────────────────────────────────────

export function Lightbox({ zoom, onClose }: { zoom: Zoom; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={zoom.caption}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div className="px-panel flex max-h-full max-w-[min(1100px,100%)] flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b-2 border-line bg-panel-2 px-3 py-2">
          <span className="font-pixel truncate text-[9px] uppercase text-green">{zoom.caption}</span>
          <button type="button" className="px-btn px-btn--ghost px-btn--sm" onClick={onClose} autoFocus>
            Close
          </button>
        </header>
        <div className="min-h-0 overflow-auto p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoom.src}
            alt={zoom.caption}
            className="pixelated block h-auto max-h-[78vh] w-[min(960px,85vw)] object-contain"
          />
        </div>
      </div>
    </div>
  );
}


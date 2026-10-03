"use client";

// The arena for one race: a pixel track with both racers, the two lanes side by side, and
// the scoreboard once both have crossed the line. Mounted with key={race id} so clocks reset.

import { useCallback, useState, type CSSProperties } from "react";
import type { Race } from "@/lib/doorway";
import { Sprite } from "@/components/px/sprite";
import { Badge, Banner, Button, cx } from "@/components/px/ui";
import { Checkered, LANE_META, RaceFx } from "./race-art";
import { LaneColumn, Lightbox, type Zoom } from "./race-lane";
import { isFinished, lanesOf, progressOf, winnerOf, type Lane, type LaneId } from "./race-model";
import { Scoreboard } from "./race-scoreboard";

const PHASE: Record<Race["status"], { text: string; color: string }> = {
  queued: { text: "On your marks…", color: "var(--color-muted)" },
  running: { text: "Go!", color: "var(--color-green)" },
  done: { text: "Finish", color: "var(--color-gold)" },
  failed: { text: "Race failed", color: "var(--color-red)" },
};

export function RaceArena({
  race,
  siteName,
  active,
  onAgain,
  againPending,
  onStop,
}: {
  race: Race;
  siteName: string;
  active: boolean;
  onAgain: () => void;
  againPending: boolean;
  onStop: () => void;
}) {
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const closeZoom = useCallback(() => setZoom(null), []);
  const { browser, broker } = lanesOf(race);
  const finished = isFinished(race.status);
  const bothDone = isFinished(browser.status) && isFinished(broker.status);
  const winner = bothDone ? winnerOf(browser, broker) : null;
  const tokenScale = Math.max(20000, browser.tokens, broker.tokens);
  const phase = PHASE[race.status];

  return (
    <div className="flex flex-col gap-4">
      <RaceFx />

      <div className="px-panel flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
        <span
          className={cx("font-pixel text-[12px] uppercase", !finished && "animate-pulse-px")}
          style={{ color: phase.color }}
        >
          {phase.text}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg text-text">“{race.task}”</p>
          <p className="truncate text-sm text-muted">
            {siteName} · <span className="text-faint">{race.id}</span>
          </p>
        </div>
        <Badge status={race.status} />
        {!finished && (
          <Button variant="ghost" size="sm" onClick={onStop} title="Stop following this race">
            Stop watching
          </Button>
        )}
      </div>

      {race.status === "queued" && (
        <Banner tone="info" icon="sandbox" title="Queued">
          Waiting for a sandbox to claim the race job. Both lanes start together.
        </Banner>
      )}

      <RaceTrack browser={browser} broker={broker} winner={winner} />

      <div className="grid gap-4 lg:grid-cols-2">
        <LaneColumn
          id="browser"
          lane={browser}
          tokenScale={tokenScale}
          active={active}
          winner={winner === "browser"}
          onZoom={setZoom}
        />
        <LaneColumn
          id="broker"
          lane={broker}
          tokenScale={tokenScale}
          active={active}
          winner={winner === "broker"}
          onZoom={setZoom}
        />
      </div>

      {race.status === "failed" && (
        <Banner
          tone="bad"
          title="Race failed"
          action={
            <Button size="sm" icon="race" onClick={onAgain} loading={againPending}>
              Race again
            </Button>
          }
        >
          {browser.error || broker.error || "The race job failed before both lanes finished."}
        </Banner>
      )}

      {race.status === "done" && bothDone && (
        <Scoreboard browser={browser} broker={broker} winner={winner} onAgain={onAgain} againPending={againPending} />
      )}

      {zoom && <Lightbox zoom={zoom} onClose={closeZoom} />}
    </div>
  );
}

/** Two pixel racers running towards a checkered finish line. */
function RaceTrack({ browser, broker, winner }: { browser: Lane; broker: Lane; winner: LaneId | null }) {
  const rows: [LaneId, Lane][] = [
    ["broker", broker],
    ["browser", browser],
  ];
  return (
    <div className="px-inset relative overflow-hidden px-3 py-2" aria-hidden>
      {rows.map(([id, lane]) => {
        const p = progressOf(lane);
        const meta = LANE_META[id];
        return (
          <div key={id} className="relative flex h-14 items-center border-b-2 border-dashed border-line last:border-0">
            <span className="font-pixel absolute left-0 top-1.5 flex flex-col gap-1 text-[7px] uppercase" style={{ color: meta.color }}>
              {id}
              {winner === id && <span className="race-pop text-gold">★ 1st</span>}
            </span>
            <div className="relative ml-14 mr-6 h-full flex-1">
              <span
                className="absolute bottom-1"
                style={
                  {
                    left: `${p * 100}%`,
                    transform: `translateX(-${p * 100}%)`,
                    transition: "left 450ms steps(6, end), transform 450ms steps(6, end)",
                    opacity: lane.status === "failed" ? 0.4 : 1,
                  } as CSSProperties
                }
              >
                <Sprite map={meta.sprite} scale={3} className={cx("block", lane.status === "running" && "race-bob")} />
              </span>
            </div>
          </div>
        );
      })}
      <Checkered className="absolute bottom-0 right-3 top-0 w-3" cell={4} />
    </div>
  );
}

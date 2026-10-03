// The finish: side-by-side scoreboard, a WINNER banner, the headline speedup and a burst
// of pixel confetti. Rendered once both lanes have finished.

import type { CSSProperties, ReactNode } from "react";
import { fmtInt, fmtMs, fmtTokens, speedup } from "@/lib/doorway/format";
import { Sprite } from "@/components/px/sprite";
import { Button, cx } from "@/components/px/ui";
import { Checkered, Confetti, FLAG, LANE_META, TROPHY } from "./race-art";
import type { Lane, LaneId } from "./race-model";

export function Scoreboard({
  browser,
  broker,
  winner,
  onAgain,
  againPending,
}: {
  browser: Lane;
  broker: Lane;
  winner: LaneId | null;
  onAgain: () => void;
  againPending: boolean;
}) {
  const faster = winner === "broker" ? speedup(browser.ms, broker.ms) : null;
  const fewer = winner === "broker" ? browser.tokens - broker.tokens : 0;
  const lanes: [LaneId, Lane][] = [
    ["browser", browser],
    ["broker", broker],
  ];

  return (
    <section
      className="px-panel px-rise relative overflow-hidden"
      style={{ "--frame": winner ? "var(--color-gold)" : "var(--color-line-2)" } as CSSProperties}
      aria-label="Race results"
    >
      <Checkered className="h-3 w-full" />

      <div className="relative grid gap-4 p-4 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
        <div className="flex items-center gap-3 lg:flex-col">
          <Sprite map={winner ? TROPHY : FLAG} scale={5} className="race-pop" />
          <span className="font-pixel text-[10px] uppercase text-gold">{winner ? "Finish!" : "No winner"}</span>
        </div>

        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th className="w-28" />
              {lanes.map(([id]) => (
                <th key={id} className="px-2 pb-2 align-bottom">
                  {winner === id && (
                    <span
                      className="font-pixel race-pop mb-1.5 inline-block bg-gold px-2 py-1 text-[9px] uppercase text-[#1d1200]"
                      style={{ boxShadow: "0 0 12px var(--color-gold)" }}
                    >
                      ★ Winner
                    </span>
                  )}
                  <div className="font-pixel text-[9px] uppercase" style={{ color: LANE_META[id].color }}>
                    {LANE_META[id].title}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row label="Time" cells={lanes.map(([id, l]) => cell(fmtMs(l.ms), winner === id))} />
            <Row label="Steps" cells={lanes.map(([id, l]) => cell(fmtInt(l.steps), winner === id))} />
            <Row label="Tokens" cells={lanes.map(([id, l]) => cell(fmtTokens(l.tokens), winner === id))} />
            <Row
              label="Success"
              cells={lanes.map(([id, l]) =>
                cell(
                  l.success === false || l.status === "failed" ? (
                    <span className="text-red">✗ failed</span>
                  ) : l.success ? (
                    <span className="text-green">✓ done</span>
                  ) : (
                    <span className="text-muted">? unknown</span>
                  ),
                  winner === id,
                ),
              )}
            />
          </tbody>
        </table>

        <div className="flex flex-col items-start gap-3 lg:items-end">
          {faster !== null && (
            <div className="race-pop text-left lg:text-right">
              <div className="font-pixel px-glow text-[26px] leading-none text-green">{faster}× faster</div>
              {fewer > 0 && (
                <div className="font-pixel mt-2 text-[11px] uppercase text-gold">{fmtTokens(fewer)} fewer tokens</div>
              )}
            </div>
          )}
          {winner === "browser" && (
            <p className="max-w-56 text-base text-muted">The broker lane didn&apos;t finish cleanly this time.</p>
          )}
          <Button size="lg" icon="race" onClick={onAgain} loading={againPending}>
            Race again
          </Button>
        </div>
      </div>
      {winner && <Confetti className="z-10" />}
    </section>
  );
}

function cell(content: ReactNode, win: boolean): { content: ReactNode; win: boolean } {
  return { content, win };
}

function Row({ label, cells }: { label: string; cells: { content: ReactNode; win: boolean }[] }) {
  return (
    <tr className="border-t-2 border-line">
      <th scope="row" className="font-pixel py-2 pr-2 text-[8px] uppercase text-faint">
        {label}
      </th>
      {cells.map((c, i) => (
        <td key={i} className={cx("px-2 py-2 text-xl tabular-nums", c.win ? "text-text" : "text-muted")}>
          {c.content}
        </td>
      ))}
    </tr>
  );
}

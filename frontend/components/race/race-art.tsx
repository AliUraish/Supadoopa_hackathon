// Race arena art: local sprites and icons, step-action styling, the checkered finish line,
// pixel confetti and the keyframes they use. No hooks: safe anywhere.

import type { CSSProperties } from "react";
import { TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { Sprite, SPRITES } from "@/components/px/sprite";
import { cx } from "@/components/px/ui";
import type { LaneId } from "./race-model";

export const LANE_META: Record<
  LaneId,
  { title: string; tagline: string; sprite: readonly string[]; tone: Tone; color: string; footer: string }
> = {
  browser: {
    title: "Browser agent",
    tagline: "screenshot → LLM → click, every step",
    sprite: SPRITES.browser,
    tone: "warn",
    color: "var(--color-amber)",
    footer: "Each step = a screenshot sent to an LLM + one UI action",
  },
  broker: {
    title: "Doorway broker",
    tagline: "verified MCP tools, no browser",
    sprite: SPRITES.door,
    tone: "ok",
    color: "var(--color-green)",
    footer: "1 tool call ≈ 1 HTTP request · 0 LLM tokens",
  },
};

export const TROPHY = [
  "..YYYYYYYY..",
  "YYYWYYYYYAYY",
  "Y.YWYYYYYA.Y",
  "Y.YWYYYYYA.Y",
  ".YYWYYYYYAY.",
  "..YYYYYYAA..",
  "...YYYYAA...",
  ".....YA.....",
  ".....YA.....",
  "...YYYYAA...",
  "..ssssssss..",
  "..SSSSSSSS..",
];

export const FLAG = [
  "SKKWWKKWW.",
  "SKKWWKKWW.",
  "SWWKKWWKK.",
  "SWWKKWWKK.",
  "SKKWWKKWW.",
  "SKKWWKKWW.",
  "S.........",
  "S.........",
  "S.........",
  "S.........",
  "S.........",
  "SS........",
];

// 8×8 action icons ('#' = currentColor) that the shared icon set lacks.
const CAMERA = ["..###...", "########", "#..##..#", "#.#..#.#", "#.#..#.#", "#..##..#", "########", "........"];
const CURSOR = ["#.......", "##......", "###.....", "####....", "#####...", "###.....", "#.##....", "...##..."];
const KEYS = ["........", "########", "#.#.#.##", "########", "##.#.#.#", "########", "#.####.#", "########"];
const MONO = { "#": "currentColor" };

interface ActionStyle {
  label: string;
  tone: Tone;
  icon?: IconName;
  map?: string[];
}

const ACTIONS: Record<string, ActionStyle> = {
  screenshot: { label: "Screenshot", tone: "violet", map: CAMERA },
  click: { label: "Click", tone: "warn", map: CURSOR },
  type: { label: "Type", tone: "info", map: KEYS },
  fill: { label: "Type", tone: "info", map: KEYS },
  select: { label: "Select", tone: "info", map: CURSOR },
  submit: { label: "Submit", tone: "gold", icon: "execute" },
  goto: { label: "Navigate", tone: "muted", icon: "globe" },
  navigate: { label: "Navigate", tone: "muted", icon: "globe" },
  scroll: { label: "Scroll", tone: "muted", icon: "chevron" },
  wait: { label: "Wait", tone: "muted", icon: "clock" },
  think: { label: "Think", tone: "violet", icon: "compile" },
  read: { label: "Read", tone: "violet", icon: "observe" },
  call: { label: "Tool call", tone: "ok", icon: "tool" },
  result: { label: "Result", tone: "ok", icon: "verify" },
  error: { label: "Error", tone: "bad", icon: "warn" },
};

export function actionStyle(action: string): ActionStyle {
  return ACTIONS[action.toLowerCase()] ?? { label: action || "Step", tone: "muted", icon: "dot" };
}

export function ActionIcon({ action, size = 12, className }: { action: string; size?: number; className?: string }) {
  const style = actionStyle(action);
  const color = TONE_COLOR[style.tone];
  return (
    <span className={cx("inline-flex shrink-0", className)} style={{ color }}>
      {style.map ? (
        <Sprite map={style.map} palette={MONO} scale={size / 8} />
      ) : (
        <PixelIcon name={style.icon ?? "dot"} size={size} />
      )}
    </span>
  );
}

/** Black/white checkered strip (the finish line). */
export function Checkered({ className, cell = 6, style }: { className?: string; cell?: number; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cx("block", className)}
      style={{
        backgroundImage: "repeating-conic-gradient(#e3f5ea 0 25%, #050706 0 50%)",
        backgroundSize: `${cell * 2}px ${cell * 2}px`,
        ...style,
      }}
    />
  );
}

// Keyframes for the arena (hoisted and de-duplicated by React).
const FX_CSS = `
@keyframes race-fall {
  0% { transform: translate(0, -12px); opacity: 1; }
  75% { opacity: 1; }
  100% { transform: translate(var(--dx, 0px), var(--fall, 200px)); opacity: 0; }
}
@keyframes race-bob { 50% { transform: translateY(-3px); } }
@keyframes race-pop {
  0% { transform: scale(0.4); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); }
}
.race-confetti { position: absolute; top: 0; animation: race-fall 1.8s steps(14, end) forwards; }
.race-bob { animation: race-bob 0.45s steps(2, end) infinite; }
.race-pop { animation: race-pop 0.45s steps(5, end) both; }
`;

export function RaceFx() {
  return (
    <style href="doorway-race-fx" precedence="default">
      {FX_CSS}
    </style>
  );
}

const CONFETTI_COLORS = ["#3ecf8e", "#8cffc6", "#f7d046", "#ffb224", "#4cb4ff", "#b18cff", "#e3f5ea"];

/** A short burst of falling pixel squares (runs once on mount). */
export function Confetti({ count = 36, className }: { count?: number; className?: string }) {
  return (
    <div aria-hidden className={cx("pointer-events-none absolute inset-x-0 top-0 h-full overflow-hidden", className)}>
      {Array.from({ length: count }, (_, i) => {
        const size = [4, 6, 8][i % 3];
        return (
          <span
            key={i}
            className="race-confetti"
            style={
              {
                left: `${(i * 37 + 11) % 100}%`,
                width: size,
                height: size,
                background: CONFETTI_COLORS[(i * 5) % CONFETTI_COLORS.length],
                animationDelay: `${((i * 53) % 9) * 60}ms`,
                "--dx": `${((i * 29) % 41) - 20}px`,
                "--fall": `${140 + ((i * 71) % 120)}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

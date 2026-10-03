"use client";

// Small pieces of the workspace scene: sprites with live screens, speech bubbles, labels.

import { memo, type CSSProperties, type ReactNode } from "react";
import { TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { PALETTE, Sprite, SPRITES } from "@/components/px/sprite";
import { cx } from "@/components/px/ui";
import { POINTER, RED_X } from "./sprites";
import styles from "./workspace.module.css";

/** Sprites re-render only when their map/scale/palette change. */
export const StaticSprite = memo(Sprite);

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** A sprite with a live HTML "screen" laid over its screen pixels. */
export function ScreenSprite({
  map,
  scale,
  screen,
  palette,
  anchor,
  className,
  children,
}: {
  map: readonly string[];
  scale: number;
  screen: Rect;
  palette?: Record<string, string>;
  anchor?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-anchor={anchor}
      className={cx("relative shrink-0", className)}
      style={{ width: map[0].length * scale, height: map.length * scale }}
    >
      <StaticSprite map={map} scale={scale} palette={palette} className="absolute inset-0" />
      <div
        className="absolute overflow-hidden"
        style={{ left: screen.x * scale, top: screen.y * scale, width: screen.w * scale, height: screen.h * scale }}
      >
        {children}
      </div>
    </div>
  );
}

const WIDTHS = [72, 44, 86, 58, 30, 66, 50, 80];
const LOOP = [...WIDTHS, ...WIDTHS];

/** Scrolling green code: a busy worker. */
export function CodeLines({ fast, color = PALETTE.G }: { fast?: boolean; color?: string }) {
  return (
    <div className={cx("flex flex-col px-[3px] pt-[3px]", fast ? styles.scrollFast : styles.scroll)}>
      {LOOP.map((w, i) => (
        <span
          key={i}
          className="mb-[3px] block h-[3px] shrink-0"
          style={{ width: `${w}%`, background: i % 4 === 0 ? PALETTE.H : color }}
        />
      ))}
    </div>
  );
}

/** Lines being typed: the agent composing a request. */
export function TypingLines() {
  return (
    <div className="flex flex-col gap-[3px] p-[3px]">
      {[78, 52, 66].map((w, i) => (
        <span
          key={i}
          className={cx("block h-[3px]", styles.type)}
          style={{ width: `${w}%`, background: i === 0 ? PALETTE.H : PALETTE.G, animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </div>
  );
}

/** A dim screen with a blinking cursor. */
export function IdleScreen({ label }: { label?: string }) {
  return (
    <div className="relative h-full w-full">
      {label && (
        <span className="absolute left-[3px] top-[1px] text-[11px] leading-none text-green-dim opacity-70">{label}</span>
      )}
      <span className="animate-blink absolute bottom-[3px] left-[3px] h-[4px] w-[6px] bg-green" />
    </div>
  );
}

/** A tiny Chromium window with a wandering pointer: a browser job. */
export function BrowserScreen() {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <StaticSprite map={SPRITES.browser} scale={2} />
      <span className={cx("absolute left-[35%] top-[30%]", styles.pointer)}>
        <StaticSprite map={POINTER} scale={1} />
      </span>
    </div>
  );
}

export function DeadScreen() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <StaticSprite map={RED_X} scale={4} />
    </div>
  );
}

/** A pixel speech bubble above its (relative) parent; vanishes on its own after 3–4 s. */
export function SpeechBubble({
  tone,
  icon,
  children,
  short,
  align = "center",
}: {
  tone: Tone;
  icon?: IconName;
  children: ReactNode;
  short?: boolean;
  align?: "center" | "left";
}) {
  const color = TONE_COLOR[tone];
  return (
    <div
      className={cx(
        "pointer-events-none absolute bottom-full z-20 mb-3 w-max max-w-[210px]",
        align === "center" ? "left-1/2 -translate-x-1/2" : "left-0",
      )}
    >
      <div className={cx("relative", short ? styles.bubbleShort : styles.bubble)}>
        <div
          className="px-frame flex items-start gap-1.5 bg-panel px-2 py-1 text-sm leading-tight text-text"
          style={{ "--frame": color } as CSSProperties}
        >
          {icon && (
            <span className="mt-0.5 shrink-0" style={{ color }}>
              <PixelIcon name={icon} size={10} />
            </span>
          )}
          <span className="line-clamp-2 min-w-0 break-words">{children}</span>
        </div>
        <span
          className={cx("absolute top-full h-[6px] w-[8px]", align === "center" ? "left-1/2 -ml-1" : "left-6")}
          style={{ background: color }}
        />
        <span
          className={cx("absolute top-full mt-[6px] h-[4px] w-[4px]", align === "center" ? "left-1/2" : "left-7")}
          style={{ background: color }}
        />
      </div>
    </div>
  );
}

/** The label painted on each room's wall. */
export function RoomLabel({ icon, title, sub, right }: { icon: IconName; title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="font-pixel flex items-center gap-2 text-[10px] uppercase text-green px-glow">
          <PixelIcon name={icon} size={12} />
          {title}
        </div>
        {sub && <div className="mt-0.5 truncate text-sm text-muted">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

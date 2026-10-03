"use client";

// Slim stepper for a site's lifecycle: Queued → Discover → Verify → Ready,
// or Broken → Healing → Verified while the self-heal loop runs.

import { motion, useReducedMotion } from "motion/react";
import type { SiteStatus } from "@/lib/doorway";
import { TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { cx } from "@/components/px/ui";

interface Step {
  label: string;
  /** Colour while this step is in progress. */
  tone: Tone;
  /** Colour once the step is behind us. */
  done: Tone;
}

const DISCOVERY: Step[] = [
  { label: "Queued", tone: "ok", done: "ok" },
  { label: "Discover", tone: "ok", done: "ok" },
  { label: "Verify", tone: "ok", done: "ok" },
  { label: "Ready", tone: "ok", done: "ok" },
];

const HEAL: Step[] = [
  { label: "Broken", tone: "bad", done: "warn" },
  { label: "Healing", tone: "warn", done: "warn" },
  { label: "Verified", tone: "ok", done: "ok" },
];

const FAILED: Step[] = [
  { label: "Queued", tone: "bad", done: "bad" },
  { label: "Discover", tone: "bad", done: "bad" },
  { label: "Verify", tone: "bad", done: "bad" },
  { label: "Failed", tone: "bad", done: "bad" },
];

/** Which strip to show and the index of the step in progress (steps.length = all done). */
function phase(status: SiteStatus): { steps: Step[]; current: number } {
  switch (status) {
    case "new":
    case "queued":
      return { steps: DISCOVERY, current: 0 };
    case "discovering":
      return { steps: DISCOVERY, current: 1 };
    case "verifying":
      return { steps: DISCOVERY, current: 2 };
    case "ready":
      return { steps: DISCOVERY, current: DISCOVERY.length };
    case "broken":
      return { steps: HEAL, current: 0 };
    case "healing":
      return { steps: HEAL, current: 1 };
    case "failed":
      return { steps: FAILED, current: FAILED.length };
  }
}

const EASE = [0.22, 1, 0.36, 1] as const;

export function PhaseStrip({ status, className }: { status: SiteStatus; className?: string }) {
  const reduce = useReducedMotion();
  const { steps, current } = phase(status);
  const transition = reduce ? { duration: 0 } : { duration: 0.35, ease: EASE };

  return (
    <ol
      className={cx("grid", className)}
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label={`Progress: ${status}`}
    >
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        const color = state === "todo" ? "var(--color-line-2)" : TONE_COLOR[state === "done" ? step.done : step.tone];
        // The connector into this step fills once we've reached it.
        const reached = i <= current;
        const lineColor = TONE_COLOR[i === current ? step.tone : step.done];
        return (
          <li
            key={step.label}
            className="relative flex min-w-0 flex-col items-center gap-1.5"
            aria-current={state === "current" ? "step" : undefined}
          >
            {i > 0 && (
              <span aria-hidden className="absolute right-1/2 top-[3px] h-px w-full overflow-hidden bg-line-2">
                <motion.span
                  className="block h-full origin-left"
                  style={{ background: lineColor }}
                  initial={false}
                  animate={{ scaleX: reached ? 1 : 0 }}
                  transition={transition}
                />
              </span>
            )}
            <span className="relative grid size-[7px] place-items-center">
              {state === "current" && !reduce && (
                <span
                  aria-hidden
                  className="absolute inset-[-3px] animate-breathe rounded-full"
                  style={{ background: `color-mix(in srgb, ${color} 30%, transparent)` }}
                />
              )}
              <motion.span
                aria-hidden
                className="relative block size-[7px] rounded-full transition-colors duration-300"
                style={{
                  background: state === "todo" ? "var(--color-panel)" : color,
                  border: `1px solid ${color}`,
                }}
                initial={false}
                animate={{ scale: state === "current" ? 1.25 : 1 }}
                transition={transition}
              />
            </span>
            <span
              className={cx(
                "max-w-full truncate text-[11px] transition-colors duration-300",
                state === "todo" ? "text-faint" : state === "current" ? "font-medium" : "text-muted",
              )}
              style={state === "current" ? { color } : undefined}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

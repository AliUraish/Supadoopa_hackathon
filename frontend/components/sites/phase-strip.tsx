// Thin progress strip for a site's lifecycle: queued → discovering → verifying → ready,
// or broken → healing → verified while the self-heal loop runs.

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
  { label: "Queued", tone: "muted", done: "ok" },
  { label: "Discover", tone: "info", done: "ok" },
  { label: "Verify", tone: "info", done: "ok" },
  { label: "Ready", tone: "ok", done: "ok" },
];

const HEAL: Step[] = [
  { label: "Broken", tone: "bad", done: "bad" },
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

export function PhaseStrip({ status, className }: { status: SiteStatus; className?: string }) {
  const { steps, current } = phase(status);
  return (
    <ol
      className={cx("grid gap-1", className)}
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label={`Progress: ${status}`}
    >
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        const color =
          state === "todo" ? "var(--color-line)" : TONE_COLOR[state === "done" ? step.done : step.tone];
        return (
          <li key={step.label} className="flex min-w-0 flex-col gap-1" aria-current={state === "current" ? "step" : undefined}>
            <span
              className={cx("h-1.5", state === "current" && "animate-pulse-px")}
              style={{ background: color, boxShadow: state === "todo" ? undefined : `0 0 6px ${color}` }}
            />
            <span
              className="font-pixel truncate text-[8px] uppercase"
              style={{ color: state === "todo" ? "var(--color-faint)" : color }}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

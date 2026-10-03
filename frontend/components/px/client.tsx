"use client";

// Interactive pixel primitives (hooks inside).

import { useState, type ReactNode } from "react";
import { DOORWAY_MOCK } from "@/lib/doorway";
import { clockTime, timeAgo } from "@/lib/doorway/format";
import { useLiveMode, useNow } from "@/lib/doorway/live";
import { PixelIcon } from "./icons";
import { cx } from "./ui";

export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx("px-inset flex items-center gap-2 py-2 pl-3 pr-2", className)}>
      <span className="select-none text-green">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-base text-green-hi">{command}</code>
      <button
        type="button"
        className="px-btn px-btn--ghost px-btn--sm"
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
        aria-label="Copy command"
      >
        <PixelIcon name={copied ? "verify" : "copy"} size={10} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={cx("flex cursor-pointer items-start gap-3", disabled && "cursor-not-allowed opacity-50", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="px-frame relative mt-0.5 h-4 w-8 shrink-0"
        style={{
          ["--frame" as string]: checked ? "var(--color-green)" : "var(--color-line-2)",
          background: checked ? "var(--color-green-deep)" : "var(--color-bg-2)",
        }}
      >
        <span
          className="absolute top-0 size-4 transition-[left] duration-100"
          style={{ left: checked ? 16 : 0, background: checked ? "var(--color-green)" : "var(--color-faint)" }}
        />
      </button>
      <span className="flex flex-col">
        <span className="text-base text-text">{label}</span>
        {hint && <span className="text-sm text-faint">{hint}</span>}
      </span>
    </label>
  );
}

export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={iso ?? undefined} title={iso ?? undefined} className={className} suppressHydrationWarning>
      {now ? timeAgo(iso, now) : clockTime(iso)}
    </time>
  );
}

/** MOCK / REALTIME / POLLING indicator for live panels. */
export function LiveBadge({ className }: { className?: string }) {
  const mode = useLiveMode();
  const label = DOORWAY_MOCK ? "Mock stream" : mode === "realtime" ? "Realtime" : "Polling 2s";
  const color = mode === "polling" ? "var(--color-amber)" : "var(--color-green)";
  return (
    <span
      className={cx("font-pixel inline-flex items-center gap-1.5 text-[8px] uppercase", className)}
      style={{ color }}
      title={
        mode === "polling"
          ? "Supabase Realtime is unavailable: polling the API every 2 s"
          : mode === "realtime"
            ? "Live via Supabase Realtime"
            : "NEXT_PUBLIC_DOORWAY_MOCK=1: fixtures and a fake live stream"
      }
    >
      <span className="animate-blink inline-block size-2" style={{ background: color }} />
      {label}
    </span>
  );
}

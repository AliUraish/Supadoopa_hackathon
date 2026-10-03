"use client";

// Interactive primitives (hooks inside).

import { useState, type ReactNode } from "react";
import { clockTime, timeAgo } from "@/lib/doorway/format";
import { useLiveMode, useNow } from "@/lib/doorway/live";
import { Icon } from "./icons";
import { cx } from "./ui";

export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx("px-inset flex items-center gap-2 py-1.5 pl-3 pr-1.5", className)}>
      <span className="select-none font-mono text-xs text-faint">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-text">{command}</code>
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
        <Icon name={copied ? "verify" : "copy"} size={13} />
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
        className={cx(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-150",
          checked ? "border-green-dim bg-green" : "border-line-2 bg-panel-3",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 size-3.5 rounded-full shadow transition-[left] duration-150",
            checked ? "left-[18px] bg-green-ink" : "left-0.5 bg-muted",
          )}
        />
      </button>
      <span className="flex flex-col">
        <span className="text-[13px] text-text">{label}</span>
        {hint && <span className="text-xs text-faint">{hint}</span>}
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

/** Realtime / Polling indicator for live panels. */
export function LiveBadge({ className }: { className?: string }) {
  const mode = useLiveMode();
  const label = mode === "realtime" ? "Realtime" : "Polling";
  const color = mode === "polling" ? "var(--color-amber)" : "var(--color-green)";
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 text-xs text-muted", className)}
      title={
        mode === "polling"
          ? "Supabase Realtime is unavailable: polling the API every 2 s"
          : "Live via Supabase Realtime"
      }
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full opacity-60" style={{ background: color }} />
        <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
      </span>
      {label}
    </span>
  );
}

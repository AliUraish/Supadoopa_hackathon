"use client";

// A small segmented control (radio group styled as joined buttons).

import { cx } from "@/components/px/ui";

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string; count?: number }[];
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("inline-flex h-[34px] shrink-0 items-center gap-0.5 rounded-md border border-line bg-bg-2 p-0.5", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "inline-flex h-full items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-xs transition-colors",
              on ? "bg-panel-3 text-text" : "text-muted hover:text-text",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="font-mono tabular-nums text-faint">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

"use client";

// Inline click-to-copy text (MCP tool names, payment references).

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/px/icons";
import { cx } from "@/components/px/ui";

/** "pi_test_3Qx…9aF2" */
export function shortRef(ref: string, head = 10, tail = 4): string {
  return ref.length > head + tail + 1 ? `${ref.slice(0, head)}…${ref.slice(-tail)}` : ref;
}

export function CopyText({
  value,
  children,
  className,
}: {
  value: string;
  children?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "Copied" : `Copy ${value}`}
      aria-label={`Copy ${value}`}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      className={cx("inline-flex min-w-0 items-center gap-1.5 text-left hover:text-green", className)}
    >
      <span className="min-w-0 truncate">{children ?? value}</span>
      <Icon name={copied ? "verify" : "copy"} size={13} className={cx("shrink-0 text-faint", copied && "text-green")} />
    </button>
  );
}

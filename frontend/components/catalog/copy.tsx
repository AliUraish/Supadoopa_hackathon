"use client";

// Copyable code: a one-line value (URL, command) and a multi-line block (JSON, curl).

import { useEffect, useState } from "react";
import { Icon } from "@/components/px/icons";
import { cx } from "@/components/px/ui";

function useCopy() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  };
  return { copied, copy };
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className={cx("px-btn px-btn--ghost px-btn--sm shrink-0", className)}
      onClick={() => copy(text)}
      aria-label={`${label}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`}
    >
      <Icon name={copied ? "verify" : "copy"} size={13} className={copied ? "text-green" : undefined} />
      {copied ? "Copied" : label}
    </button>
  );
}

/** One line, scrolls horizontally, copy button on the right. */
export function CopyLine({ value, prompt, className }: { value: string; prompt?: boolean; className?: string }) {
  return (
    <div className={cx("px-inset flex min-w-0 items-center gap-2 py-1.5 pl-3 pr-1.5", className)}>
      {prompt && <span className="select-none font-mono text-xs text-faint">$</span>}
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-text">{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

/** Multi-line code with a filename/caption bar. */
export function CodeBlock({ code, caption, className }: { code: string; caption?: string; className?: string }) {
  return (
    <div className={cx("px-inset min-w-0 overflow-hidden", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line py-1 pl-3 pr-1.5">
        <span className="truncate font-mono text-[11px] text-faint">{caption ?? ""}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-text">{code}</pre>
    </div>
  );
}

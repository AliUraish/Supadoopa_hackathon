// UI primitives (server-safe: no hooks). Client-only pieces live in ./client.tsx.
// Clean dark Supabase-style system: 1px borders, 6–8px radius, one green accent.

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, CSSProperties, ReactNode } from "react";
import { describeError } from "@/lib/doorway";
import { isPulsing, statusTone, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { Icon, type IconName } from "./icons";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

// ── Layout ─────────────────────────────────────────────────────────────────

export function Panel({
  title,
  icon,
  actions,
  children,
  className,
  bodyClassName,
  tone,
}: {
  title?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  tone?: Tone;
}) {
  return (
    <section
      className={cx("px-panel flex min-w-0 flex-col", className)}
      style={tone ? ({ "--frame": `color-mix(in srgb, ${TONE_COLOR[tone]} 45%, transparent)` } as CSSProperties) : undefined}
    >
      {title !== undefined && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text">
            {icon && <Icon name={icon} size={15} className="shrink-0 text-muted" />}
            <span className="truncate">{title}</span>
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("min-h-0 flex-1", !/(^|\s)p-\S+/.test(bodyClassName ?? "") && "p-4", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

export function SectionTitle({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-faint">
      {icon && <Icon name={icon} size={13} />}
      {children}
    </h3>
  );
}

// ── Buttons ────────────────────────────────────────────────────────────────

type Variant = "primary" | "ghost" | "danger" | "warn";
type Size = "sm" | "md" | "lg";

function btnClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cx(
    "px-btn",
    variant !== "primary" && `px-btn--${variant}`,
    size !== "md" && `px-btn--${size}`,
    className,
  );
}

export function Button({
  variant,
  size,
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: IconName;
}) {
  const iconSize = size === "sm" ? 13 : 15;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={btnClass(variant, size, className)}
    >
      {loading ? <Spinner size={iconSize} /> : icon && <Icon name={icon} size={iconSize} />}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  icon,
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size; icon?: IconName }) {
  return (
    <Link {...rest} className={btnClass(variant, size, className)}>
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 15} />}
      {children}
    </Link>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block shrink-0 rounded-full border-2 border-current border-t-transparent px-spin", className)}
      style={{ width: size, height: size }}
    />
  );
}

// ── Status ─────────────────────────────────────────────────────────────────

export function StatusDot({
  status,
  tone,
  size = 8,
  pulse,
  className,
}: {
  status?: string | null;
  tone?: Tone;
  size?: number;
  pulse?: boolean;
  className?: string;
}) {
  const color = TONE_COLOR[tone ?? statusTone(status)];
  return (
    <span
      aria-hidden
      className={cx("inline-block shrink-0 rounded-full", (pulse ?? isPulsing(status)) && "animate-breathe", className)}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
      }}
    />
  );
}

export function Badge({
  status,
  tone,
  children,
  pulse,
  className,
}: {
  status?: string | null;
  tone?: Tone;
  children?: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  const color = TONE_COLOR[tone ?? statusTone(status)];
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11px] font-medium capitalize leading-none",
        (pulse ?? isPulsing(status)) && "animate-breathe",
        className,
      )}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {children ?? status}
    </span>
  );
}

// ── Metrics ────────────────────────────────────────────────────────────────

export function Tile({
  label,
  value,
  sub,
  tone = "ok",
  icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon?: IconName;
  className?: string;
}) {
  return (
    <div className={cx("px-panel flex min-w-0 flex-col gap-1 px-4 py-3", className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon && <Icon name={icon} size={13} style={{ color: TONE_COLOR[tone] }} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate text-2xl font-semibold tracking-tight tabular-nums text-text">{value}</div>
      {sub !== undefined && <div className="truncate text-xs text-faint">{sub}</div>}
    </div>
  );
}

/** Thin progress bar, value 0–max. */
export function Meter({
  value,
  max = 1,
  tone = "ok",
  className,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  /** @deprecated ignored (segmented pixel bars are gone) */
  segments?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, max ? value / max : 0)) * 100;
  return (
    <div
      className={cx("h-1.5 overflow-hidden rounded-full bg-line", className)}
      role="meter"
      aria-valuenow={value}
      aria-valuemax={max}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%`, background: TONE_COLOR[tone] }}
      />
    </div>
  );
}

// ── Feedback states ────────────────────────────────────────────────────────

export function Banner({
  tone = "info",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const color = TONE_COLOR[tone];
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={cx("flex items-start gap-3 rounded-md px-3 py-2.5", className)}
      style={{
        background: `color-mix(in srgb, ${color} 8%, var(--color-panel))`,
        border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
      }}
    >
      <Icon
        name={icon ?? (tone === "bad" ? "warn" : tone === "ok" ? "verify" : "dot")}
        size={16}
        className="mt-0.5 shrink-0"
        style={{ color }}
      />
      <div className="min-w-0 flex-1">
        {title && <div className="text-[13px] font-medium text-text">{title}</div>}
        {children && <div className="text-[13px] text-muted">{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** Renders any client error; 503 not_configured becomes "Backend not configured: missing X". */
export function ErrorBanner({ error, action, className }: { error: unknown; action?: ReactNode; className?: string }) {
  if (!error) return null;
  return (
    <Banner tone="bad" title="Something went wrong" action={action} className={className}>
      {describeError(error)}
    </Banner>
  );
}

export function Empty({
  icon = "dot",
  title,
  hint,
  action,
  className,
}: {
  icon?: IconName;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center gap-2 px-4 py-10 text-center", className)}>
      <span className="grid size-9 place-items-center rounded-md border border-line bg-panel-2 text-muted">
        <Icon name={icon} size={17} />
      </span>
      <div className="text-[13px] font-medium text-text">{title}</div>
      {hint && <p className="max-w-sm text-[13px] text-faint">{hint}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div className={cx("flex items-center justify-center gap-2 px-4 py-10 text-[13px] text-muted", className)} role="status">
      <Spinner />
      {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("skeleton", className)} />;
}

// ── Forms ──────────────────────────────────────────────────────────────────

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-muted">
        {label}
        {required && <span className="text-green"> *</span>}
      </span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input {...rest} className={cx("px-input", className)} />;
}

export function Select({ className, ...rest }: ComponentProps<"select">) {
  return <select {...rest} className={cx("px-input", className)} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea {...rest} className={cx("px-input", className)} />;
}

export function Kv({ k, v, className }: { k: ReactNode; v: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-3", className)}>
      <span className="text-xs text-faint">{k}</span>
      <span className="min-w-0 truncate text-right text-[13px] text-text">{v}</span>
    </div>
  );
}

/** Pretty JSON in an inset code box. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cx("px-inset max-h-80 overflow-auto p-3 font-mono text-xs leading-relaxed text-muted", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

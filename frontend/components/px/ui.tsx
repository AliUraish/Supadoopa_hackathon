// Pixel UI primitives (server-safe: no hooks). Client-only pieces live in ./client.tsx.

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, CSSProperties, ReactNode } from "react";
import { describeError } from "@/lib/doorway";
import { isPulsing, statusTone, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { PixelIcon, type IconName } from "./icons";

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
      style={tone ? ({ "--frame": TONE_COLOR[tone] } as CSSProperties) : undefined}
    >
      {title !== undefined && (
        <header className="flex min-h-10 items-center justify-between gap-3 border-b-2 border-line bg-panel-2 px-3 py-2">
          <h2 className="font-pixel flex min-w-0 items-center gap-2 text-[10px] uppercase text-green">
            {icon && <PixelIcon name={icon} size={14} />}
            <span className="truncate">{title}</span>
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("min-h-0 flex-1 p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function SectionTitle({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <h3 className="font-pixel mb-2 flex items-center gap-2 text-[9px] uppercase text-muted">
      {icon && <PixelIcon name={icon} size={12} />}
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
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={btnClass(variant, size, className)}
    >
      {loading ? (
        <PixelIcon name="compile" size={size === "sm" ? 10 : 12} className="px-spin" />
      ) : (
        icon && <PixelIcon name={icon} size={size === "sm" ? 10 : 12} />
      )}
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
      {icon && <PixelIcon name={icon} size={size === "sm" ? 10 : 12} />}
      {children}
    </Link>
  );
}

// ── Status ─────────────────────────────────────────────────────────────────

export function StatusDot({
  status,
  tone,
  size = 10,
  pulse,
  className,
}: {
  status?: string | null;
  tone?: Tone;
  size?: number;
  pulse?: boolean;
  className?: string;
}) {
  const t = tone ?? statusTone(status);
  const color = TONE_COLOR[t];
  return (
    <span
      aria-hidden
      className={cx("inline-block shrink-0", (pulse ?? isPulsing(status)) && "animate-pulse-px", className)}
      style={{ width: size, height: size, background: color, boxShadow: `0 0 8px ${color}` }}
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
  const t = tone ?? statusTone(status);
  const color = TONE_COLOR[t];
  return (
    <span
      className={cx(
        "font-pixel inline-flex items-center gap-1.5 whitespace-nowrap px-1.5 py-1 text-[8px] uppercase leading-none",
        (pulse ?? isPulsing(status)) && "animate-pulse-px",
        className,
      )}
      style={{ color, boxShadow: `inset 0 0 0 2px ${color}`, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
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
    <div className={cx("px-panel flex min-w-0 flex-col gap-1 px-3 py-2.5", className)}>
      <div className="font-pixel flex items-center gap-1.5 text-[8px] uppercase text-muted">
        {icon && <PixelIcon name={icon} size={10} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="font-pixel truncate text-[18px] leading-tight px-glow" style={{ color: TONE_COLOR[tone] }}>
        {value}
      </div>
      {sub !== undefined && <div className="truncate text-sm text-muted">{sub}</div>}
    </div>
  );
}

/** Segmented pixel bar, value 0–max. */
export function Meter({
  value,
  max = 1,
  tone = "ok",
  segments = 20,
  className,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  segments?: number;
  className?: string;
}) {
  const filled = Math.round(Math.max(0, Math.min(1, max ? value / max : 0)) * segments);
  return (
    <div className={cx("flex h-3 gap-[2px]", className)} role="meter" aria-valuenow={value} aria-valuemax={max}>
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className="h-full flex-1"
          style={{ background: i < filled ? TONE_COLOR[tone] : "var(--color-line)" }}
        />
      ))}
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
      className={cx("px-frame flex items-start gap-3 px-3 py-2", className)}
      style={
        {
          "--frame": color,
          background: `color-mix(in srgb, ${color} 10%, var(--color-panel))`,
        } as CSSProperties
      }
    >
      <PixelIcon name={icon ?? (tone === "bad" ? "warn" : tone === "ok" ? "verify" : "dot")} size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && (
          <div className="font-pixel text-[9px] uppercase" style={{ color }}>
            {title}
          </div>
        )}
        {children && <div className="text-base text-text">{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** Renders any client error; 503 not_configured becomes "Backend not configured: missing X". */
export function ErrorBanner({ error, action, className }: { error: unknown; action?: ReactNode; className?: string }) {
  if (!error) return null;
  return (
    <Banner tone="bad" title="Error" action={action} className={className}>
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
    <div className={cx("flex flex-col items-center justify-center gap-2 px-4 py-8 text-center", className)}>
      <PixelIcon name={icon} size={28} className="text-faint" />
      <div className="font-pixel text-[9px] uppercase text-muted">{title}</div>
      {hint && <p className="max-w-sm text-base text-faint">{hint}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div className={cx("flex items-center justify-center gap-3 px-4 py-8", className)} role="status">
      <span className="font-pixel text-[9px] uppercase text-green">{label}</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="animate-pulse-px inline-block size-2 bg-green"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cx("animate-pulse-px bg-panel-3", className)}
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, transparent 0 6px, rgba(255,255,255,0.03) 6px 12px)",
      }}
    />
  );
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
      <span className="font-pixel text-[8px] uppercase text-muted">
        {label}
        {required && <span className="text-green"> *</span>}
      </span>
      {children}
      {hint && <span className="text-sm text-faint">{hint}</span>}
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
      <span className="font-pixel text-[8px] uppercase text-faint">{k}</span>
      <span className="min-w-0 truncate text-right text-base text-text">{v}</span>
    </div>
  );
}

/** Pretty JSON in a pixel inset box. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cx("px-inset max-h-80 overflow-auto p-3 text-base leading-tight text-green-hi", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

"use client";

// Pixel-card node components for the capability graph. Colour = status tone; work in
// progress (repairing, discovering…) pulses its frame so the text stays readable.

import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { CSSProperties, ReactNode } from "react";
import { fmtMs, fmtUsd, isPulsing, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { Badge } from "@/components/px/ui";
import {
  nodeTone,
  type CapFlowNode,
  type PatternFlowNode,
  type SiteFlowNode,
  type ToolFlowNode,
} from "./layout";

function NodeCard({
  tone,
  pulse,
  icon,
  kicker,
  badge,
  title,
  children,
}: {
  tone: Tone;
  pulse?: boolean;
  icon: IconName;
  kicker: string;
  badge?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  const color = TONE_COLOR[tone];
  return (
    <div className="group relative h-full w-full cursor-pointer" style={{ "--frame": color } as CSSProperties}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div
        className="px-panel flex h-full w-full flex-col justify-between gap-0.5 overflow-hidden px-2.5 py-2 group-hover:brightness-125"
        style={{ background: `color-mix(in srgb, ${color} 8%, var(--color-panel))` }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-pixel flex min-w-0 items-center gap-1.5 text-[7px] uppercase" style={{ color }}>
            <PixelIcon name={icon} size={10} className="shrink-0" />
            <span className="truncate">{kicker}</span>
          </span>
          {badge}
        </div>
        <div className="truncate text-lg leading-tight text-text" title={title}>
          {title}
        </div>
        {children}
      </div>
      {pulse && (
        <span
          aria-hidden
          className="animate-pulse-px pointer-events-none absolute inset-0"
          style={{ boxShadow: `0 0 0 2px ${color}, 0 0 18px ${color}, inset 0 0 14px color-mix(in srgb, ${color} 40%, transparent)` }}
        />
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  return (
    <Badge tone={nodeTone(status)} pulse={isPulsing(status)}>
      {status}
    </Badge>
  );
}

function SiteNode({ data }: NodeProps<SiteFlowNode>) {
  return (
    <NodeCard
      tone={nodeTone(data.status)}
      pulse={isPulsing(data.status)}
      icon="globe"
      kicker="site"
      badge={<StatusBadge status={data.status} />}
      title={data.label}
    >
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate text-faint">{data.slug}</span>
        <span className="shrink-0 text-muted">
          <span className="text-green">{data.verified}</span>/{data.total} tools
        </span>
      </div>
    </NodeCard>
  );
}

function CapabilityNode({ data }: NodeProps<CapFlowNode>) {
  return (
    <NodeCard
      tone={nodeTone(data.status)}
      pulse={isPulsing(data.status)}
      icon="observe"
      kicker="capability"
      badge={data.kind && <Badge tone={data.kind === "action" ? "gold" : "info"}>{data.kind}</Badge>}
      title={data.label}
    >
      <div className="truncate text-sm text-muted">{data.status ?? "observed"}</div>
    </NodeCard>
  );
}

function ToolNode({ data }: NodeProps<ToolFlowNode>) {
  const t = data.tool;
  return (
    <NodeCard
      tone={nodeTone(data.status)}
      pulse={isPulsing(data.status)}
      icon="tool"
      kicker={t ? `tool · v${t.version}` : "tool"}
      badge={<StatusBadge status={data.status} />}
      title={data.label}
    >
      {t && (
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="truncate text-muted">
            {t.best_strategy ?? "—"} · {fmtMs(t.p50_ms)}
          </span>
          {t.price_cents > 0 ? (
            <span className="shrink-0 text-gold">{fmtUsd(t.price_cents)}</span>
          ) : (
            <span className="shrink-0 text-faint">free</span>
          )}
        </div>
      )}
    </NodeCard>
  );
}

function PatternNode({ data }: NodeProps<PatternFlowNode>) {
  return (
    <NodeCard tone="violet" icon="pattern" kicker="shared pattern" title={data.label}>
      <div className="truncate text-sm text-muted">
        reused by <span className="text-violet">{data.tools}</span> tool{data.tools === 1 ? "" : "s"} ·{" "}
        {data.sites} site{data.sites === 1 ? "" : "s"}
      </div>
    </NodeCard>
  );
}

export const NODE_TYPES = {
  site: SiteNode,
  capability: CapabilityNode,
  tool: ToolNode,
  pattern: PatternNode,
} satisfies NodeTypes;

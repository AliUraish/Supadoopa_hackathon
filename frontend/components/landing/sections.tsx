// Landing sections (static): the pipeline, the three strategies, the shared brain, pricing.

import type { CSSProperties } from "react";
import { PIPELINE, STAGE_LABEL, TONE_COLOR, type Stage, type Tone } from "@/lib/doorway/format";
import type { Strategy } from "@/lib/doorway/types";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { Sprite } from "@/components/px/sprite";
import { Meter, Panel } from "@/components/px/ui";

const STEP: Record<Stage, { icon: IconName; tone: Tone; line: string }> = {
  request: { icon: "request", tone: "info", line: "An agent asks for a site and a task." },
  lookup: { icon: "lookup", tone: "info", line: "A verified tool already exists? Use it." },
  discover: { icon: "discover", tone: "info", line: "A sandbox explores the site in Chromium." },
  observe: { icon: "observe", tone: "violet", line: "Records forms, fields and network calls." },
  compile: { icon: "compile", tone: "violet", line: "Builds a typed tool, or reuses a pattern." },
  verify: { icon: "verify", tone: "ok", line: "A different sandbox replays it with test data." },
  publish: { icon: "publish", tone: "ok", line: "Listed over MCP; fastest strategy wins." },
  execute: { icon: "execute", tone: "ok", line: "Agents call it like any other tool." },
  pay: { icon: "coin", tone: "gold", line: "Actions settle via Stripe MPP." },
  heal: { icon: "heal", tone: "warn", line: "Site changed? Broken → repairing → verified." },
};

export function PipelineStrip() {
  return (
    <Panel
      title="The pipeline"
      icon="request"
      actions={<span className="hidden text-base text-faint sm:inline">each step is a live event on the dashboard</span>}
    >
      <span aria-hidden className="px-wire mb-3 block h-[2px] w-full" />
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-5 2xl:grid-cols-10">
        {PIPELINE.map((stage, i) => {
          const { icon, tone, line } = STEP[stage];
          const color = TONE_COLOR[tone];
          return (
            <li
              key={stage}
              className="px-inset flex flex-col gap-1.5 p-2.5"
              style={{ "--frame": `color-mix(in srgb, ${color} 45%, transparent)` } as CSSProperties}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel text-[8px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                <span style={{ color }}>
                  <PixelIcon name={icon} size={14} />
                </span>
              </div>
              <div className="font-pixel text-[9px] uppercase" style={{ color }}>
                {STAGE_LABEL[stage]}
              </div>
              <p className="text-sm text-muted">{line}</p>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

const STRATEGY_INFO: { id: Strategy; latency: string; ms: number; tone: Tone; line: string }[] = [
  { id: "api", latency: "~50–150 ms", ms: 150, tone: "ok", line: "Replays the site's own private JSON call, found while exploring." },
  { id: "form", latency: "~0.5–1 s", ms: 1000, tone: "info", line: "Submits the HTML form directly. No browser needed." },
  { id: "browser", latency: "~3–6 s", ms: 6000, tone: "warn", line: "Clicks through with headless Chromium. The fallback." },
];

export function Strategies({ className }: { className?: string }) {
  return (
    <Panel title="Three ways to run a tool" icon="bolt" className={className}>
      <div className="grid gap-3 sm:grid-cols-3">
        {STRATEGY_INFO.map((s) => (
          <div key={s.id} className="px-inset flex flex-col gap-2 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-pixel text-[11px] uppercase" style={{ color: TONE_COLOR[s.tone] }}>
                {s.id}
              </span>
              <span className="text-lg text-text">{s.latency}</span>
            </div>
            <Meter value={s.ms} max={6000} segments={24} tone={s.tone} />
            <p className="text-base text-muted">{s.line}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-base text-faint">
        <span className="text-green">▸</span> When a tool is verified the optimizer tries all three and keeps the
        fastest one that passes. If the site changes, it falls back and heals.
      </p>
    </Panel>
  );
}

const BRAIN: { icon: IconName; title: string; line: string }[] = [
  {
    icon: "sandbox",
    title: "Job queue",
    line: "discover · verify · heal · optimize · race, claimed with FOR UPDATE SKIP LOCKED. Verify always runs on a different sandbox.",
  },
  {
    icon: "pattern",
    title: "Patterns",
    line: "slot_booking (list slots → book with name + phone) is learned once; other booking sites reuse it.",
  },
  {
    icon: "message",
    title: "Message board",
    line: "hello · tool_published · pattern_published · need_tool · validated · broken.",
  },
  { icon: "graph", title: "Realtime", line: "Every row streams to the dashboard as it happens." },
];

export function SharedBrain({ className }: { className?: string }) {
  return (
    <Panel title="Sandboxes share one brain" icon="database" className={className}>
      <div className="flex flex-col gap-4">
        <p className="text-base text-muted">
          Isolated Chromium workers on <span className="text-text">Supabase Compute</span>. They coordinate only
          through one Postgres:
        </p>
        <div className="flex items-center gap-3">
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((n) => (
              <div key={n} className="flex items-center gap-2">
                <Sprite name="sandbox" scale={2} />
                <span className="font-pixel text-[7px] uppercase text-faint">sandbox-{n}</span>
              </div>
            ))}
          </div>
          <div aria-hidden className="flex flex-1 flex-col justify-around gap-7 self-stretch py-3">
            {[0, 1, 2].map((i) => (
              <span key={i} className="px-wire block h-[2px] w-full" style={{ animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Sprite name="database" scale={4} className="drop-shadow-[0_0_10px_rgba(62,207,142,0.5)]" />
            <span className="font-pixel text-[7px] uppercase text-green">postgres</span>
          </div>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {BRAIN.map((b) => (
            <li key={b.title} className="flex gap-2">
              <PixelIcon name={b.icon} size={14} className="mt-1 shrink-0 text-green" />
              <div>
                <div className="font-pixel text-[8px] uppercase text-text">{b.title}</div>
                <p className="text-sm text-muted">{b.line}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

export function PayPerCall({ className }: { className?: string }) {
  return (
    <Panel title="Pay per call" icon="coin" tone="gold" className={className}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <Sprite name="coin" scale={5} className="drop-shadow-[0_0_10px_rgba(247,208,70,0.45)]" />
          <div>
            <div className="font-pixel text-[24px] leading-none text-gold">$0.50</div>
            <div className="mt-1 text-base text-muted">per successful action call</div>
          </div>
        </div>
        <ul className="flex flex-col gap-1 text-base text-muted">
          <li>
            <span className="text-gold">▸</span> Actions (book, reserve) settle via <span className="text-text">Stripe MPP</span>
          </li>
          <li>
            <span className="text-gold">▸</span> HTTP <code className="text-text">402</code> → pay → retry, no account needed
          </li>
          <li>
            <span className="text-gold">▸</span> Reads (list slots, search) are <span className="text-green">free</span>
          </li>
          <li>
            <span className="text-gold">▸</span> Everything runs in Stripe test mode
          </li>
        </ul>
      </div>
    </Panel>
  );
}

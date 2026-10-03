// Landing hero: the big glowing door, the one-line pitch and the two ways in.

import type { CSSProperties } from "react";
import { Sprite, type SpriteName } from "@/components/px/sprite";
import { ButtonLink } from "@/components/px/ui";

function Figure({ sprite, label }: { sprite: SpriteName; label: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5">
      <Sprite name={sprite} scale={3} />
      <span className="font-pixel text-[7px] uppercase text-muted">{label}</span>
    </div>
  );
}

function Wire({ label }: { label: string }) {
  return (
    <div className="flex min-w-10 flex-1 flex-col items-center gap-1.5 pb-4">
      <span className="font-pixel text-center text-[7px] uppercase text-faint">{label}</span>
      <span className="px-wire block h-[2px] w-full" />
    </div>
  );
}

export function Hero() {
  return (
    <section className="px-panel relative overflow-hidden">
      <div className="grid items-center gap-8 p-6 md:grid-cols-[1fr_auto] md:p-10">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="font-pixel text-[9px] uppercase text-muted">
            <span className="animate-blink mr-2 inline-block size-2 bg-green" />
            websites with no API → paid MCP tools
          </div>
          <h1
            className="font-pixel text-[40px] leading-none text-green sm:text-[64px]"
            style={{ textShadow: "0 0 22px rgba(62,207,142,0.65), 0 0 2px rgba(140,255,198,0.9)" }}
          >
            DOORWAY
          </h1>
          <p className="max-w-2xl text-2xl text-text">
            Every website becomes a verified, self-healing MCP tool that agents call — and pay for — per call.
          </p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/dashboard" size="lg" icon="execute">
              Open dashboard
            </ButtonLink>
            <ButtonLink href="#connect" size="lg" variant="ghost" icon="agent">
              Connect your agent
            </ButtonLink>
          </div>
          <div className="mt-2 flex max-w-xl items-end gap-2">
            <Figure sprite="agent" label="your agent" />
            <Wire label="mcp call" />
            <Figure sprite="door" label="doorway" />
            <Wire label="api · form · browser" />
            <Figure sprite="browser" label="any website" />
          </div>
        </div>

        <div className="relative order-first grid place-items-center px-8 py-4 md:order-none">
          <div
            aria-hidden
            className="animate-pulse-px absolute inset-[-20%]"
            style={
              {
                background: "radial-gradient(closest-side, rgba(62,207,142,0.32), transparent)",
                animationDuration: "2.8s",
              } as CSSProperties
            }
          />
          <Sprite
            name="door"
            scale={10}
            title="Doorway"
            className="relative drop-shadow-[0_0_22px_rgba(62,207,142,0.6)]"
          />
          <div
            aria-hidden
            className="relative h-5 w-[180px]"
            style={{
              background: "linear-gradient(to bottom, rgba(140,255,198,0.35), transparent)",
              clipPath: "polygon(11% 0, 89% 0, 100% 100%, 0 100%)",
            }}
          />
        </div>
      </div>
    </section>
  );
}

"use client";

// Left of the workspace: your agent, a pixel robot at its desk. It bobs while idle and
// talks/types while a request runs; its bubble echoes the agent-side events.

import type { IconName } from "@/components/px/icons";
import { cx } from "@/components/px/ui";
import type { Tone } from "@/lib/doorway/format";
import { IdleScreen, RoomLabel, ScreenSprite, SpeechBubble, StaticSprite, TypingLines } from "./scene-bits";
import { AGENT_BLINK, AGENT_TALK, DESK, MONITOR, MONITOR_SCREEN } from "./sprites";
import styles from "./workspace.module.css";

export interface AgentBubble {
  key: number;
  icon: IconName;
  tone: Tone;
  text: string;
}

function ThinkingDots() {
  return (
    <span className="absolute -right-8 top-0 flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className={cx("block size-[6px] bg-green-hi", styles.dot)} style={{ animationDelay: `${i * 0.3}s` }} />
      ))}
    </span>
  );
}

export function AgentDesk({ thinking, bubble }: { thinking: boolean; bubble: AgentBubble | null }) {
  return (
    <div className={cx(styles.wall, "relative h-[210px]")}>
      <div className="absolute inset-x-3 top-2">
        <RoomLabel
          icon="agent"
          title="Your agent"
          sub={thinking ? "working on your task…" : "idle · ready for a task"}
          right={
            <span
              className={cx("font-pixel text-[8px] uppercase", thinking ? "animate-pulse-px text-blue" : "text-faint")}
            >
              {thinking ? "busy" : "idle"}
            </span>
          }
        />
      </div>
      <div className={cx(styles.floor, "absolute inset-x-0 bottom-0 h-[10px]")} />
      <div className="absolute bottom-[10px] left-[6%] flex items-end gap-5">
        <div className={cx("relative", thinking ? styles.bobFast : styles.bob)}>
          {bubble && (
            <SpeechBubble key={bubble.key} tone={bubble.tone} icon={bubble.icon} short align="left">
              {bubble.text}
            </SpeechBubble>
          )}
          <StaticSprite name="agent" scale={6} title="Your agent" />
          <StaticSprite map={AGENT_BLINK} scale={6} className={cx("absolute inset-0", styles.blink)} />
          {thinking && <StaticSprite map={AGENT_TALK} scale={6} className={cx("absolute inset-0", styles.talk)} />}
          {thinking && <ThinkingDots />}
        </div>
        <div className="flex flex-col items-center">
          <ScreenSprite map={MONITOR} scale={4} screen={MONITOR_SCREEN} anchor="agent">
            {thinking ? <TypingLines /> : <IdleScreen />}
          </ScreenSprite>
          <StaticSprite map={DESK} scale={4} />
        </div>
      </div>
    </div>
  );
}

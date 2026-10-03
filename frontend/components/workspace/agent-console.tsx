"use client";

// "Ask your agent": pick a site, type a task, and watch the conversation
// YOU → AGENT → DOORWAY → (sandboxes) → result, as pixel chat bubbles.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { describeError, type DoorwayEvent, type Message, type Site } from "@/lib/doorway";
import { eventStyle, fmtMs, messageSummary, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useDashboardNav } from "@/components/dashboard/dashboard-tabs";
import { PixelIcon, type IconName } from "@/components/px/icons";
import { SPRITES } from "@/components/px/sprite";
import { Button, cx, Empty, ErrorBanner, Input, JsonBlock, Panel, Select } from "@/components/px/ui";
import { paymentInfo, summarizeResult, timelineFor, truncate, type TimelineItem } from "./flow";
import { StaticSprite } from "./scene-bits";
import { isSettled, type AgentChat, type Exchange } from "./use-agent-chat";

const PRESETS = [
  { task: "Book the earliest available appointment", match: /clinic|vet|doctor|dent|health/i },
  { task: "Reserve a table for 2 tonight", match: /bistro|restaurant|cafe|diner|grill|kitchen/i },
  { task: "Find books about Ada Lovelace", match: /librar|book/i },
];

function Bubble({
  who,
  icon,
  tone,
  side = "left",
  indent,
  children,
}: {
  who: string;
  icon: IconName;
  tone: Tone;
  side?: "left" | "right";
  indent?: boolean;
  children: ReactNode;
}) {
  const color = TONE_COLOR[tone];
  return (
    <div className={cx("flex max-w-[92%] flex-col gap-1", side === "right" ? "self-end items-end" : "self-start", indent && "ml-5")}>
      <span className="font-pixel flex items-center gap-1.5 text-[8px] uppercase" style={{ color }}>
        <PixelIcon name={icon} size={10} />
        {who}
      </span>
      <div
        className="px-frame px-2.5 py-1.5 text-base leading-tight text-text"
        style={{ ["--frame" as string]: color, background: `color-mix(in srgb, ${color} 9%, var(--color-panel))` }}
      >
        {children}
      </div>
    </div>
  );
}

function WorkingDots() {
  return (
    <span className="inline-flex gap-1 align-middle" aria-label="working">
      {[0, 1, 2].map((i) => (
        <span key={i} className="animate-pulse-px inline-block size-2 bg-green" style={{ animationDelay: `${i * 0.2}s` }} />
      ))}
    </span>
  );
}

function ProgressLine({ event }: { event: DoorwayEvent }) {
  const style = eventStyle(event.kind);
  const color = TONE_COLOR[style.tone];
  return (
    <li className="px-rise flex items-start gap-2 text-sm leading-tight">
      <span className="pt-0.5" style={{ color }}>
        <PixelIcon name={style.icon} size={10} />
      </span>
      <span className="min-w-0">
        <span className="font-pixel mr-1.5 text-[8px] uppercase" style={{ color }}>
          {event.kind}
        </span>
        {event.sandbox_id && <span className="mr-1.5 text-violet">{event.sandbox_id}</span>}
        <span className="text-muted">{truncate(event.message, 90)}</span>
      </span>
    </li>
  );
}

function agentLine(x: Exchange): ReactNode {
  if (x.phase === "sending") return <>contacting Doorway <WorkingDots /></>;
  if (x.tool && x.siteId) {
    return (
      <>
        calling <code className="text-green-hi">{`${x.siteId}__${x.tool.name}`}</code>
      </>
    );
  }
  if (x.phase === "discovering") return "no tool yet, asking Doorway to discover it";
  if (x.phase === "error" && !x.requestId) return "couldn't reach Doorway";
  return "asking Doorway for the right tool";
}

function Result({ x }: { x: Exchange }) {
  if (x.phase === "error") {
    return (
      <Bubble who="Doorway → agent" icon="warn" tone="bad">
        {describeError(x.error)}
      </Bubble>
    );
  }
  if (x.timedOut) {
    return (
      <Bubble who="Doorway → agent" icon="clock" tone="warn">
        Still running after 90 s, so I stopped watching. Follow it in the workflow log.
      </Bubble>
    );
  }
  const final = x.final;
  // Polls store every answer; only a finished request gets a result bubble.
  if (!final || (final.status !== "done" && final.status !== "failed")) return null;
  if (final.status === "failed") {
    return (
      <Bubble who="Doorway → agent" icon="broken" tone="bad">
        {final.error || "Doorway couldn't finish this task."}
      </Bubble>
    );
  }
  const pay = paymentInfo(final, x.tool);
  const lines = summarizeResult(final.result);
  const run = final.run;
  return (
    <Bubble who="Doorway → agent" icon="verify" tone={pay?.kind === "required" ? "gold" : "ok"}>
      <div className="flex flex-col gap-1">
        <div className="font-pixel flex flex-wrap items-center gap-x-2 text-[8px] uppercase text-green">
          <span>✓ done</span>
          {run?.strategy && <span className="text-muted">{run.strategy}</span>}
          {run?.ms !== null && run?.ms !== undefined && <span className="text-muted">{fmtMs(run.ms)}</span>}
        </div>
        {pay?.kind === "required" && (
          <div className="flex items-start gap-2 text-gold">
            <StaticSprite map={SPRITES.coin} scale={2} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-all">
              Payment required: {pay.amount} →{" "}
              <a href={pay.link} target="_blank" rel="noreferrer" className="underline">
                {pay.link}
              </a>
            </span>
          </div>
        )}
        {pay?.kind !== "required" &&
          lines.map((line, i) => (
            <span key={i} className="break-words">
              {line}
            </span>
          ))}
        {pay?.kind === "paid" && (
          <span className="flex items-center gap-2 text-gold">
            <StaticSprite map={SPRITES.coin} scale={2} />
            {pay.amount} paid · {pay.reference}
          </span>
        )}
        {final.result !== undefined && final.result !== null && (
          <details className="text-sm text-muted">
            <summary className="cursor-pointer hover:text-green">raw result</summary>
            <JsonBlock value={final.result} className="mt-1 max-h-48 text-sm" />
          </details>
        )}
      </div>
    </Bubble>
  );
}

function ExchangeView({ x, timeline }: { x: Exchange; timeline: TimelineItem[] }) {
  const settled = isSettled(x);
  const shown = timeline.slice(-8);
  return (
    <li className="flex flex-col gap-2 border-b border-line/60 pb-3 last:border-0">
      <Bubble who="You → agent" icon="user" tone="ok" side="right">
        on <span className="text-green-hi">{x.siteName}</span>, {x.task}
      </Bubble>
      <Bubble who="Agent → Doorway" icon="agent" tone="info">
        {agentLine(x)}
      </Bubble>
      {timeline.length > shown.length && (
        <span className="ml-5 text-sm text-faint">… {timeline.length - shown.length} earlier steps</span>
      )}
      {shown.length > 0 && (
        <ol className="ml-5 flex flex-col gap-1 border-l-2 border-line-2 pl-3">
          {shown.map((item) =>
            item.type === "event" ? (
              <ProgressLine key={item.key} event={item.event} />
            ) : (
              <li key={item.key} className="list-none">
                <Bubble
                  who={`${item.message.from_sandbox} → ${item.message.to_sandbox ?? "all"}`}
                  icon="lookup"
                  tone="violet"
                >
                  ? need_tool · {messageSummary(item.message.body)}
                </Bubble>
              </li>
            ),
          )}
        </ol>
      )}
      {!settled && (
        <Bubble who="Doorway" icon="door" tone="muted" indent>
          working <WorkingDots />
        </Bubble>
      )}
      <Result x={x} />
    </li>
  );
}

export function AgentConsole({
  chat,
  sites,
  sitesLoading,
  sitesError,
  events,
  messages,
}: {
  chat: AgentChat;
  sites: Site[] | undefined;
  sitesLoading: boolean;
  sitesError: unknown;
  events: DoorwayEvent[];
  messages: Message[];
}) {
  const { goTo } = useDashboardNav();
  const [siteId, setSiteId] = useState("");
  const [task, setTask] = useState("");
  const list = sites ?? [];
  const site = list.find((s) => s.id === siteId) ?? list[0];
  const scroller = useRef<HTMLDivElement | null>(null);

  const timelines = chat.exchanges.map((x) => timelineFor(x, events, messages));
  const signature = chat.exchanges.map((x, i) => `${x.id}:${x.phase}:${timelines[i].length}`).join("|");

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [signature]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = task.trim();
    if (!site || !text || chat.busy) return;
    chat.send(site, text);
    setTask("");
  };

  const pickPreset = (preset: (typeof PRESETS)[number]) => {
    setTask(preset.task);
    const match = list.find((s) => preset.match.test(`${s.id} ${s.name} ${s.goal ?? ""}`));
    if (match) setSiteId(match.id);
  };

  return (
    <Panel
      title="Ask your agent"
      icon="agent"
      bodyClassName="flex flex-col gap-3 p-0"
      actions={
        chat.exchanges.some(isSettled) ? (
          <Button size="sm" variant="ghost" onClick={chat.clear}>
            Clear
          </Button>
        ) : undefined
      }
    >
      <div ref={scroller} className="max-h-[420px] min-h-[180px] overflow-y-auto px-3 pt-3">
        {chat.exchanges.length ? (
          <ol className="flex flex-col gap-3">
            {chat.exchanges.map((x, i) => (
              <ExchangeView key={x.id} x={x} timeline={timelines[i]} />
            ))}
          </ol>
        ) : (
          <Empty
            icon="agent"
            title="Give your agent a task"
            hint="It asks Doorway, which finds a verified tool (or has a sandbox build one), runs it and charges $0.50 for actions."
          />
        )}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2 border-t-2 border-line px-3 pb-3 pt-3">
        {sitesError && !list.length ? <ErrorBanner error={sitesError} /> : null}
        {!sitesLoading && !sitesError && !list.length ? (
          <Empty
            icon="site"
            title="No sites yet"
            hint="Add a website first; Doorway turns it into tools."
            action={
              <Button size="sm" icon="plus" onClick={() => goTo("sites")}>
                Add a site
              </Button>
            }
            className="py-3"
          />
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.task}
              type="button"
              onClick={() => pickPreset(p)}
              className="px-frame bg-bg-2 px-2 py-0.5 text-sm text-muted hover:text-green"
            >
              {p.task}
            </button>
          ))}
        </div>
        <Select
          aria-label="Website"
          value={site?.id ?? ""}
          onChange={(e) => setSiteId(e.target.value)}
          disabled={!list.length}
        >
          {sitesLoading && <option value="">Loading sites…</option>}
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.base_url}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Input
            aria-label="Task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Book the earliest available appointment"
            className="min-w-0 flex-1"
          />
          <Button type="submit" icon="request" loading={chat.busy} disabled={!site || !task.trim()}>
            Send
          </Button>
        </div>
      </form>
    </Panel>
  );
}

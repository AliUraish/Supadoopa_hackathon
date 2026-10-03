"use client";

// "Ask your agent": pick a site, type a task, and follow the exchange
// you → agent → Doorway → (sandboxes) → result.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { describeError, type DoorwayEvent, type Message, type Site } from "@/lib/doorway";
import { eventStyle, fmtMs, messageSummary, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useDashboardNav } from "@/components/dashboard/dashboard-tabs";
import { Icon, type IconName } from "@/components/px/icons";
import { Button, cx, Empty, ErrorBanner, Input, JsonBlock, Panel, Select, Spinner } from "@/components/px/ui";
import { paymentInfo, summarizeResult, timelineFor, truncate, type TimelineItem } from "./flow";
import { isSettled, type AgentChat, type Exchange } from "./use-agent-chat";

const PRESETS = [
  { task: "Book the earliest available appointment", match: /clinic|vet|doctor|dent|health/i },
  { task: "Reserve a table for 2 tonight", match: /bistro|restaurant|cafe|diner|grill|kitchen/i },
  { task: "Find books about Ada Lovelace", match: /librar|book/i },
];

function Rise({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function Who({ icon, children, tone = "muted" }: { icon: IconName; children: ReactNode; tone?: Tone }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-faint">
      <Icon name={icon} size={12} style={{ color: TONE_COLOR[tone] }} />
      {children}
    </span>
  );
}

/** A message from the agent or Doorway (left). */
function AgentMsg({
  who,
  icon,
  tone = "muted",
  children,
  className,
}: {
  who: string;
  icon: IconName;
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Rise className={cx("flex max-w-[92%] flex-col gap-1 self-start", className)}>
      <Who icon={icon} tone={tone}>
        {who}
      </Who>
      <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] leading-snug text-text">{children}</div>
    </Rise>
  );
}

function ProgressLine({ event }: { event: DoorwayEvent }) {
  const style = eventStyle(event.kind);
  return (
    <li className="flex items-start gap-2 text-xs leading-snug animate-rise">
      <Icon name={style.icon} size={13} className="mt-px shrink-0" style={{ color: TONE_COLOR[style.tone] }} />
      <span className="min-w-0">
        <span className="mr-1.5 font-mono text-[11px] text-muted">{event.kind}</span>
        {event.sandbox_id && <span className="mr-1.5 font-mono text-[11px] text-violet">{event.sandbox_id}</span>}
        <span className="text-faint">{truncate(event.message, 90)}</span>
      </span>
    </li>
  );
}

function agentLine(x: Exchange): ReactNode {
  if (x.phase === "sending") {
    return (
      <span className="flex items-center gap-2 text-muted">
        <Spinner size={12} /> Contacting Doorway
      </span>
    );
  }
  if (x.tool && x.siteId) {
    return (
      <>
        Calling <code className="font-mono text-[12px] text-green">{`${x.siteId}__${x.tool.name}`}</code>
      </>
    );
  }
  if (x.phase === "discovering") return "No tool yet. Asking Doorway to discover it.";
  if (x.phase === "error" && !x.requestId) return "Couldn't reach Doorway.";
  return "Asking Doorway for the right tool.";
}

function ResultCard({ x }: { x: Exchange }) {
  if (x.phase === "error") {
    return (
      <AgentMsg who="Doorway" icon="warn" tone="bad">
        <span className="text-red">{describeError(x.error)}</span>
      </AgentMsg>
    );
  }
  if (x.timedOut) {
    return (
      <AgentMsg who="Doorway" icon="clock" tone="warn">
        Still running after 90 s, so the console stopped watching. Follow it in the workflow log.
      </AgentMsg>
    );
  }
  const final = x.final;
  // Polls store every answer; only a finished request gets a result card.
  if (!final || (final.status !== "done" && final.status !== "failed")) return null;
  if (final.status === "failed") {
    return (
      <AgentMsg who="Doorway" icon="broken" tone="bad">
        {final.error || "Doorway couldn't finish this task."}
      </AgentMsg>
    );
  }
  const pay = paymentInfo(final, x.tool);
  const lines = summarizeResult(final.result);
  const run = final.run;
  return (
    <Rise className="flex max-w-[92%] flex-col gap-1 self-start">
      <Who icon="door" tone="ok">
        Doorway
      </Who>
      <div className="overflow-hidden rounded-lg border border-line bg-panel-2 text-[13px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-green">
            <Icon name="verify" size={13} /> Done
          </span>
          {run?.strategy && (
            <span className="text-faint">
              strategy <span className="font-mono text-muted">{run.strategy}</span>
            </span>
          )}
          {run?.ms !== null && run?.ms !== undefined && (
            <span className="font-mono tabular-nums text-muted">{fmtMs(run.ms)}</span>
          )}
          {pay?.kind === "paid" && (
            <span className="font-mono text-gold">
              {pay.amount} paid · {pay.reference}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1 px-3 py-2 leading-snug text-text">
          {pay?.kind === "required" ? (
            <div className="flex items-start gap-2 text-gold">
              <Icon name="coin" size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-all">
                Payment required <span className="font-mono">{pay.amount}</span> →{" "}
                <a href={pay.link} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-text">
                  {pay.link}
                </a>
              </span>
            </div>
          ) : (
            lines.map((line, i) => (
              <span key={i} className="break-words">
                {line}
              </span>
            ))
          )}
          {final.result !== undefined && final.result !== null && (
            <details className="text-xs text-faint">
              <summary className="cursor-pointer select-none hover:text-muted">Raw result</summary>
              <JsonBlock value={final.result} className="mt-1.5 max-h-48" />
            </details>
          )}
        </div>
      </div>
    </Rise>
  );
}

function ExchangeView({ x, timeline }: { x: Exchange; timeline: TimelineItem[] }) {
  const settled = isSettled(x);
  const shown = timeline.slice(-8);
  return (
    <li className="flex flex-col gap-2.5 border-b border-line pb-4 last:border-0 last:pb-0">
      <Rise className="flex max-w-[85%] flex-col items-end gap-1 self-end">
        <Who icon="user">You</Who>
        <div className="rounded-lg bg-panel-3 px-3 py-2 text-[13px] leading-snug text-text">
          <span className="text-muted">{x.siteName}:</span> {x.task}
        </div>
      </Rise>
      <AgentMsg who="Agent" icon="agent" tone="info">
        {agentLine(x)}
      </AgentMsg>
      {timeline.length > shown.length && (
        <span className="ml-3 text-xs text-faint">{timeline.length - shown.length} earlier steps</span>
      )}
      {shown.length > 0 && (
        <ol className="ml-3 flex flex-col gap-1.5 border-l border-line-2 pl-3">
          {shown.map((item) =>
            item.type === "event" ? (
              <ProgressLine key={item.key} event={item.event} />
            ) : (
              <li key={item.key} className="flex items-start gap-2 text-xs leading-snug animate-rise">
                <Icon name="lookup" size={13} className="mt-px shrink-0 text-violet" />
                <span className="min-w-0">
                  <span className="mr-1.5 font-mono text-[11px] text-violet">
                    {item.message.from_sandbox} → {item.message.to_sandbox ?? "all"}
                  </span>
                  <span className="mr-1.5 font-mono text-[11px] text-muted">need_tool</span>
                  <span className="text-faint">{messageSummary(item.message.body)}</span>
                </span>
              </li>
            ),
          )}
        </ol>
      )}
      {!settled && (
        <span className="ml-3 flex items-center gap-2 text-xs text-faint">
          <Spinner size={11} /> Doorway is working
        </span>
      )}
      <ResultCard x={x} />
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
  className,
}: {
  chat: AgentChat;
  sites: Site[] | undefined;
  sitesLoading: boolean;
  sitesError: unknown;
  events: DoorwayEvent[];
  messages: Message[];
  className?: string;
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
      className={className}
      bodyClassName="flex flex-col p-0!"
      actions={
        chat.exchanges.some(isSettled) ? (
          <Button size="sm" variant="ghost" onClick={chat.clear}>
            Clear
          </Button>
        ) : undefined
      }
    >
      <div ref={scroller} className="max-h-[440px] min-h-[200px] flex-1 overflow-y-auto p-4">
        {chat.exchanges.length ? (
          <ol className="flex flex-col gap-4">
            {chat.exchanges.map((x, i) => (
              <ExchangeView key={x.id} x={x} timeline={timelines[i]} />
            ))}
          </ol>
        ) : (
          <Empty
            icon="agent"
            title="Give your agent a task"
            hint="It asks Doorway, which finds a verified tool (or has a sandbox build one), runs it, and charges $0.50 for actions."
          />
        )}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2.5 border-t border-line p-4">
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
              className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-muted transition-colors hover:border-line-2 hover:text-text"
            >
              {p.task}
            </button>
          ))}
        </div>
        <Select aria-label="Website" value={site?.id ?? ""} onChange={(e) => setSiteId(e.target.value)} disabled={!list.length}>
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

"use client";

// The Workspace tab: a pixel control room seen from the side. Your agent (left) talks to the
// Doorway broker (centre, with its live pipeline), which hands jobs to Supabase Compute
// sandboxes (right) that share memory in Postgres. Wires carry a packet for every live event.
// Data hooks and the chat live here so they survive tab switches; the scene only renders
// (and animates) while the tab is active.

import { useState } from "react";
import {
  doorway,
  type DoorwayEvent,
  type Job,
  type Message,
  type Pattern,
  type RowChange,
  type Sandbox,
  type Site,
} from "@/lib/doorway";
import { eventStyle, MESSAGE_STYLE, messageSummary, stageForEvent, timeAgo, type Stage } from "@/lib/doorway/format";
import { useFeed, useLive, useNow, type FeedResult, type LiveResult } from "@/lib/doorway/live";
import { EventFeed, MessageBoard } from "@/components/feeds/event-feed";
import { ConnectAgent } from "@/components/connect-agent";
import { LiveBadge } from "@/components/px/client";
import { cx, StatusDot } from "@/components/px/ui";
import { AgentConsole } from "./agent-console";
import { AgentDesk, type AgentBubble } from "./agent-desk";
import { ComputeRoom, type SandboxBubble } from "./compute-room";
import { CurrentEvent, DoorScene, Pipeline, type StageHit } from "./doorway-column";
import { packetForEvent, packetForMessage, patternIdOf, truncate, type PacketSpec } from "./flow";
import { useAgentChat, type AgentChat } from "./use-agent-chat";
import { computeRoutes, useStageLayout, WireOverlay, type WireSpec } from "./wires";
import styles from "./workspace.module.css";

const AGENT_KINDS = new Set(["request.received", "execute.call", "payment.challenge", "payment.paid"]);

function patternChange(c: RowChange): boolean {
  if (c.table === "doorway_messages") return (c.row as Message).kind === "pattern_published";
  const kind = (c.row as DoorwayEvent).kind;
  return kind === "reuse.pattern" || kind === "publish.tool";
}

export function WorkspaceTab({ active }: { active: boolean }) {
  const sites = useLive("ws:sites", () => doorway.sites(), { tables: ["doorway_tools"] });
  const sandboxes = useLive("ws:sandboxes", () => doorway.sandboxes(), {
    tables: ["doorway_sandboxes", "doorway_jobs"],
  });
  const jobs = useLive("ws:jobs", () => doorway.jobs(), { tables: ["doorway_jobs"] });
  const patterns = useLive("ws:patterns", () => doorway.patterns(), {
    tables: ["doorway_messages", "doorway_events"],
    filter: patternChange,
    debounceMs: 500,
  });
  const events = useFeed<DoorwayEvent>("ws:events", (since) => doorway.events({ since }), {
    table: "doorway_events",
    limit: 150,
  });
  const messages = useFeed<Message>("ws:messages", (since) => doorway.messages(since), {
    table: "doorway_messages",
    limit: 80,
  });
  const chat = useAgentChat(events.items[0]?.id ?? 0, messages.items[0]?.id ?? 0);

  if (!active) return null;
  return (
    <div className="flex flex-col gap-4">
      <WorkspaceScene
        sites={sites}
        sandboxes={sandboxes}
        jobs={jobs}
        patterns={patterns}
        events={events}
        messages={messages}
        chat={chat}
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <EventFeed title="Workflow log" bodyClassName="max-h-[260px]" />
        <MessageBoard title="Sandbox message board" bodyClassName="max-h-[260px]" />
      </div>
    </div>
  );
}

function StatusLine({
  sandboxes,
  jobs,
  latest,
}: {
  sandboxes: Sandbox[] | undefined;
  jobs: Job[] | undefined;
  latest: DoorwayEvent | undefined;
}) {
  const now = useNow();
  const list = sandboxes ?? [];
  const online = list.filter((s) => s.status !== "offline").length;
  const running = jobs ? jobs.filter((j) => j.status === "running").length : list.filter((s) => s.status === "busy").length;
  const queued = jobs ? jobs.filter((j) => j.status === "queued").length : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b-2 border-line bg-panel-2 px-3 py-2">
      <span className="font-pixel flex items-center gap-2 text-[9px] uppercase text-text">
        <StatusDot tone={online ? "ok" : "bad"} size={8} pulse={running > 0} />
        {online}/{list.length} sandboxes online
      </span>
      <span className="text-base text-muted">
        <span className="text-blue">{running}</span> job{running === 1 ? "" : "s"} running
        {queued !== null && (
          <>
            {" · "}
            <span className="text-text">{queued}</span> queued
          </>
        )}
      </span>
      <span className="text-base text-muted" suppressHydrationWarning>
        last event {latest && now ? timeAgo(latest.created_at, now) : "—"}
      </span>
      <LiveBadge className="ml-auto" />
    </div>
  );
}

type Base = { e: number | null; m: number | null };

function WorkspaceScene({
  sites,
  sandboxes,
  jobs,
  patterns,
  events,
  messages,
  chat,
}: {
  sites: LiveResult<Site[]>;
  sandboxes: LiveResult<Sandbox[]>;
  jobs: LiveResult<Job[]>;
  patterns: LiveResult<Pattern[]>;
  events: FeedResult<DoorwayEvent>;
  messages: FeedResult<Message>;
  chat: AgentChat;
}) {
  const ev = events.items;
  const msgs = messages.items;

  // Only rows that arrive after the scene mounts animate (no burst of history on load).
  const [base, setBase] = useState<Base>(() => ({
    e: events.loading ? null : (ev[0]?.id ?? 0),
    m: messages.loading ? null : (msgs[0]?.id ?? 0),
  }));
  if ((base.e === null && !events.loading) || (base.m === null && !messages.loading)) {
    setBase({
      e: base.e ?? (events.loading ? null : (ev[0]?.id ?? 0)),
      m: base.m ?? (messages.loading ? null : (msgs[0]?.id ?? 0)),
    });
  }
  const freshEvents = base.e === null ? [] : ev.filter((e) => e.id > (base.e ?? 0)).slice(0, 40);
  const freshMessages = base.m === null ? [] : msgs.filter((m) => m.id > (base.m ?? 0)).slice(0, 20);

  // Pipeline: the latest staged event glows; stages hit since mount fade out.
  const latestStaged = ev.find((e) => stageForEvent(e.kind));
  const current = latestStaged
    ? { stage: stageForEvent(latestStaged.kind) as Stage, tone: eventStyle(latestStaged.kind).tone }
    : null;
  const hits: Partial<Record<Stage, StageHit>> = {};
  for (const e of freshEvents) {
    const stage = stageForEvent(e.kind);
    if (stage && !hits[stage]) hits[stage] = { key: e.id, tone: eventStyle(e.kind).tone };
  }
  const counts: Partial<Record<Stage, number>> = {};
  for (const e of ev) {
    const stage = stageForEvent(e.kind);
    if (stage) counts[stage] = (counts[stage] ?? 0) + 1;
  }

  // Speech bubbles: the agent echoes agent-side events, sandboxes say their latest message.
  const agentEvent = freshEvents.find((e) => AGENT_KINDS.has(e.kind));
  const agentBubble: AgentBubble | null = agentEvent
    ? {
        key: agentEvent.id,
        icon: eventStyle(agentEvent.kind).icon,
        tone: eventStyle(agentEvent.kind).tone,
        text: truncate(agentEvent.message, 60),
      }
    : null;
  const bubbles: Record<string, SandboxBubble> = {};
  for (const m of freshMessages) {
    if (bubbles[m.from_sandbox]) continue;
    const style = MESSAGE_STYLE[m.kind] ?? MESSAGE_STYLE.hello;
    bubbles[m.from_sandbox] = {
      key: m.id,
      icon: style.icon,
      tone: style.tone,
      text: `${style.label} ${truncate(messageSummary(m.body), 40)} → ${m.to_sandbox ?? "all"}`,
    };
  }
  const flashRow = [...freshEvents, ...freshMessages]
    .map((r) => ({ id: r.id, pid: patternIdOf(r) }))
    .find((r) => r.pid !== null);
  const patternFlash = flashRow && flashRow.pid !== null ? { patternId: flashRow.pid, key: flashRow.id } : null;

  // Wires + packets.
  const sbList = sandboxes.data ?? [];
  const sbIds = sbList.map((s) => s.id);
  const { ref, layout } = useStageLayout(`${sbIds.join(",")}|${sandboxes.loading}`);
  const routes = computeRoutes(layout, sbIds);
  const [done, setDone] = useState<string[]>([]);
  const packets: PacketSpec[] = [
    ...freshEvents.slice(0, 10).map(packetForEvent),
    ...freshMessages.slice(0, 6).map(packetForMessage),
  ].filter((p): p is PacketSpec => p !== null && routes.has(p.route) && !done.includes(p.key));
  const recentRoutes = new Set(packets.map((p) => p.route));
  const wires: WireSpec[] = [
    { id: "agent>door", state: chat.busy || recentRoutes.has("agent>door") ? "hot" : "idle" },
    ...sbList.flatMap((s): WireSpec[] => {
      const state = s.status === "offline" ? "dead" : s.status === "busy" ? "hot" : "idle";
      return [
        { id: `door>sb:${s.id}`, state: state === "idle" && recentRoutes.has(`door>sb:${s.id}`) ? "hot" : state },
        { id: `sb:${s.id}>db`, state: state === "idle" && recentRoutes.has(`sb:${s.id}>db`) ? "hot" : state },
      ];
    }),
  ];

  return (
    <section
      ref={ref}
      aria-label="Workspace"
      className={cx(styles.stage, "px-panel relative isolate flex flex-col")}
    >
      <StatusLine sandboxes={sandboxes.data} jobs={jobs.data} latest={ev[0]} />
      <div className="grid gap-6 p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,30fr)_minmax(0,22fr)_minmax(0,48fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <AgentDesk thinking={chat.busy} bubble={agentBubble} />
          <AgentConsole
            chat={chat}
            sites={sites.data}
            sitesLoading={sites.loading}
            sitesError={sites.error}
            events={ev}
            messages={msgs}
          />
          <ConnectAgent />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <DoorScene flashKey={freshEvents[0]?.id ?? null} flashTone={freshEvents[0] ? eventStyle(freshEvents[0].kind).tone : "ok"} />
          <Pipeline current={current} hits={hits} counts={counts} />
          <CurrentEvent event={ev[0]} loading={events.loading} error={events.error} />
        </div>
        <div className="flex min-w-0 flex-col gap-4 md:col-span-2 xl:col-span-1">
          <ComputeRoom
            sandboxes={sandboxes.data}
            sandboxesLoading={sandboxes.loading}
            sandboxesError={sandboxes.error}
            bubbles={bubbles}
            patterns={patterns.data}
            patternsLoading={patterns.loading}
            patternsError={patterns.error}
            patternFlash={patternFlash}
            jobs={jobs.data}
            jobsError={jobs.error}
          />
        </div>
      </div>
      <WireOverlay
        layout={layout}
        routes={routes}
        wires={wires}
        packets={packets}
        onPacketDone={(key) => setDone((prev) => [...prev.slice(-60), key])}
      />
    </section>
  );
}

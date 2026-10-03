"use client";

// The Workspace tab: a live 3D network (agent → Doorway → Supabase Compute → Postgres) on top,
// then the agent console beside the workflow log, then the message board and a job/pattern
// summary. Data hooks and the chat live here so they survive tab switches; the scene only
// animates while the tab is active.

import { useState } from "react";
import { doorway, type DoorwayEvent, type Job, type Message, type Pattern, type RowChange } from "@/lib/doorway";
import { fmtInt, TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useFeed, useLive, type LiveResult } from "@/lib/doorway/live";
import { EventFeed, MessageBoard } from "@/components/feeds/event-feed";
import { useDashboardNav } from "@/components/dashboard/dashboard-tabs";
import { Button, Empty, ErrorBanner, Panel, Skeleton } from "@/components/px/ui";
import { AgentConsole } from "./agent-console";
import { packetForEvent, packetForMessage, type PacketSpec } from "./flow";
import { ScenePanel } from "./scene-panel";
import { useAgentChat } from "./use-agent-chat";

function patternChange(c: RowChange): boolean {
  if (c.table === "doorway_messages") return (c.row as Message).kind === "pattern_published";
  const kind = (c.row as DoorwayEvent).kind;
  return kind === "reuse.pattern" || kind === "publish.tool";
}

type Base = { e: number | null; m: number | null };

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

  // Only rows that arrive after the first load become particles (the backlog stays still).
  const ev = events.items;
  const msgs = messages.items;
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
  const packets: PacketSpec[] = [
    ...(base.e === null ? [] : ev.filter((e) => e.id > (base.e ?? 0)).slice(0, 30).map(packetForEvent)),
    ...(base.m === null ? [] : msgs.filter((m) => m.id > (base.m ?? 0)).slice(0, 12).map(packetForMessage)),
  ].filter((p): p is PacketSpec => p !== null);

  return (
    <div className="flex flex-col gap-4">
      <ScenePanel
        active={active}
        sandboxes={sandboxes.data}
        sandboxesLoading={sandboxes.loading}
        jobs={jobs.data}
        patterns={patterns.data?.length ?? 0}
        latest={ev[0]}
        packets={packets}
        agentBusy={chat.busy}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <AgentConsole
          chat={chat}
          sites={sites.data}
          sitesLoading={sites.loading}
          sitesError={sites.error}
          events={ev}
          messages={msgs}
        />
        <EventFeed title="Workflow log" bodyClassName="max-h-[560px]" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <MessageBoard title="Sandbox message board" bodyClassName="max-h-[320px]" />
        <Summary jobs={jobs} patterns={patterns} />
      </div>
    </div>
  );
}

// ── Jobs + shared memory ─────────────────────────────────────────────────────

const JOB_STATES: { key: Job["status"]; label: string; tone: Tone }[] = [
  { key: "queued", label: "Queued", tone: "muted" },
  { key: "running", label: "Running", tone: "info" },
  { key: "done", label: "Done", tone: "ok" },
  { key: "failed", label: "Failed", tone: "bad" },
];

function Summary({ jobs, patterns }: { jobs: LiveResult<Job[]>; patterns: LiveResult<Pattern[]> }) {
  const { goTo } = useDashboardNav();
  const counts = Object.fromEntries(JOB_STATES.map((s) => [s.key, 0])) as Record<Job["status"], number>;
  for (const j of jobs.data ?? []) counts[j.status] = (counts[j.status] ?? 0) + 1;
  const top = [...(patterns.data ?? [])].sort((a, b) => b.used_by.length - a.used_by.length || b.success_count - a.success_count).slice(0, 5);

  return (
    <Panel
      title="Jobs and shared memory"
      icon="database"
      actions={
        <Button size="sm" variant="ghost" onClick={() => goTo("sandboxes")}>
          Sandboxes
        </Button>
      }
      bodyClassName="flex flex-col gap-4"
    >
      <div>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-faint">Job queue</h3>
        {jobs.loading ? (
          <Skeleton className="h-14" />
        ) : jobs.error && !jobs.data ? (
          <ErrorBanner error={jobs.error} />
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {JOB_STATES.map((s) => (
              <div key={s.key} className="rounded-md border border-line bg-panel-2 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-[11px] text-faint">
                  <span className="size-1.5 rounded-full" style={{ background: TONE_COLOR[s.tone] }} />
                  {s.label}
                </div>
                <div className="text-lg font-semibold tabular-nums text-text">{fmtInt(counts[s.key])}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-faint">Patterns in Postgres</h3>
        {patterns.loading ? (
          <Skeleton className="h-20" />
        ) : patterns.error && !patterns.data ? (
          <ErrorBanner error={patterns.error} />
        ) : !top.length ? (
          <Empty icon="pattern" title="No shared patterns yet" hint="Sandboxes publish one when a tool verifies." className="py-3" />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {top.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 truncate font-mono text-[12px] text-text" title={p.description ?? undefined}>
                  {p.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-faint">
                  {p.used_by.length} site{p.used_by.length === 1 ? "" : "s"} · {fmtInt(p.success_count)} ok
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

"use client";

// Sandboxes tab: the operational view of the worker fleet — who is alive and what each
// sandbox is doing, the shared job queue, the message board and the patterns they share.

import { doorway, type Job, type Message, type Sandbox } from "@/lib/doorway";
import { TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useFeed, useLive } from "@/lib/doorway/live";
import { LiveBadge } from "@/components/px/client";
import { Sprite } from "@/components/px/sprite";
import { StatusDot } from "@/components/px/ui";
import { JobQueue } from "./job-queue";
import { SandboxMessages } from "./message-board";
import { SharedPatterns } from "./patterns";
import { SandboxGrid } from "./sandbox-cards";

export function SandboxesTab({ active }: { active: boolean }) {
  // The tab stays mounted while hidden: pause its queries then. useLive/useFeed keep the
  // last data per key, so switching back shows it instantly while it refreshes.
  const sandboxes = useLive(active ? "sandboxes" : null, () => doorway.sandboxes(), {
    tables: ["doorway_sandboxes", "doorway_jobs"],
  });
  const jobs = useLive(active ? "jobs" : null, () => doorway.jobs(), { tables: ["doorway_jobs"] });
  const patterns = useLive(active ? "patterns" : null, () => doorway.patterns(), { tables: ["doorway_events"] });
  const messages = useFeed<Message>(active ? "sandbox-board" : null, (since) => doorway.messages(since), {
    table: "doorway_messages",
    limit: 80,
  });

  if (!active) return null;
  return (
    <div className="flex flex-col gap-4">
      <IntroStrip sandboxes={sandboxes.data} jobs={jobs.data} />
      <SandboxGrid result={sandboxes} jobs={jobs.data} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)]">
        <SandboxMessages feed={messages} />
        <JobQueue result={jobs} />
        <SharedPatterns result={patterns} />
      </div>
    </div>
  );
}

function IntroStrip({ sandboxes, jobs }: { sandboxes: Sandbox[] | undefined; jobs: Job[] | undefined }) {
  const count = (status: Sandbox["status"]) => (sandboxes ? sandboxes.filter((s) => s.status === status).length : null);
  const busy = count("busy");
  const idle = count("idle");
  const offline = count("offline");
  const online = busy === null || idle === null ? null : busy + idle;
  const queued = jobs ? jobs.filter((j) => j.status === "queued").length : null;

  return (
    <section className="px-panel flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
      <div className="flex min-w-[min(100%,320px)] flex-1 items-center gap-3">
        <Sprite name="sandbox" scale={3} className="shrink-0" />
        <p className="text-xl leading-snug text-text">
          Sandboxes are isolated Chromium workers on <span className="text-green">Supabase Compute</span>. They claim
          jobs from one queue in Postgres, share learned patterns, and talk on a message board.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Count label="Online" value={online} tone={online ? "ok" : "muted"} />
        <Count label="Busy" value={busy} tone={busy ? "info" : "muted"} pulse={!!busy} />
        <Count label="Offline" value={offline} tone={offline ? "bad" : "muted"} />
        <Count label="Queue" value={queued} tone={queued ? "gold" : "muted"} />
        <LiveBadge className="ml-1" />
      </div>
    </section>
  );
}

function Count({ label, value, tone, pulse }: { label: string; value: number | null; tone: Tone; pulse?: boolean }) {
  return (
    <div className="px-inset flex min-w-[84px] flex-col gap-1.5 px-2.5 py-1.5">
      <span className="font-pixel flex items-center gap-1.5 text-[8px] uppercase text-muted">
        <StatusDot tone={tone} size={6} pulse={pulse ?? false} />
        {label}
      </span>
      <span className="font-pixel text-[16px] leading-none" style={{ color: TONE_COLOR[tone] }}>
        {value ?? "—"}
      </span>
    </div>
  );
}

"use client";

// Race tab: a browser agent vs the Doorway broker, same site and same task, side by side.
// Start a race, follow its row live (Realtime on doorway_races, 0.5 s polling as fallback)
// and keep a small history of this session's races. Stays mounted across tab switches.

import { useState, type FormEvent, type ReactNode } from "react";
import { doorway, type Race, type Site } from "@/lib/doorway";
import { clockTime, fmtMs } from "@/lib/doorway/format";
import { useAction, useLive } from "@/lib/doorway/live";
import { useDashboardNav, type TabIntent } from "@/components/dashboard/dashboard-tabs";
import { PixelIcon } from "@/components/px/icons";
import { Sprite } from "@/components/px/sprite";
import {
  Badge,
  Button,
  cx,
  Empty,
  ErrorBanner,
  Field,
  Input,
  Loading,
  Panel,
  Select,
} from "@/components/px/ui";
import { Checkered, LANE_META } from "./race-art";
import { RaceArena } from "./race-arena";
import {
  isFinished,
  presetsFor,
  sameSummary,
  summarize,
  type HistoryEntry,
  type RaceSummary,
} from "./race-model";

const startRace = (body: { site_id: string; task: string }) => doorway.startRace(body);
const fetchSites = () => doorway.sites();

type Choice = { siteId: string; intent: TabIntent };

/** A fresh "Race it" hand-off wins; otherwise the user's pick, else the first ready site. */
function pickSite(sites: Site[], choice: Choice | null, intent: TabIntent): string | null {
  const wanted = choice && choice.intent === intent ? choice.siteId : (intent.siteId ?? choice?.siteId);
  if (wanted && (!sites.length || sites.some((s) => s.id === wanted))) return wanted;
  return (sites.find((s) => s.status === "ready") ?? sites[0])?.id ?? null;
}

export function RaceTab({ active }: { active: boolean }) {
  const { intent, goTo } = useDashboardNav();
  const sites = useLive("sites", fetchSites, { tables: ["doorway_events"] });
  const [choice, setChoice] = useState<Choice | null>(null);
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [raceId, setRaceId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const start = useAction(startRace);

  const list = sites.data ?? [];
  const siteId = pickSite(list, choice, intent);
  const site = list.find((s) => s.id === siteId) ?? null;
  const presets = presetsFor(site);
  const task = (siteId ? tasks[siteId] : undefined) ?? presets[0];
  const nameOf = (id: string) => list.find((s) => s.id === id)?.name ?? id;

  // Every fetched race row also updates its line in the session history.
  const record = (race: Race) => {
    const summary = summarize(race);
    setHistory((h) =>
      h.some((e) => e.id === race.id && !sameSummary(e.result, summary))
        ? h.map((e) => (e.id === race.id ? { ...e, result: summary } : e))
        : h,
    );
  };

  const followed = history.find((e) => e.id === raceId);
  const follow = useLive<Race>(
    raceId ? `race:${raceId}` : null,
    () =>
      doorway.race(raceId ?? "").then((race) => {
        record(race);
        return race;
      }),
    {
      tables: ["doorway_races"],
      filter: (c) => (c.row as { id?: string }).id === raceId,
      pollMs: 500,
      livePollMs: 1000,
      poll: !isFinished(followed?.result?.status),
    },
  );
  const race = follow.data;
  const racing = !!race && !isFinished(race.status);

  async function launch(target: { siteId: string; task: string }) {
    const res = await start.run({ site_id: target.siteId, task: target.task });
    if (!res) return;
    const entry: HistoryEntry = {
      id: res.race_id,
      siteId: target.siteId,
      siteName: nameOf(target.siteId),
      task: target.task,
      startedAt: new Date().toISOString(),
      result: null,
    };
    setHistory((h) => [entry, ...h.filter((e) => e.id !== entry.id)].slice(0, 12));
    setRaceId(res.race_id);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (siteId && task.trim()) void launch({ siteId, task: task.trim() });
  }

  const setTask = (value: string) => {
    if (siteId) setTasks((t) => ({ ...t, [siteId]: value }));
  };

  const noSites = !sites.loading && !sites.error && list.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Race · browser agent vs Doorway broker" icon="race">
        {noSites ? (
          <Empty
            icon="site"
            title="No sites to race on"
            hint="Add a website first; once Doorway has verified its tools you can race it."
            action={
              <Button variant="ghost" size="sm" icon="plus" onClick={() => goTo("sites")}>
                Add a site
              </Button>
            }
          />
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] md:items-end">
              <Field label="Site">
                <Select
                  value={siteId ?? ""}
                  onChange={(e) => setChoice({ siteId: e.target.value, intent })}
                  disabled={!list.length}
                >
                  {!list.length && <option value="">{sites.loading ? "Loading sites…" : "No sites"}</option>}
                  {list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.status !== "ready" ? ` (${s.status})` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Task">
                <Input
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  maxLength={500}
                  placeholder="What should both agents do?"
                  disabled={!siteId}
                />
              </Field>
              <Button
                type="submit"
                size="lg"
                icon="race"
                loading={start.pending}
                disabled={!siteId || task.trim().length < 2 || racing}
                className="md:min-w-48"
              >
                {racing ? "Racing…" : "Start race"}
              </Button>
            </div>

            {siteId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-pixel text-[8px] uppercase text-faint">Try</span>
                {presets.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTask(p)}
                    className={cx(
                      "px-frame px-2 py-0.5 text-base",
                      p === task ? "text-green [--frame:var(--color-green)]" : "text-muted hover:text-text",
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </form>
        )}

        {sites.error !== undefined && !list.length && (
          <ErrorBanner
            error={sites.error}
            className="mt-3"
            action={
              <Button variant="ghost" size="sm" onClick={sites.refresh}>
                Retry
              </Button>
            }
          />
        )}
        {start.error !== undefined && (
          <ErrorBanner
            error={start.error}
            className="mt-3"
            action={
              <Button variant="ghost" size="sm" onClick={start.reset}>
                Dismiss
              </Button>
            }
          />
        )}
      </Panel>

      {!raceId ? (
        <RaceIdle />
      ) : race ? (
        <>
          {follow.error !== undefined && !isFinished(race.status) && (
            <ErrorBanner error={follow.error} action={<span className="text-sm text-muted">retrying…</span>} />
          )}
          <RaceArena
            key={race.id}
            race={race}
            siteName={nameOf(race.site_id)}
            active={active}
            againPending={start.pending}
            onAgain={() => void launch({ siteId: race.site_id, task: race.task })}
            onStop={() => setRaceId(null)}
          />
        </>
      ) : follow.error !== undefined ? (
        <ErrorBanner
          error={follow.error}
          action={
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={follow.refresh}>
                Retry
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRaceId(null)}>
                Close
              </Button>
            </div>
          }
        />
      ) : (
        <div className="px-panel">
          <Loading label={`Joining ${raceId}`} />
        </div>
      )}

      {history.length > 0 && (
        <RaceHistory
          history={history}
          raceId={raceId}
          live={race ? summarize(race) : null}
          onView={(id) => setRaceId(id)}
        />
      )}
    </div>
  );
}

// ── Idle: what the race shows ──────────────────────────────────────────────

function RaceIdle() {
  return (
    <section className="px-panel px-rise grid gap-6 p-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center">
      <div className="px-inset relative flex flex-col gap-3 px-4 py-5" aria-hidden>
        {(["browser", "broker"] as const).map((id, i) => (
          <div key={id} className="flex items-center gap-3">
            <Sprite map={LANE_META[id].sprite} scale={4} className="shrink-0" />
            <span
              className={cx("h-[2px] flex-1", i === 1 && "px-wire")}
              style={
                i === 0
                  ? { backgroundImage: "linear-gradient(90deg, var(--color-amber) 50%, transparent 50%)", backgroundSize: "16px 2px" }
                  : undefined
              }
            />
            <Checkered className="h-14 w-3 shrink-0" cell={4} />
          </div>
        ))}
        <span className="font-pixel absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-bg-2 px-2 text-[14px] text-gold">
          VS
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-pixel text-[12px] uppercase leading-relaxed text-green">
          Same site. Same task. Two ways to do it.
        </h2>
        <IdlePoint color={LANE_META.browser.color} title="Browser agent">
          Takes a screenshot, asks an LLM what to do, clicks or types, then repeats. Every step costs seconds and
          thousands of tokens.
        </IdlePoint>
        <IdlePoint color={LANE_META.broker.color} title="Doorway broker">
          Calls the site&apos;s verified MCP tools directly, e.g. <span className="text-green-hi">list_open_slots</span>{" "}
          → <span className="text-green-hi">book_appointment</span>. One tool call ≈ one HTTP request, zero LLM tokens.
        </IdlePoint>
        <IdlePoint color="var(--color-gold)" title="Live scoreboard">
          Timers, steps, tokens and screenshots stream in as they happen. Pick a site and task above and press
          <span className="font-pixel text-[9px] text-green"> Start race</span>.
        </IdlePoint>
      </div>
    </section>
  );
}

function IdlePoint({ color, title, children }: { color: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-1.5 size-2.5 shrink-0" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      <p className="text-base leading-snug text-text">
        <span className="font-pixel mr-2 text-[9px] uppercase" style={{ color }}>
          {title}
        </span>
        {children}
      </p>
    </div>
  );
}

// ── Session history ────────────────────────────────────────────────────────

function RaceHistory({
  history,
  raceId,
  live,
  onView,
}: {
  history: HistoryEntry[];
  raceId: string | null;
  live: RaceSummary | null;
  onView: (id: string) => void;
}) {
  return (
    <Panel title="Races this session" icon="clock" bodyClassName="p-0">
      <ul>
        {history.map((e) => {
          const viewing = e.id === raceId;
          const result = viewing && live ? live : e.result;
          return (
            <li
              key={e.id}
              className={cx(
                "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-3 py-2 last:border-0",
                viewing && "bg-panel-2",
              )}
            >
              <span className="text-sm tabular-nums text-faint">{clockTime(e.startedAt)}</span>
              <span className="text-sm text-violet">{e.id}</span>
              <span className="min-w-0 flex-1 truncate text-base">
                <span className="text-text">{e.siteName}</span>
                <span className="text-faint"> · </span>
                <span className="text-muted">{e.task}</span>
              </span>
              <ResultCell result={result} />
              {viewing ? (
                <Badge tone="info">Viewing</Badge>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => onView(e.id)}>
                  View
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function ResultCell({ result }: { result: RaceSummary | null }) {
  if (!result || !isFinished(result.status)) {
    return <Badge status={result?.status ?? "queued"}>{result?.status ?? "starting"}</Badge>;
  }
  if (result.status === "failed") return <Badge status="failed">failed</Badge>;
  if (!result.winner) return <span className="text-base text-muted">no winner</span>;
  return (
    <span className="flex items-center gap-2 text-base">
      <PixelIcon name="race" size={12} className="text-gold" />
      <span className="text-green">broker {fmtMs(result.brokerMs)}</span>
      <span className="text-faint">vs</span>
      <span className="text-amber">browser {fmtMs(result.browserMs)}</span>
      {result.speedup !== null && <span className="font-pixel text-[9px] text-gold">{result.speedup}×</span>}
      {result.winner === "browser" && <span className="text-muted">(browser won)</span>}
    </span>
  );
}

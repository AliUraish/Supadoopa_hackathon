"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { GraphTab } from "@/components/graph/graph-tab";
import { LiveTab } from "@/components/live/live-tab";
import { PixelIcon } from "@/components/px/icons";
import { LiveBadge } from "@/components/px/client";
import { cx } from "@/components/px/ui";
import { RaceTab } from "@/components/race/race-tab";
import { SandboxesTab } from "@/components/sandboxes/sandboxes-tab";
import { SitesTab } from "@/components/sites/sites-tab";
import { WorkspaceTab } from "@/components/workspace/workspace-tab";
import { TABS, type TabId } from "./tabs";

export type { TabId } from "./tabs";

/** Cross-tab hand-off, e.g. a site card's "Race it" button preselects the site. */
export interface TabIntent {
  siteId?: string;
}

interface DashboardNav {
  tab: TabId;
  intent: TabIntent;
  goTo: (tab: TabId, intent?: TabIntent) => void;
}

const NavContext = createContext<DashboardNav>({ tab: "workspace", intent: {}, goTo: () => {} });

/** Switch dashboard tabs from anywhere inside a tab. */
export function useDashboardNav() {
  return useContext(NavContext);
}

const PANELS: Record<TabId, (props: { active: boolean }) => ReactNode> = {
  workspace: WorkspaceTab,
  live: LiveTab,
  graph: GraphTab,
  race: RaceTab,
  sandboxes: SandboxesTab,
  sites: SitesTab,
};

export function DashboardTabs({ initialTab }: { initialTab: TabId }) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [intent, setIntent] = useState<TabIntent>({});
  // Tabs stay mounted after their first visit so a running race survives a tab switch.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([initialTab]));

  const goTo = useCallback((next: TabId, nextIntent: TabIntent = {}) => {
    setTab(next);
    setIntent(nextIntent);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }, []);

  const nav = useMemo(() => ({ tab, intent, goTo }), [tab, intent, goTo]);

  return (
    <NavContext.Provider value={nav}>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-line">
          <div role="tablist" aria-label="Dashboard" className="-mb-[2px] flex flex-wrap gap-1">
            {TABS.map((t) => {
              const selected = t.id === tab;
              return (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  id={`tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls={`panel-${t.id}`}
                  onClick={() => goTo(t.id)}
                  className={cx(
                    "font-pixel flex items-center gap-2 border-2 border-b-0 px-3 py-2.5 text-[10px] uppercase",
                    selected
                      ? "border-green bg-panel-2 text-green px-glow"
                      : "border-transparent text-muted hover:text-text",
                  )}
                  style={selected ? { boxShadow: "inset 0 -2px 0 0 var(--color-panel-2)" } : undefined}
                >
                  <PixelIcon name={t.icon} size={12} />
                  {t.label}
                </button>
              );
            })}
          </div>
          <LiveBadge className="mb-2" />
        </div>

        {TABS.map((t) => {
          if (!visited.has(t.id)) return null;
          const Panel = PANELS[t.id];
          const active = t.id === tab;
          return (
            <div
              key={t.id}
              role="tabpanel"
              id={`panel-${t.id}`}
              aria-labelledby={`tab-${t.id}`}
              hidden={!active}
              className="min-h-0 flex-1"
            >
              <Panel active={active} />
            </div>
          );
        })}
      </div>
    </NavContext.Provider>
  );
}

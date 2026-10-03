"use client";

// Dashboard sections. The sidebar picks the tab (?tab=); sections stay mounted after their
// first visit so a running race or the 3D scene survives switching away and back.

import { useState, type ReactNode } from "react";
import { InstallTab } from "@/components/catalog/install-tab";
import { ToolsTab } from "@/components/catalog/tools-tab";
import { LiveBadge } from "@/components/px/client";
import { SandboxesTab } from "@/components/sandboxes/sandboxes-tab";
import { SitesTab } from "@/components/sites/sites-tab";
import { WorkspaceTab } from "@/components/workspace/workspace-tab";
import { useDashboardNav } from "./nav";
import { TABS, type TabId } from "./tabs";

export { useDashboardNav, type TabIntent } from "./nav";
export type { TabId } from "./tabs";

const PANELS: Record<TabId, (props: { active: boolean }) => ReactNode> = {
  workspace: WorkspaceTab,
  sandboxes: SandboxesTab,
  sites: SitesTab,
  tools: ToolsTab,
  install: InstallTab,
};

const BLURB: Record<TabId, string> = {
  workspace: "Your agent, the Doorway broker and the Supabase Compute sandboxes, live.",
  sandboxes: "Isolated browser workers on Supabase Compute. Watch their screens while they work.",
  sites: "Add a website. Sandboxes discover it, compile its tools and verify them.",
  tools: "Every tool built so far, its health, and why a failing one fails.",
  install: "Add Doorway's tools to Claude Code, Codex, Claude Desktop, Cursor, VS Code, Gemini CLI or any agent.",
};

export function DashboardTabs() {
  const { tab } = useDashboardNav();
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set(visited).add(tab));
  const current = TABS.find((t) => t.id === tab);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text">{current?.label}</h1>
          <p className="text-[13px] text-muted">{BLURB[tab]}</p>
        </div>
        <LiveBadge />
      </div>
      {TABS.map((t) => {
        if (!visited.has(t.id)) return null;
        const Panel = PANELS[t.id];
        const active = t.id === tab;
        return (
          <div key={t.id} role="tabpanel" aria-label={t.label} hidden={!active} className="min-h-0 flex-1">
            <Panel active={active} />
          </div>
        );
      })}
    </div>
  );
}

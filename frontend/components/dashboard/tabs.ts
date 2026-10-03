// Dashboard tab ids, shared by the server page (initial tab) and the client tabs.

import type { IconName } from "@/components/px/icons";

export const TABS = [
  { id: "workspace", label: "Workspace", icon: "agent" },
  { id: "live", label: "Live", icon: "observe" },
  { id: "graph", label: "Graph", icon: "graph" },
  { id: "race", label: "Race", icon: "race" },
  { id: "sandboxes", label: "Sandboxes", icon: "sandbox" },
  { id: "sites", label: "Sites", icon: "site" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export type TabId = (typeof TABS)[number]["id"];

export function isTabId(value: unknown): value is TabId {
  return TABS.some((t) => t.id === value);
}

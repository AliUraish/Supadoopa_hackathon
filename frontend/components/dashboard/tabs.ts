// Dashboard sections, shared by the sidebar, the server page and the client tabs.

import type { IconName } from "@/components/px/icons";

export const TABS = [
  { id: "workspace", label: "Workspace", icon: "overview", supabase: false },
  { id: "sandboxes", label: "Sandboxes", icon: "sandbox", supabase: true },
  { id: "sites", label: "Websites", icon: "globe", supabase: false },
  { id: "tools", label: "Tools", icon: "tool", supabase: false },
  { id: "install", label: "Install", icon: "plus", supabase: false },
] as const satisfies readonly { id: string; label: string; icon: IconName; supabase: boolean }[];

export type TabId = (typeof TABS)[number]["id"];

export function isTabId(value: unknown): value is TabId {
  return TABS.some((t) => t.id === value);
}

/** ?tab= value → tab (old names map to their new home). */
export function parseTab(value: string | null | undefined): TabId {
  if (value === "overview" || value === "graph" || value === "race") return "workspace";
  if (value === "live") return "sandboxes";
  return isTabId(value) ? value : "workspace";
}

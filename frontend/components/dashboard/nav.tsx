"use client";

// Dashboard navigation state. The URL (?tab=) is the source of truth; switching tabs on
// /dashboard uses history.pushState (no server round trip), elsewhere it navigates.

import { useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { parseTab, type TabId } from "./tabs";

/** Cross-tab hand-off, e.g. a site card's "Race" button preselects the site. */
export interface TabIntent {
  siteId?: string;
}

interface DashboardNav {
  tab: TabId;
  intent: TabIntent;
  goTo: (tab: TabId, intent?: TabIntent) => void;
}

const NavContext = createContext<DashboardNav>({ tab: "workspace", intent: {}, goTo: () => {} });

export function useDashboardNav() {
  return useContext(NavContext);
}

export function DashboardNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const tab = parseTab(useSearchParams().get("tab"));
  const [intent, setIntent] = useState<TabIntent>({});

  const goTo = useCallback(
    (next: TabId, nextIntent: TabIntent = {}) => {
      setIntent(nextIntent);
      if (window.location.pathname === "/dashboard") {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", next);
        window.history.pushState(null, "", url);
      } else {
        router.push(`/dashboard?tab=${next}`);
      }
    },
    [router],
  );

  const value = useMemo(() => ({ tab, intent, goTo }), [tab, intent, goTo]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

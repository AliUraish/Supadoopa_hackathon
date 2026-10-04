"use client";

// Top-bar alert: a Compute sandbox is paused on a login wall and needs a person to sign in.

import { useComputeState } from "@/components/sandboxes/compute";
import { useDashboardNav } from "@/components/dashboard/nav";
import { Icon } from "@/components/px/icons";
import { fetchLiveView } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";

export function SignInAlert() {
  const { goTo } = useDashboardNav();
  const { data: view } = useLive("live-view", fetchLiveView, { poll: false });
  const state = useComputeState(view?.state_url, view?.refresh_ms ?? 2000);
  const waiting = state?.sandboxes.find((s) => s.needs_human);
  if (!waiting?.needs_human) return null;

  const who = waiting.needs_human.site_id ?? waiting.sandbox;
  return (
    <button
      type="button"
      onClick={() => goTo("sandboxes")}
      title={waiting.needs_human.reason}
      className="flex h-7 items-center gap-1.5 rounded-full border border-amber/40 bg-amber/10 px-3 text-xs text-amber animate-breathe"
    >
      <Icon name="lock" size={12} />
      {who} needs your sign-in
    </button>
  );
}

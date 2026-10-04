// The Compute live-view state (CORS-enabled): which sandboxes have a live browser, the page each
// is on, active pipeline stages, and any sandbox waiting for a person to sign in.

import { useEffect, useState } from "react";

export interface NeedsHuman {
  reason: string;
  job_id?: number | null;
  site_id?: string | null;
  page_url?: string | null;
  since?: string | null;
  expires_at?: string | null;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ComputeSandbox {
  sandbox: string;
  job: { kind?: string; job_id?: number; site_id?: string } | null;
  url: string | null;
  frame_age_s: number | null;
  live: boolean;
  needs_human?: NeedsHuman | null;
  viewport?: Viewport | null;
}

export interface ComputeState {
  active: string[];
  sandboxes: ComputeSandbox[];
}

/** Polls the state at the backend's refresh_ms; null until the first answer. */
export function useComputeState(stateUrl: string | undefined, refreshMs: number): ComputeState | null {
  const [state, setState] = useState<{ url: string; data: ComputeState } | null>(null);
  useEffect(() => {
    if (!stateUrl) return;
    let cancelled = false;
    const load = () =>
      fetch(stateUrl, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<ComputeState>) : null))
        .then((data) => {
          if (!cancelled && data) setState({ url: stateUrl, data });
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stateUrl, refreshMs]);
  return state && state.url === stateUrl ? state.data : null;
}

"use client";

// Live sandboxes: the backend's Supabase Compute page, embedded. Each sandbox streams its
// real Chromium screen (~1 fps) while it discovers, verifies and heals sites.

import { useState } from "react";
import { DOORWAY_MOCK, fetchLiveView } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";
import { Banner, Button, Empty, ErrorBanner, Loading, Panel } from "@/components/px/ui";

export function LiveTab({ active }: { active: boolean }) {
  const view = useLive("live-view", fetchLiveView, { poll: false });
  const [reloads, setReloads] = useState(0);
  const url = view.data?.url;

  return (
    <Panel
      title="Live sandboxes · Supabase Compute"
      icon="observe"
      actions={
        url && (
          <>
            <Button size="sm" variant="ghost" icon="compile" onClick={() => setReloads((n) => n + 1)}>
              Reload
            </Button>
            <a href={url} target="_blank" rel="noreferrer" className="px-btn px-btn--ghost px-btn--sm">
              Open ↗
            </a>
          </>
        )
      }
      bodyClassName="flex flex-col gap-3"
    >
      <p className="text-base text-muted">
        Every sandbox is an isolated Chromium worker on <span className="text-green">Supabase Compute</span>. Watch
        their real screens while they discover, verify and heal sites; pipeline stages pulse as they run.
      </p>
      {DOORWAY_MOCK && (
        <Banner tone="info" title="Always live">
          This view streams the real Compute workers, even while the rest of the dashboard shows mock data.
        </Banner>
      )}
      {view.loading ? (
        <Loading label="Finding the sandboxes" />
      ) : !url ? (
        view.error ? (
          <ErrorBanner
            error={view.error}
            action={
              <Button size="sm" variant="ghost" onClick={view.refresh}>
                Retry
              </Button>
            }
          />
        ) : (
          <Empty icon="sandbox" title="No live view" hint="The backend didn't return a sandbox stream URL." />
        )
      ) : active ? (
        <>
          <iframe
            key={reloads}
            src={url}
            title="Live Supabase Compute sandboxes"
            className="px-inset h-[720px] w-full bg-bg"
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
          <p className="text-sm text-faint">
            Seeing a 502? A Compute deploy is still rolling out. Hit Reload in a minute.
          </p>
        </>
      ) : null}
    </Panel>
  );
}

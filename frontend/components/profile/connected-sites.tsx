"use client";

// Sites the user signed in to through a sandbox. Doorway keeps only the (encrypted) session.
// Renders nothing while the backend doesn't serve /doorway/sessions yet (404).

import { useState } from "react";
import { doorway, DoorwayError } from "@/lib/doorway";
import { useAction, useLive } from "@/lib/doorway/live";
import { TimeAgo } from "@/components/px/client";
import { Button, Empty, ErrorBanner, Panel, Skeleton } from "@/components/px/ui";

export function ConnectedSites() {
  const sessions = useLive("sessions", () => doorway.sessions(), { poll: false });
  const remove = useAction(doorway.deleteSession);
  const [removing, setRemoving] = useState<string | null>(null);

  if (sessions.error instanceof DoorwayError && sessions.error.status === 404) return null;

  const disconnect = async (siteId: string) => {
    setRemoving(siteId);
    await remove.run(siteId);
    setRemoving(null);
    sessions.refresh();
  };

  return (
    <Panel title="Connected sites" icon="lock">
      <p className="mb-4 max-w-3xl text-[13px] leading-relaxed text-muted">
        Sites you signed in to through a sandbox. Doorway keeps only the session (never your password), encrypted,
        and uses it only for your own tool calls.
      </p>

      {remove.error !== undefined && <ErrorBanner error={remove.error} className="mb-3" />}

      {sessions.loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : sessions.error ? (
        <ErrorBanner
          error={sessions.error}
          action={
            <Button variant="ghost" size="sm" onClick={sessions.refresh}>
              Retry
            </Button>
          }
        />
      ) : !sessions.data?.length ? (
        <Empty icon="lock" title="No connected sites" hint="Sign in to a site from a sandbox and it shows up here." />
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          {sessions.data.map((s) => (
            <li key={s.site_id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-[13px] text-text">{s.site_id}</div>
                <div className="text-xs text-faint">
                  saved <TimeAgo iso={s.saved_at} />
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={removing === s.site_id}
                disabled={removing !== null}
                onClick={() => disconnect(s.site_id)}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

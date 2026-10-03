"use client";

// The agent console's state: each exchange is one task sent to the broker
// (POST /doorway/requests), polled every ~500 ms until it is done or failed.
// Lives in WorkspaceTab so the transcript survives tab switches.

import { useCallback, useEffect, useRef, useState } from "react";
import { doorway, type AgentRequest, type AgentRequestStatus, type Site, type Tool } from "@/lib/doorway";
import type { RequestWindow } from "./flow";

export type Phase = "sending" | AgentRequestStatus | "error";

export interface Exchange extends RequestWindow {
  id: number;
  siteName: string;
  task: string;
  phase: Phase;
  tool: Tool | null;
  final?: AgentRequest;
  error?: unknown;
  timedOut?: boolean;
  polls: number;
  pollErrors: number;
}

const KEEP = 6;
const POLL_MS = 500;
const MAX_POLLS = 180; // ~90 s, then we stop watching (the request keeps running)
const FREEZE_MS = 1500; // late events still land in the transcript

const isFinal = (s: AgentRequestStatus | undefined) => s === "done" || s === "failed";

export function isSettled(x: Exchange): boolean {
  return x.phase === "error" || Boolean(x.timedOut) || (x.final !== undefined && isFinal(x.final.status));
}

function needsPoll(x: Exchange): boolean {
  return x.requestId !== undefined && !isSettled(x);
}

export interface AgentChat {
  exchanges: Exchange[];
  busy: boolean;
  send: (site: Site, task: string) => void;
  clear: () => void;
}

export function useAgentChat(latestEventId: number, latestMessageId: number): AgentChat {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const seq = useRef(0);
  const latest = useRef({ e: 0, m: 0 });

  useEffect(() => {
    latest.current = { e: latestEventId, m: latestMessageId };
  }, [latestEventId, latestMessageId]);

  const patch = useCallback((id: number, fn: (x: Exchange) => Exchange) => {
    setExchanges((prev) => prev.map((x) => (x.id === id ? fn(x) : x)));
  }, []);

  const send = useCallback(
    (site: Site, task: string) => {
      const id = ++seq.current;
      const start: Exchange = {
        id,
        siteId: site.id,
        siteName: site.name,
        task,
        phase: "sending",
        tool: null,
        polls: 0,
        pollErrors: 0,
        fromEventId: latest.current.e,
        fromMessageId: latest.current.m,
      };
      setExchanges((prev) => [...prev, start].slice(-KEEP));
      doorway.request({ website: site.base_url, task }).then(
        (created) =>
          patch(id, (x) => ({
            ...x,
            phase: created.status,
            requestId: created.request_id,
            siteId: created.site_id || x.siteId,
            tool: created.tool ?? null,
          })),
        (error: unknown) => patch(id, (x) => ({ ...x, phase: "error", error })),
      );
    },
    [patch],
  );

  const clear = useCallback(() => setExchanges((prev) => prev.filter((x) => !isSettled(x))), []);

  // Poll the first unsettled request. Every answer bumps `tick`, which schedules the next poll.
  const target = exchanges.find(needsPoll);
  const targetId = target?.id;
  const targetReq = target?.requestId;
  const tick = target ? target.polls + target.pollErrors : 0;

  useEffect(() => {
    if (targetId === undefined || !targetReq) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        doorway.getRequest(targetReq).then(
          (r) => {
            if (cancelled) return;
            patch(targetId, (x) => {
              const polls = x.polls + 1;
              return {
                ...x,
                polls,
                pollErrors: 0,
                phase: r.status,
                final: r,
                tool: r.tool ?? x.tool,
                siteId: r.site_id || x.siteId,
                timedOut: !isFinal(r.status) && polls >= MAX_POLLS,
              };
            });
          },
          (error: unknown) => {
            if (cancelled) return;
            patch(targetId, (x) =>
              x.pollErrors >= 2 ? { ...x, phase: "error", error } : { ...x, pollErrors: x.pollErrors + 1 },
            );
          },
        );
      },
      tick === 0 ? 200 : POLL_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [targetId, targetReq, tick, patch]);

  // Once settled, keep collecting the request's events for a moment, then freeze its window.
  const unfrozen = exchanges.find((x) => isSettled(x) && x.toEventId === undefined)?.id;
  useEffect(() => {
    if (unfrozen === undefined) return;
    const timer = setTimeout(
      () => patch(unfrozen, (x) => ({ ...x, toEventId: latest.current.e, toMessageId: latest.current.m })),
      FREEZE_MS,
    );
    return () => clearTimeout(timer);
  }, [unfrozen, patch]);

  const busy = exchanges.some((x) => !isSettled(x));
  return { exchanges, busy, send, clear };
}

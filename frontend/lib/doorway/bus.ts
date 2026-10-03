// Supabase Realtime bus: one channel with postgres_changes (INSERT + UPDATE) on every
// doorway_* table, fanned out to subscribers. When Realtime can't connect (env missing,
// tables not migrated, network), status() is "down" and the live hooks poll instead.

import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import {
  REALTIME_TABLES,
  type BusStatus,
  type LiveBus,
  type RealtimeTable,
  type RowChange,
} from "@/lib/doorway/types";

type Listener = (change: RowChange) => void;

let instance: LiveBus | null = null;

export function supabaseBus(): LiveBus {
  if (!instance) instance = createSupabaseBus();
  return instance;
}

function createSupabaseBus(): LiveBus {
  const listeners = new Map<RealtimeTable, Set<Listener>>();
  const statusListeners = new Set<(s: BusStatus) => void>();
  let status: BusStatus = "connecting";
  let channel: RealtimeChannel | null = null;

  const setStatus = (next: BusStatus) => {
    if (next === status) return;
    status = next;
    statusListeners.forEach((cb) => cb(next));
  };

  const connect = () => {
    if (channel || typeof window === "undefined") return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
      setStatus("down");
      return;
    }
    const supabase = createClient();
    let ch = supabase.channel("doorway-live");
    for (const table of REALTIME_TABLES) {
      for (const event of ["INSERT", "UPDATE"] as const) {
        ch = ch.on(
          "postgres_changes",
          { event, schema: "public", table },
          (payload: { new: Record<string, unknown> }) => {
            const change = { table, type: event, row: payload.new } as unknown as RowChange;
            listeners.get(table)?.forEach((cb) => cb(change));
          },
        );
      }
    }
    channel = ch.subscribe((s) => {
      if (s === "SUBSCRIBED") setStatus("live");
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") setStatus("down");
    });
    // A channel that never confirms is as good as down: poll meanwhile.
    setTimeout(() => {
      if (status === "connecting") setStatus("down");
    }, 6000);
  };

  return {
    subscribe(table, cb) {
      connect();
      let set = listeners.get(table);
      if (!set) listeners.set(table, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    status: () => status,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
  };
}

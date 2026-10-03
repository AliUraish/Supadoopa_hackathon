// Live data hooks for Client Components.
//
// Every hook loads from the GET endpoints, then listens on the live bus (mock stream or
// Supabase Realtime). When the bus is down they poll every 2 s instead. With Realtime up
// they still poll every 3 s: a channel can report SUBSCRIBED while the backend writes to a
// database Realtime doesn't watch (e.g. a local Postgres).

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import { liveBus } from "@/lib/doorway";
import type { BusStatus, RealtimeTable, RowChange } from "@/lib/doorway/types";

export type LiveMode = "realtime" | "polling";

export function useBusStatus(): BusStatus {
  return useSyncExternalStore(
    (cb) => (typeof window === "undefined" ? () => {} : liveBus().onStatus(cb)),
    () => liveBus().status(),
    () => "connecting",
  );
}

export function useLiveMode(): LiveMode {
  const status = useBusStatus();
  return status === "live" ? "realtime" : "polling";
}

// ── useLive: a refetch-on-change query ─────────────────────────────────────

export interface LiveOptions {
  /** Realtime tables whose INSERT/UPDATE should trigger a (debounced) refetch. */
  tables?: RealtimeTable[];
  /** Only refetch for matching changes, e.g. (c) => c.row.site_id === id. */
  filter?: (change: RowChange) => boolean;
  /** Poll interval while the bus is down (default 2000 ms). */
  pollMs?: number;
  /** Safety-net poll interval while Realtime is up (default 3000 ms). */
  livePollMs?: number;
  /** Set false to stop polling (e.g. a finished race). Bus updates still apply. */
  poll?: boolean;
  debounceMs?: number;
}

export interface LiveResult<T> {
  data: T | undefined;
  error: unknown;
  /** True until the first response (success or error) for the current key. */
  loading: boolean;
  /** Refetch now. */
  refresh: () => void;
  /** Optimistically change the cached data. */
  mutate: (fn: (prev: T | undefined) => T | undefined) => void;
  mode: LiveMode;
}

type Slot<T> = { key: string | null; data?: T; error?: unknown };

/**
 * `key` identifies the query: change it to load something else, pass null to pause.
 *   const { data } = useLive(`site:${id}`, () => doorway.site(id), { tables: ["doorway_events"] })
 */
export function useLive<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  opts: LiveOptions = {},
): LiveResult<T> {
  const { pollMs = 2000, livePollMs = 3000, poll = true, debounceMs = 250 } = opts;
  const tablesKey = (opts.tables ?? []).join(",");
  const busStatus = useBusStatus();
  const mode = useLiveMode();
  const [slot, setSlot] = useState<Slot<T>>({ key: null });
  const [nonce, setNonce] = useState(0);

  const load = useEffectEvent(() => fetcher());
  const accept = useEffectEvent((c: RowChange) => (opts.filter ? opts.filter(c) : true));

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    let seq = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      const mine = ++seq;
      load().then(
        (data) => {
          if (!cancelled && mine === seq) setSlot({ key, data });
        },
        (error: unknown) => {
          if (!cancelled && mine === seq)
            setSlot((prev) => ({ key, data: prev.key === key ? prev.data : undefined, error }));
        },
      );
    };
    run();

    const bus = liveBus();
    const unsubs = (tablesKey ? tablesKey.split(",") : []).map((table) =>
      bus.subscribe(table as RealtimeTable, (change) => {
        if (!accept(change)) return;
        clearTimeout(debounce);
        debounce = setTimeout(run, debounceMs);
      }),
    );

    let interval: ReturnType<typeof setInterval> | undefined;
    if (poll) {
      const every = busStatus === "live" ? livePollMs : pollMs;
      interval = setInterval(() => {
        if (!document.hidden) run();
      }, every);
    }

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      clearTimeout(debounce);
      clearInterval(interval);
    };
  }, [key, nonce, tablesKey, busStatus, poll, pollMs, livePollMs, debounceMs]);

  const current = slot.key === key;
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback(
    (fn: (prev: T | undefined) => T | undefined) =>
      setSlot((prev) => (prev.key === key ? { ...prev, data: fn(prev.data) } : prev)),
    [key],
  );

  return {
    data: current ? slot.data : undefined,
    error: current ? slot.error : undefined,
    loading: key !== null && !current,
    refresh,
    mutate,
    mode,
  };
}

// ── useFeed: an append-only list (events, messages) ────────────────────────

export interface FeedOptions<T> {
  table: RealtimeTable;
  /** Keep only matching rows (applied to pushed rows; the fetcher filters server-side). */
  filter?: (row: T) => boolean;
  /** Max rows kept (default 200). */
  limit?: number;
  pollMs?: number;
}

export interface FeedResult<T> {
  /** Newest first. */
  items: T[];
  error: unknown;
  loading: boolean;
  mode: LiveMode;
}

type FeedSlot<T> = { key: string | null; items: T[]; error?: unknown; loaded: boolean };

function mergeRows<T extends { id: number }>(prev: T[], rows: T[], limit: number): T[] {
  if (!rows.length) return prev;
  const byId = new Map(prev.map((r) => [r.id, r]));
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, limit);
}

/**
 * `fetcher(since)` returns rows with id > since (or the latest rows when since is undefined).
 *   const { items } = useFeed("events", (since) => doorway.events({ since }), { table: "doorway_events" })
 */
export function useFeed<T extends { id: number }>(
  key: string | null,
  fetcher: (since?: number) => Promise<T[]>,
  opts: FeedOptions<T>,
): FeedResult<T> {
  const { table, limit = 200, pollMs = 2000 } = opts;
  const busStatus = useBusStatus();
  const mode = useLiveMode();
  const [slot, setSlot] = useState<FeedSlot<T>>({ key: null, items: [], loaded: false });

  const load = useEffectEvent((since?: number) => fetcher(since));
  const keep = useEffectEvent((row: T) => (opts.filter ? opts.filter(row) : true));

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    let lastId = 0;

    const apply = (rows: T[]) => {
      if (cancelled) return;
      for (const r of rows) lastId = Math.max(lastId, r.id);
      setSlot((prev) => {
        const base = prev.key === key ? prev.items : [];
        return { key, items: mergeRows(base, rows, limit), loaded: true };
      });
    };
    const fail = (error: unknown) => {
      if (!cancelled) setSlot((prev) => ({ ...(prev.key === key ? prev : { items: [] }), key, error, loaded: true }));
    };

    load(undefined).then(apply, fail);

    const unsub = liveBus().subscribe(table, (change) => {
      const row = change.row as unknown as T;
      if (row && typeof row.id === "number" && keep(row)) apply([row]);
    });

    let interval: ReturnType<typeof setInterval> | undefined;
    {
      interval = setInterval(
        () => {
          if (document.hidden) return;
          load(lastId || undefined).then((rows) => apply(rows.filter((r) => keep(r))), fail);
        },
        busStatus === "live" ? 3000 : pollMs,
      );
    }

    return () => {
      cancelled = true;
      unsub();
      clearInterval(interval);
    };
  }, [key, table, limit, pollMs, busStatus]);

  const current = slot.key === key;
  return {
    items: current ? slot.items : [],
    error: current ? slot.error : undefined,
    loading: key !== null && !(current && slot.loaded),
    mode,
  };
}

// ── useAction: pending/error state for a button or form ────────────────────

export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(undefined);
      try {
        return await fn(...args);
      } catch (err) {
        setError(err);
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  const reset = useCallback(() => setError(undefined), []);
  return { run, pending, error, reset };
}

// ── useNow: a shared 1 s clock (render-pure "time ago") ────────────────────

let now = Date.now();
const clockListeners = new Set<() => void>();
let clock: ReturnType<typeof setInterval> | undefined;

function subscribeClock(cb: () => void) {
  clockListeners.add(cb);
  if (!clock) {
    // The clock was idle: catch up now, then tick every second.
    now = Date.now();
    queueMicrotask(() => clockListeners.forEach((l) => l()));
    clock = setInterval(() => {
      now = Date.now();
      clockListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    clockListeners.delete(cb);
    if (!clockListeners.size && clock) {
      clearInterval(clock);
      clock = undefined;
    }
  };
}

/** Current time in ms, re-rendering every second. Returns 0 during SSR. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => now, () => 0);
}

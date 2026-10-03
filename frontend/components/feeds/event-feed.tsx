"use client";

// Shared live feeds: pipeline events and sandbox messages. Each event family has its own
// icon and tone (lib/doorway/format.ts) so a feed reads at a glance.

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { doorway, type DoorwayEvent, type Message } from "@/lib/doorway";
import { clockTime, eventStyle, MESSAGE_STYLE, messageSummary, TONE_COLOR } from "@/lib/doorway/format";
import { useFeed } from "@/lib/doorway/live";
import { LiveBadge } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
import { cx, Empty, ErrorBanner, Loading, Panel } from "@/components/px/ui";

const ROW = "grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2.5 border-b border-line px-4 py-2 last:border-0";
const ENTER = { opacity: 0, y: 8 };
const SHOWN = { opacity: 1, y: 0 };
const TRANSITION = { duration: 0.18, ease: "easeOut" } as const;

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso} className="pt-px font-mono text-[11px] tabular-nums text-faint" suppressHydrationWarning>
      {clockTime(iso)}
    </time>
  );
}

export function EventRow({ event, showSite = true }: { event: DoorwayEvent; showSite?: boolean }) {
  const reduce = useReducedMotion();
  const style = eventStyle(event.kind);
  return (
    <motion.li initial={reduce ? false : ENTER} animate={SHOWN} transition={TRANSITION} className={ROW}>
      <Time iso={event.created_at} />
      <Icon name={style.icon} size={14} className="mt-px" style={{ color: TONE_COLOR[style.tone] }} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs text-text">{event.kind}</span>
          {event.sandbox_id && <span className="font-mono text-xs text-violet">{event.sandbox_id}</span>}
          {showSite && event.site_id && (
            <Link href={`/sites/${event.site_id}`} className="text-xs text-muted hover:text-green">
              {event.site_id}
            </Link>
          )}
        </div>
        <p className="break-words text-[13px] leading-snug text-muted">{event.message}</p>
      </div>
    </motion.li>
  );
}

export function MessageRow({ message }: { message: Message }) {
  const reduce = useReducedMotion();
  const style = MESSAGE_STYLE[message.kind] ?? MESSAGE_STYLE.hello;
  const summary = messageSummary(message.body);
  return (
    <motion.li initial={reduce ? false : ENTER} animate={SHOWN} transition={TRANSITION} className={ROW}>
      <Time iso={message.created_at} />
      <Icon name={style.icon} size={14} className="mt-px" style={{ color: TONE_COLOR[style.tone] }} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
          <span className="font-mono text-violet">{message.from_sandbox}</span>
          <span className="text-faint">→</span>
          <span className="font-mono text-muted">{message.to_sandbox ?? "all"}</span>
          <span className="ml-1 font-mono text-text">{message.kind}</span>
        </div>
        {summary && <p className="break-words text-[13px] leading-snug text-muted">{summary}</p>}
      </div>
    </motion.li>
  );
}

/** Live event feed; pass siteId to scope it to one site. */
export function EventFeed({
  siteId,
  title = "Live events",
  limit = 120,
  className,
  bodyClassName = "max-h-[520px]",
}: {
  siteId?: string;
  title?: string;
  limit?: number;
  className?: string;
  bodyClassName?: string;
}) {
  const { items, error, loading } = useFeed<DoorwayEvent>(
    `events:${siteId ?? "*"}`,
    (since) => doorway.events({ siteId, since }),
    { table: "doorway_events", filter: (e) => !siteId || e.site_id === siteId, limit },
  );
  return (
    <Panel
      title={title}
      icon="live"
      actions={<LiveBadge />}
      className={className}
      bodyClassName={cx("overflow-y-auto p-0!", bodyClassName)}
    >
      {loading ? (
        <Loading label="Loading events" className="p-4" />
      ) : error && !items.length ? (
        <div className="p-4">
          <ErrorBanner error={error} />
        </div>
      ) : !items.length ? (
        <Empty icon="live" title="No events yet" hint="Add a site or run a tool and the pipeline will start reporting here." />
      ) : (
        <ol>
          <AnimatePresence initial={false}>
            {items.map((e) => (
              <EventRow key={e.id} event={e} showSite={!siteId} />
            ))}
          </AnimatePresence>
        </ol>
      )}
    </Panel>
  );
}

/** Live sandbox message board. */
export function MessageBoard({
  title = "Message board",
  limit = 100,
  className,
  bodyClassName = "max-h-[520px]",
}: {
  title?: string;
  limit?: number;
  className?: string;
  bodyClassName?: string;
}) {
  const { items, error, loading } = useFeed<Message>("messages", (since) => doorway.messages(since), {
    table: "doorway_messages",
    limit,
  });
  return (
    <Panel
      title={title}
      icon="message"
      actions={<LiveBadge />}
      className={className}
      bodyClassName={cx("overflow-y-auto p-0!", bodyClassName)}
    >
      {loading ? (
        <Loading label="Loading messages" className="p-4" />
      ) : error && !items.length ? (
        <div className="p-4">
          <ErrorBanner error={error} />
        </div>
      ) : !items.length ? (
        <Empty icon="message" title="No messages yet" hint="Sandboxes post here when they publish, validate or need a tool." />
      ) : (
        <ol>
          <AnimatePresence initial={false}>
            {items.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </AnimatePresence>
        </ol>
      )}
    </Panel>
  );
}

"use client";

// Shared live feeds: pipeline events and sandbox messages. Each event family has its own
// icon and colour (lib/doorway/format.ts) so a feed reads at a glance on a projector.

import Link from "next/link";
import { doorway, type DoorwayEvent, type Message } from "@/lib/doorway";
import { clockTime, eventStyle, MESSAGE_STYLE, messageSummary, TONE_COLOR } from "@/lib/doorway/format";
import { useFeed } from "@/lib/doorway/live";
import { LiveBadge } from "@/components/px/client";
import { PixelIcon } from "@/components/px/icons";
import { cx, Empty, ErrorBanner, Loading, Panel } from "@/components/px/ui";

export function EventRow({ event, showSite = true }: { event: DoorwayEvent; showSite?: boolean }) {
  const style = eventStyle(event.kind);
  const color = TONE_COLOR[style.tone];
  return (
    <li className="px-rise grid grid-cols-[auto_auto_1fr] items-start gap-x-2 border-b border-line/60 px-1 py-1.5 last:border-0">
      <span className="pt-0.5 text-sm tabular-nums text-faint">{clockTime(event.created_at)}</span>
      <span className="pt-1" style={{ color }}>
        <PixelIcon name={style.icon} size={12} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-pixel text-[8px] uppercase" style={{ color }}>
            {event.kind}
          </span>
          {event.sandbox_id && <span className="text-sm text-violet">{event.sandbox_id}</span>}
          {showSite && event.site_id && (
            <Link href={`/sites/${event.site_id}`} className="text-sm text-muted hover:text-green">
              {event.site_id}
            </Link>
          )}
        </div>
        <p className="break-words text-base leading-tight text-text">{event.message}</p>
      </div>
    </li>
  );
}

export function MessageRow({ message }: { message: Message }) {
  const style = MESSAGE_STYLE[message.kind] ?? MESSAGE_STYLE.hello;
  const color = TONE_COLOR[style.tone];
  return (
    <li className="px-rise flex items-start gap-2 border-b border-line/60 px-1 py-1.5 last:border-0">
      <span className="pt-0.5 text-sm tabular-nums text-faint">{clockTime(message.created_at)}</span>
      <span className="pt-1" style={{ color }}>
        <PixelIcon name={style.icon} size={12} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-base">
          <span className="text-violet">{message.from_sandbox}</span>
          <span className="text-faint">→</span>
          <span className="text-muted">{message.to_sandbox ?? "all"}</span>
          <span className="font-pixel ml-1 text-[8px] uppercase" style={{ color }}>
            {message.kind}
          </span>
        </div>
        <p className="break-words text-base leading-tight text-text">{messageSummary(message.body)}</p>
      </div>
    </li>
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
      icon="message"
      actions={<LiveBadge />}
      className={className}
      bodyClassName={cx("overflow-y-auto", bodyClassName)}
    >
      {loading ? (
        <Loading label="Tuning in" />
      ) : error && !items.length ? (
        <ErrorBanner error={error} />
      ) : !items.length ? (
        <Empty icon="message" title="No events yet" hint="Add a site or run a tool and the pipeline will start talking." />
      ) : (
        <ol>
          {items.map((e) => (
            <EventRow key={e.id} event={e} showSite={!siteId} />
          ))}
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
      bodyClassName={cx("overflow-y-auto", bodyClassName)}
    >
      {loading ? (
        <Loading label="Listening" />
      ) : error && !items.length ? (
        <ErrorBanner error={error} />
      ) : !items.length ? (
        <Empty icon="message" title="Quiet board" hint="Sandboxes post here when they publish, validate or need a tool." />
      ) : (
        <ol>
          {items.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

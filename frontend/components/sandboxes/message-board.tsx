"use client";

// Sandbox message board: one line per post — "sandbox-1 → all · pattern_published ·
// slot_booking". Sandbox names keep their fleet colour; the newest post flashes once.

import type { Message } from "@/lib/doorway";
import { clockTime, MESSAGE_STYLE, messageSummary, TONE_COLOR } from "@/lib/doorway/format";
import type { FeedResult } from "@/lib/doorway/live";
import { PixelIcon } from "@/components/px/icons";
import { Empty, ErrorBanner, Loading, Panel } from "@/components/px/ui";
import { flashOnMount, PanelNote, SandboxName, SiteLink, StaleNote } from "./shared";

function str(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}

/** "book_table v2 · reason", plus the site the post is about (rendered as a link). */
function describeBody(body: Message["body"]): { text: string; site: string | null } {
  if (!body) return { text: "", site: null };
  const parts: string[] = [];
  const name = str(body, "name") ?? str(body, "tool") ?? str(body, "pattern") ?? str(body, "capability");
  const version = str(body, "version");
  const v = version && (version.startsWith("v") ? version : `v${version}`);
  if (name) parts.push(v ? `${name} ${v}` : name);
  else if (v) parts.push(v);
  for (const key of ["strategy", "text", "reason", "error"]) {
    const value = str(body, key);
    if (value) parts.push(value);
  }
  const site = str(body, "site_id");
  if (!parts.length && !site) return { text: messageSummary(body), site: null };
  return { text: parts.join(" · "), site };
}

export function SandboxMessages({ feed, className }: { feed: FeedResult<Message>; className?: string }) {
  const { items, error, loading } = feed;
  return (
    <Panel
      title="Message board"
      icon="message"
      className={className}
      bodyClassName="max-h-[640px] overflow-y-auto"
      actions={items.length ? <span className="text-base text-muted">{items.length} recent</span> : undefined}
    >
      <PanelNote icon="message">
        Sandboxes post to everyone (or one peer) when they publish, validate, find something broken or need a tool.
      </PanelNote>
      {loading ? (
        <Loading label="Listening" />
      ) : error && !items.length ? (
        <ErrorBanner error={error} />
      ) : !items.length ? (
        <Empty icon="message" title="Quiet board" hint="Posts appear as soon as a sandbox learns or checks something." />
      ) : (
        <>
          <StaleNote error={error} className="mb-2" />
          <ol>
            {items.map((m, i) => (
              <BoardRow key={m.id} message={m} newest={i === 0} />
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}

function BoardRow({ message: m, newest }: { message: Message; newest: boolean }) {
  const style = MESSAGE_STYLE[m.kind] ?? MESSAGE_STYLE.hello;
  const color = TONE_COLOR[style.tone];
  const { text, site } = describeBody(m.body);
  return (
    <li
      ref={newest ? flashOnMount : undefined}
      className="px-rise grid grid-cols-[auto_auto_1fr] items-start gap-x-2 border-b border-line/60 px-1 py-1.5 last:border-0"
    >
      <span className="pt-0.5 text-sm tabular-nums text-faint">{clockTime(m.created_at)}</span>
      <span className="pt-1" style={{ color }}>
        <PixelIcon name={style.icon} size={12} />
      </span>
      <p className="min-w-0 break-words text-lg leading-tight">
        <SandboxName id={m.from_sandbox} />
        <span className="text-faint"> → </span>
        <SandboxName id={m.to_sandbox} fallback="all" />
        <span className="text-faint"> · </span>
        <span className="font-pixel text-[8px] uppercase" style={{ color }}>
          {m.kind}
        </span>
        {text && (
          <>
            <span className="text-faint"> · </span>
            <span className="text-text">{text}</span>
          </>
        )}
        {site && (
          <>
            <span className="text-faint"> · </span>
            <SiteLink id={site} />
          </>
        )}
      </p>
    </li>
  );
}

"use client";

// Version history and recent runs for one tool.

import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { STRATEGIES, type Run, type RunMode, type ToolVersion, type VersionSource } from "@/lib/doorway";
import { clockTime, fmtInt, fmtMs, fmtTokens, type Tone } from "@/lib/doorway/format";
import { TimeAgo } from "@/components/px/client";
import { Badge, cx, Empty } from "@/components/px/ui";
import { CopyText, shortRef } from "./copy-text";

const SOURCE_TONE: Record<VersionSource, Tone> = {
  discover: "info",
  reuse: "violet",
  heal: "warn",
  reverify: "ok",
  seed: "muted",
};

const MODE_TONE: Record<RunMode, Tone> = {
  broker: "ok",
  browser_agent: "violet",
  dashboard: "info",
  verify: "muted",
};

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      scope="col"
      className={cx(
        "whitespace-nowrap border-b border-line bg-panel-2 px-3 py-2 font-mono text-[11px] font-normal uppercase tracking-wider text-faint",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, right, className }: { children: ReactNode; right?: boolean; className?: string }) {
  return (
    <td
      className={cx(
        "whitespace-nowrap border-b border-line px-3 py-2 align-middle",
        right && "text-right tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}

function StrategySummary({ strategies }: { strategies: ToolVersion["strategies"] }) {
  const parts = STRATEGIES.flatMap((s) => {
    const r = strategies[s];
    return r ? [{ s, r }] : [];
  });
  if (!parts.length) return <span className="text-faint">—</span>;
  return (
    <span className="flex flex-wrap gap-x-2.5">
      {parts.map(({ s, r }) => (
        <span key={s} className={cx("inline-flex items-center gap-1 font-mono text-xs tabular-nums", r.passed ? "text-text" : "text-red")}>
          <span className="text-faint">{s}</span>
          {r.ms != null ? fmtMs(r.ms) : ""}
          {r.passed ? (
            <Check size={12} strokeWidth={2} className="text-green" aria-label="passed" />
          ) : (
            <X size={12} strokeWidth={2} aria-label="failed" />
          )}
        </span>
      ))}
    </span>
  );
}

export function VersionTable({ versions }: { versions: ToolVersion[] }) {
  if (!versions.length) {
    return <Empty icon="clock" title="No versions yet" hint="A version is recorded each time a sandbox verifies the tool." />;
  }
  const rows = [...versions].sort((a, b) => b.version - a.version);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Ver</Th>
            <Th>Status</Th>
            <Th>Source</Th>
            <Th>Verified by</Th>
            <Th>Strategies</Th>
            <Th right>Created</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => (
            <tr key={v.version} className="transition-colors hover:bg-panel-2">
              <Td>
                <span className={cx("font-mono tabular-nums", i === 0 ? "text-green" : "text-text")}>v{v.version}</span>
                {i === 0 && <span className="ml-2 text-[11px] text-faint">latest</span>}
              </Td>
              <Td>
                <Badge status={v.status} />
              </Td>
              <Td>
                <Badge tone={SOURCE_TONE[v.source] ?? "muted"} pulse={false}>
                  {v.source}
                </Badge>
              </Td>
              <Td>
                <span className="font-mono text-xs text-muted">{v.verified_by ?? "—"}</span>
              </Td>
              <Td>
                <StrategySummary strategies={v.strategies} />
              </Td>
              <Td right>
                <TimeAgo iso={v.created_at} className="text-xs text-muted" />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunTable({ runs, limit = 25 }: { runs: Run[]; limit?: number }) {
  if (!runs.length) {
    return <Empty icon="execute" title="No runs yet" hint="Use Try it, or connect an agent, and every call lands here." />;
  }
  const rows = [...runs].sort((a, b) => b.id - a.id).slice(0, limit);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Time</Th>
            <Th>Mode</Th>
            <Th>Strategy</Th>
            <Th>Status</Th>
            <Th right>ms</Th>
            <Th right>Steps</Th>
            <Th right>Tokens</Th>
            <Th>Payment</Th>
            <Th>Error</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="animate-rise transition-colors hover:bg-panel-2">
              <Td>
                <TimeAgo iso={r.created_at} className="text-xs text-muted" />
                <span className="ml-2 font-mono text-[11px] tabular-nums text-faint">{clockTime(r.created_at)}</span>
              </Td>
              <Td>
                <Badge tone={MODE_TONE[r.mode] ?? "muted"} pulse={false}>
                  {r.mode}
                </Badge>
              </Td>
              <Td>
                <span className="font-mono text-xs text-text">{r.strategy ?? "—"}</span>
              </Td>
              <Td>
                {r.status === "success" ? (
                  <Badge tone="ok" pulse={false}>
                    Success
                  </Badge>
                ) : (
                  <Badge tone="bad" pulse={false}>
                    Failed
                  </Badge>
                )}
              </Td>
              <Td right className="font-mono text-xs">{fmtMs(r.ms)}</Td>
              <Td right className="font-mono text-xs">{fmtInt(r.steps)}</Td>
              <Td right className="font-mono text-xs">{fmtTokens(r.tokens)}</Td>
              <Td>
                {r.paid_reference ? (
                  <CopyText value={r.paid_reference} className="font-mono text-xs text-muted">
                    {shortRef(r.paid_reference)}
                  </CopyText>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </Td>
              <Td className="max-w-[280px]">
                {r.error ? (
                  <span className="block truncate text-xs text-red" title={r.error}>
                    {r.error}
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

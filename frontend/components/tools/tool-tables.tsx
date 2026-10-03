"use client";

// Version history and recent runs for one tool.

import type { ReactNode } from "react";
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
        "font-pixel whitespace-nowrap px-2 pb-2 text-[8px] font-normal uppercase text-faint",
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
        "whitespace-nowrap border-t border-line/70 px-2 py-1.5 align-middle",
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
        <span key={s} className={r.passed ? "text-text" : "text-red"}>
          <span className="text-muted">{s}</span> {r.ms != null ? fmtMs(r.ms) : ""} {r.passed ? "✓" : "✗"}
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
      <table className="w-full border-collapse text-base">
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
            <tr key={v.version} className={i === 0 ? "bg-panel-2" : undefined}>
              <Td>
                <span className={i === 0 ? "text-green" : "text-text"}>v{v.version}</span>
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
                <span className="text-violet">{v.verified_by ?? "—"}</span>
              </Td>
              <Td>
                <StrategySummary strategies={v.strategies} />
              </Td>
              <Td right>
                <TimeAgo iso={v.created_at} className="text-muted" />
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
      <table className="w-full border-collapse text-base">
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
            <tr key={r.id} className="px-rise">
              <Td>
                <TimeAgo iso={r.created_at} className="text-muted" />
                <span className="ml-2 text-sm text-faint">{clockTime(r.created_at)}</span>
              </Td>
              <Td>
                <Badge tone={MODE_TONE[r.mode] ?? "muted"} pulse={false}>
                  {r.mode}
                </Badge>
              </Td>
              <Td>
                <span className="text-text">{r.strategy ?? "—"}</span>
              </Td>
              <Td>
                {r.status === "success" ? (
                  <span className="text-green" title="success">
                    ✓
                  </span>
                ) : (
                  <span className="text-red" title="failure">
                    ✗
                  </span>
                )}
              </Td>
              <Td right>{fmtMs(r.ms)}</Td>
              <Td right>{fmtInt(r.steps)}</Td>
              <Td right>{fmtTokens(r.tokens)}</Td>
              <Td>
                {r.paid_reference ? (
                  <CopyText value={r.paid_reference} className="text-gold">
                    {shortRef(r.paid_reference)}
                  </CopyText>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </Td>
              <Td className="max-w-[280px]">
                {r.error ? (
                  <span className="block truncate text-red" title={r.error}>
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

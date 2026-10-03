"use client";

// Live check: talk MCP to the endpoint from the browser (initialize + tools/list), so you can
// see the server answer before adding it to an agent.

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/px/icons";
import { Button, Panel, Spinner, StatusDot } from "@/components/px/ui";

type McpTool = { name: string; description?: string };
type Check =
  | { state: "checking" }
  | { state: "ok"; ms: number; server: string; tools: McpTool[] }
  | { state: "error"; message: string };

// Stateless streamable HTTP: the answer is JSON or a one-event SSE stream.
async function rpc(url: string, id: number, method: string, params?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("data: {")) ?? text;
  const msg = JSON.parse(line.replace(/^data: /, "")) as { result?: unknown; error?: { message?: string } };
  if (msg.error) throw new Error(msg.error.message ?? "MCP error");
  return msg.result;
}

async function check(url: string): Promise<Check> {
  const started = performance.now();
  try {
    const init = (await rpc(url, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "doorway-dashboard", version: "1" },
    })) as { serverInfo?: { name?: string; version?: string } };
    const list = (await rpc(url, 2, "tools/list")) as { tools?: McpTool[] };
    const info = init.serverInfo;
    return {
      state: "ok",
      ms: Math.round(performance.now() - started),
      server: info ? `${info.name ?? "mcp"} ${info.version ?? ""}`.trim() : "mcp",
      tools: list.tools ?? [],
    };
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export function LiveCheck({ url }: { url: string }) {
  const [result, setResult] = useState<{ url: string; check: Check } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    check(url).then((c) => {
      if (!cancelled) setResult({ url, check: c });
    });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  const retest = useCallback(() => {
    setResult(null);
    setNonce((n) => n + 1);
  }, []);

  const c: Check = result && result.url === url ? result.check : { state: "checking" };

  return (
    <Panel
      title="Live check"
      icon="live"
      actions={
        <Button size="sm" variant="ghost" onClick={retest} disabled={c.state === "checking"}>
          Test again
        </Button>
      }
    >
      {c.state === "checking" ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner /> Calling the MCP server from your browser…
        </div>
      ) : c.state === "error" ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[13px] text-red">
            <StatusDot tone="bad" /> Not reachable
          </div>
          <p className="text-xs text-faint">{c.message}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span className="flex items-center gap-2 text-green">
              <StatusDot tone="ok" /> Connected
            </span>
            <span className="text-muted">
              {c.tools.length} tool{c.tools.length === 1 ? "" : "s"} · {c.ms} ms
            </span>
            <span className="font-mono text-xs text-faint">{c.server}</span>
          </div>
          {c.tools.length ? (
            <ul className="flex flex-col gap-1">
              {c.tools.map((t) => (
                <li key={t.name} className="flex items-center gap-2 font-mono text-xs text-text">
                  <Icon name="tool" size={12} className="shrink-0 text-faint" />
                  <span className="truncate">{t.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">The server answers but has no verified tools yet.</p>
          )}
          <p className="text-xs text-faint">This is exactly what your agent sees after you add the server.</p>
        </div>
      )}
    </Panel>
  );
}

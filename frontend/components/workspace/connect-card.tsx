"use client";

// "Connect your agent" on the Workspace: one command per agent, one-click links for editors,
// and a live count of the tools the agent gets.

import Link from "next/link";
import { useState } from "react";
import { doorway, mcpUrl } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";
import { DoorwayMark } from "@/components/brand/doorway-logo";
import { CopyCommand } from "@/components/px/client";
import { Icon } from "@/components/px/icons";
import { cx, StatusDot } from "@/components/px/ui";

type Agent = "claude" | "codex" | "gemini" | "cursor" | "vscode";

const AGENTS: { id: Agent; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
];

function command(agent: Agent, url: string): string {
  if (agent === "codex") return `codex mcp add doorway --url ${url}`;
  if (agent === "gemini") return `gemini mcp add --transport http doorway ${url}`;
  if (agent === "vscode") return `code --add-mcp '${JSON.stringify({ name: "doorway", type: "http", url })}'`;
  if (agent === "cursor") return url;
  return `claude mcp add --scope user --transport http doorway ${url}`;
}

function oneClick(agent: Agent, url: string): string | null {
  if (agent === "cursor") {
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=doorway&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`;
  }
  if (agent === "vscode") {
    return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "doorway", type: "http", url }))}`;
  }
  return null;
}

export function ConnectCard({ active }: { active: boolean }) {
  const [agent, setAgent] = useState<Agent>("claude");
  const url = mcpUrl();
  const tools = useLive(active ? "ws:connect-tools" : null, () => doorway.tools(), {
    tables: ["doorway_tools"],
    pollMs: 10000,
    livePollMs: 20000,
  });
  const live = (tools.data ?? []).filter((t) => t.status === "verified" || t.status === "repairing");
  const link = oneClick(agent, url);

  return (
    <section className="px-panel overflow-hidden">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-green/30 bg-green/10 text-text">
              <DoorwayMark size={22} />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight text-text">Connect your agent</h2>
              <p className="text-[13px] text-muted">
                One command adds every verified website tool to your agent over MCP. Reads are free; actions are $0.50 per
                call.
              </p>
            </div>
          </div>

          <div role="tablist" aria-label="Agent" className="flex flex-wrap gap-1.5">
            {AGENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={agent === a.id}
                onClick={() => setAgent(a.id)}
                className={cx(
                  "h-7 rounded-full border px-3 text-xs transition-colors",
                  agent === a.id
                    ? "border-green/40 bg-green/10 text-green"
                    : "border-line text-muted hover:border-line-2 hover:text-text",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            {link ? (
              <div className="flex flex-wrap items-center gap-3">
                <a href={link} className="px-btn">
                  <Icon name="plus" size={15} />
                  Add to {AGENTS.find((a) => a.id === agent)?.label}
                </a>
                <span className="text-xs text-faint">or paste the server URL in its MCP settings:</span>
              </div>
            ) : null}
            <CopyCommand command={command(agent, url)} />
          </div>

          <p className="text-xs text-faint">
            Then ask: <span className="text-muted">&ldquo;Which doctors work at Sunrise Family Clinic, and what times does Dr. Khan have tomorrow?&rdquo;</span>{" "}
            <Link href="/dashboard?tab=install" className="text-green underline-offset-2 hover:underline">
              More agents and options
            </Link>
          </p>
        </div>

        <div className="flex flex-col gap-3 border-t border-line bg-bg-2/60 p-5 lg:border-l lg:border-t-0">
          <div className="flex items-center gap-2 text-[13px]">
            <StatusDot tone={tools.error ? "bad" : "ok"} pulse={!tools.error} />
            <span className={tools.error ? "text-red" : "text-text"}>
              {tools.error ? "MCP server unreachable" : "MCP server live"}
            </span>
            <span className="ml-auto font-mono text-xs tabular-nums text-faint">{tools.data ? `${live.length} tools` : "…"}</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {live.slice(0, 6).map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-xs">
                <Icon name="tool" size={12} className="shrink-0 text-faint" />
                <span className="truncate font-mono text-text">
                  <span className="text-faint">{t.site_id}__</span>
                  {t.name}
                </span>
                <span className={cx("ml-auto shrink-0 font-mono", t.price_cents ? "text-muted" : "text-green")}>
                  {t.price_cents ? `$${(t.price_cents / 100).toFixed(2)}` : "free"}
                </span>
              </li>
            ))}
            {!tools.data && !tools.error && <li className="text-xs text-faint">Loading tools…</li>}
            {tools.data && !live.length && <li className="text-xs text-faint">No verified tools yet.</li>}
          </ul>
          <p className="mt-auto truncate font-mono text-[11px] text-faint" title={url}>
            {url}
          </p>
        </div>
      </div>
    </section>
  );
}

"use client";

// Install: put Doorway's verified tools into an agent (Claude Code, Codex, Claude Desktop,
// Cursor, VS Code, Gemini CLI or plain HTTP), check the server live, then try a prompt.

import { useState, type ReactNode } from "react";
import { useDashboardNav } from "@/components/dashboard/nav";
import { Icon } from "@/components/px/icons";
import { Badge, cx, Empty, ErrorBanner, Field, Panel, Select, Skeleton } from "@/components/px/ui";
import { doorway, doorwayBaseUrl, mcpUrl, type Site, type Tool } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";
import { CodeBlock, CopyButton, CopyLine } from "./copy";
import { exampleArgs, priceLabel } from "./health";
import { LiveCheck } from "./live-check";
import { Segmented } from "./segmented";

type Client = "claude-code" | "codex" | "claude-desktop" | "cursor" | "vscode" | "gemini" | "http";

const CLIENTS: readonly { value: Client; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "http", label: "Any agent" },
];

// Things to ask once the server is added (they hit the real demo websites).
const PROMPTS = [
  "Which doctors work at Sunrise Family Clinic, and what times does Dr. Khan have tomorrow?",
  "Search the City Library catalog for books about Ada Lovelace.",
  "Book the earliest slot with Dr. Khan tomorrow for Demo Patient, phone 555-0100.",
];

const cursorLink = (name: string, url: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(
    btoa(JSON.stringify({ url })),
  )}`;

const vscodeLink = (name: string, url: string) =>
  `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "http", url }))}`;

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function apiBase(): string {
  return doorwayBaseUrl() || mcpUrl().replace(/\/doorway\/mcp$/, "");
}

export function InstallTab({ active }: { active: boolean }) {
  const { tab, intent } = useDashboardNav();
  const [siteId, setSiteId] = useState(intent.siteId ?? "");
  const [client, setClient] = useState<Client>("claude-code");
  const [toolKey, setToolKey] = useState("");

  const [seenIntent, setSeenIntent] = useState(intent);
  if (intent !== seenIntent) {
    setSeenIntent(intent);
    if (tab === "install" && intent.siteId) setSiteId(intent.siteId);
  }

  const sites = useLive(active ? "install:sites" : null, () => doorway.sites(), { pollMs: 15000, livePollMs: 30000 });
  const tools = useLive(
    active ? `install:tools:${siteId || "all"}` : null,
    () => doorway.tools(siteId || undefined),
    { tables: ["doorway_tools"], pollMs: 8000, livePollMs: 15000 },
  );

  if (!active) return null;

  const api = apiBase();
  const site = sites.data?.find((s) => s.id === siteId);
  const url = siteId ? (site?.mcp_url ?? mcpUrl(siteId)) : mcpUrl();
  const serverName = siteId ? `doorway-${siteId}` : "doorway";
  // What the MCP endpoint lists: verified tools, plus repairing ones (they still run via a fallback).
  const verified = (tools.data ?? []).filter((t) => t.status === "verified" || t.status === "repairing");
  const pending = (tools.data ?? []).length - verified.length;
  const chosen = verified.find((t) => String(t.id) === toolKey) ?? verified[0];
  const openapiSites: Pick<Site, "id" | "name">[] = siteId
    ? [{ id: siteId, name: site?.name ?? siteId }]
    : (sites.data ?? []);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        {/* 1. Endpoint */}
        <Panel title="1. Pick an endpoint" icon="globe">
          <div className="flex flex-col gap-3">
            <Field
              label="Websites"
              hint={
                siteId
                  ? "Only this website's tools, named by tool (e.g. search_books)."
                  : "Every verified tool, named <site>__<tool> (e.g. city-library__search_books)."
              }
            >
              <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">All websites</option>
                {(sites.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {siteId && !site && <option value={siteId}>{siteId}</option>}
              </Select>
            </Field>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">MCP server URL</div>
              <CopyLine value={url} />
              <p className="mt-1.5 text-xs text-faint">Streamable HTTP, stateless, no account needed. POST only.</p>
            </div>
            {sites.error !== undefined && <ErrorBanner error={sites.error} />}
          </div>
        </Panel>

        {/* 2. Client */}
        <Panel title="2. Add it to your agent" icon="agent" bodyClassName="flex flex-col gap-4">
          <div className="overflow-x-auto">
            <Segmented label="Agent" value={client} onChange={setClient} options={CLIENTS} />
          </div>
          {client === "claude-code" && (
            <Steps>
              <Step n={1} title="Add it (one command, every project)">
                <CopyLine prompt value={`claude mcp add --scope user --transport http ${serverName} ${url}`} />
              </Step>
              <Step n={2} title="Check it's connected">
                <CopyLine prompt value="claude mcp list" />
                <Expect line={`${serverName}: ${url} (HTTP) - ✔ Connected`} />
                <p className="text-xs text-faint">
                  Inside a session, <span className="font-mono">/mcp</span> lists the tools.
                </p>
              </Step>
              <Step n={3} title="Run claude and ask">
                <TryPrompts />
              </Step>
              <OwnerKey serverName={serverName} url={url} />
            </Steps>
          )}
          {client === "codex" && (
            <Steps>
              <Step n={1} title="Add it">
                <CopyLine prompt value={`codex mcp add ${serverName} --url ${url}`} />
              </Step>
              <Step n={2} title="Check it's there">
                <CopyLine prompt value="codex mcp list" />
              </Step>
              <Step n={3} title="Run codex and ask">
                <TryPrompts />
              </Step>
            </Steps>
          )}
          {client === "claude-desktop" && (
            <Steps>
              <Step n={1} title="Add a custom connector">
                <p className="text-xs text-muted">Settings → Connectors → Add custom connector, then paste:</p>
                <CopyLine value={url} />
              </Step>
              <Step n={2} title="Or edit claude_desktop_config.json (needs Node.js)">
                <p className="text-xs text-muted">Settings → Developer → Edit Config, add this, restart Claude Desktop:</p>
                <CodeBlock
                  caption="claude_desktop_config.json"
                  code={JSON.stringify(
                    { mcpServers: { [serverName]: { command: "npx", args: ["-y", "mcp-remote", url] } } },
                    null,
                    2,
                  )}
                />
              </Step>
              <Step n={3} title="Open a new chat and ask">
                <TryPrompts />
              </Step>
            </Steps>
          )}
          {client === "cursor" && (
            <Steps>
              <Step n={1} title="One click">
                <a href={cursorLink(serverName, url)} className="px-btn self-start">
                  <Icon name="plus" size={15} />
                  Add to Cursor
                </a>
              </Step>
              <Step n={2} title="Or add it to ~/.cursor/mcp.json">
                <CodeBlock caption="~/.cursor/mcp.json" code={JSON.stringify({ mcpServers: { [serverName]: { url } } }, null, 2)} />
              </Step>
              <Step n={3} title="Ask in Cursor's agent chat">
                <TryPrompts />
              </Step>
            </Steps>
          )}
          {client === "vscode" && (
            <Steps>
              <Step n={1} title="One click">
                <a href={vscodeLink(serverName, url)} className="px-btn self-start">
                  <Icon name="plus" size={15} />
                  Add to VS Code
                </a>
              </Step>
              <Step n={2} title="Or from a terminal">
                <CopyLine prompt value={`code --add-mcp '${JSON.stringify({ name: serverName, type: "http", url })}'`} />
              </Step>
              <Step n={3} title="Ask in Copilot Chat (agent mode)">
                <TryPrompts />
              </Step>
            </Steps>
          )}
          {client === "gemini" && (
            <Steps>
              <Step n={1} title="Add it">
                <CopyLine prompt value={`gemini mcp add --transport http ${serverName} ${url}`} />
              </Step>
              <Step n={2} title="Check it's there">
                <CopyLine prompt value="gemini mcp list" />
              </Step>
              <Step n={3} title="Run gemini and ask">
                <TryPrompts />
              </Step>
            </Steps>
          )}
          {client === "http" && (
            <HttpGuide api={api} url={url} tools={verified} chosen={chosen} onChoose={setToolKey} loading={!tools.data} />
          )}
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <LiveCheck url={url} />

        {/* Tools on this endpoint */}
        <Panel
          title="Tools on this endpoint"
          icon="tool"
          actions={tools.data ? <span className="font-mono text-xs tabular-nums text-faint">{verified.length}</span> : null}
          bodyClassName="p-0"
        >
          {tools.error !== undefined ? (
            <div className="p-4">
              <ErrorBanner error={tools.error} />
            </div>
          ) : !tools.data ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : verified.length ? (
            <ul className="divide-y divide-line">
              {verified.map((t) => (
                <li key={t.id} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-[13px] text-text">
                        {!siteId && <span className="text-faint">{t.site_id}__</span>}
                        {t.name}
                      </span>
                      {t.status === "repairing" && <Badge status="repairing" />}
                    </div>
                    {t.description && <p className="line-clamp-2 text-xs text-faint">{t.description}</p>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className={cx("font-mono text-xs tabular-nums", t.price_cents ? "text-text" : "text-green")}>
                      {priceLabel(t.price_cents)}
                    </span>
                    <Badge tone={t.kind === "action" ? "gold" : "info"}>{t.kind}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              icon="tool"
              title="No verified tools yet"
              hint="Add a website on the Websites tab. Tools appear here once a sandbox verifies them."
            />
          )}
          {pending > 0 && (
            <p className="border-t border-line px-4 py-2 text-xs text-faint">
              {pending} more tool{pending > 1 ? "s" : ""} not live yet (draft or broken): agents get them once verified. See Tools for why.
            </p>
          )}
        </Panel>

        {/* Payments */}
        <Panel title="How payments work" icon="coin">
          <ul className="flex flex-col gap-2 text-[13px] text-muted">
            <Note>
              <span className="text-text">Reads are free</span> (search, list, look up).
            </Note>
            <Note>
              <span className="text-text">Actions cost $0.50 per call</span> (book, hold, send). Paid per call with the
              Machine Payments Protocol on Stripe: the call returns <span className="font-mono text-text">402</span> with a
              payment challenge, the agent pays, then retries with an{" "}
              <span className="font-mono text-text">Authorization: Payment</span> header.
            </Note>
            <Note>
              Over MCP, a paid tool answers with a <span className="font-mono text-text">paymentLink</span> (its{" "}
              <span className="font-mono">/doorway/run</span> URL) instead of running, so the agent pays there.
            </Note>
            <Note>Missing inputs are rejected before any charge; a failed run says whether it&apos;s refundable.</Note>
          </ul>
        </Panel>

        {/* Docs for agents */}
        <Panel title="Machine-readable docs" icon="database" bodyClassName="flex flex-col gap-3">
          <DocLink label="llms.txt" hint="Every tool with its run URL and price" href={`${api}/llms.txt`} />
          {openapiSites.map((s) => (
            <DocLink
              key={s.id}
              label={`OpenAPI · ${s.name}`}
              hint="Verified tools as OpenAPI 3.1"
              href={`${api}/doorway/sites/${s.id}/openapi.json`}
            />
          ))}
        </Panel>
      </div>
    </div>
  );
}

function HttpGuide({
  api,
  url,
  tools,
  chosen,
  onChoose,
  loading,
}: {
  api: string;
  url: string;
  tools: Tool[];
  chosen: Tool | undefined;
  onChoose: (id: string) => void;
  loading: boolean;
}) {
  const listTools = [
    `curl -X POST ${url} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Accept: application/json, text/event-stream' \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  ].join("\n");

  return (
    <Steps>
      <Step n={1} title="Call a tool directly">
        {loading ? (
          <Skeleton className="h-24" />
        ) : chosen ? (
          <div className="flex flex-col gap-2">
            <Select value={String(chosen.id)} onChange={(e) => onChoose(e.target.value)} aria-label="Tool">
              {tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.site_id}/{t.name} · {priceLabel(t.price_cents)}
                </option>
              ))}
            </Select>
            <CodeBlock
              caption={`${chosen.kind} · ${priceLabel(chosen.price_cents)}`}
              code={[
                `curl -X POST ${api}/doorway/run/${chosen.site_id}/${chosen.name} \\`,
                `  -H 'Content-Type: application/json' \\`,
                `  -d ${shellQuote(JSON.stringify({ arguments: exampleArgs(chosen.input_schema) }))}`,
              ].join("\n")}
            />
            <p className="text-xs text-faint">
              {chosen.kind === "read"
                ? "Free: returns 200 with { ok, data, strategy, ms }."
                : "Paid: the first call returns 402 with a WWW-Authenticate: Payment challenge. Pay it via Stripe (MPP), then retry with Authorization: Payment <credential>. The 200 carries a Payment-Receipt header."}{" "}
              Replace the &lt;placeholders&gt; with real values.
            </p>
          </div>
        ) : (
          <p className="text-xs text-faint">No verified tools on this endpoint yet.</p>
        )}
      </Step>
      <Step n={2} title="Or speak MCP over HTTP">
        <CodeBlock caption="tools/list" code={listTools} />
      </Step>
    </Steps>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-4">{children}</ol>;
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-5 shrink-0 place-items-center rounded-full border border-line-2 font-mono text-[11px] text-muted">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-[13px] font-medium text-text">{title}</div>
        {children}
      </div>
    </li>
  );
}

function Expect({ line }: { line: string }) {
  return (
    <p className="font-mono text-xs text-faint">
      expect: <span className="text-green">{line}</span>
    </p>
  );
}

function TryPrompts() {
  return (
    <div className="flex flex-col gap-1.5">
      {PROMPTS.map((p) => (
        <CopyLine key={p} value={p} />
      ))}
      <p className="text-xs text-faint">
        Reads are free. The booking is an action: it comes back as a $0.50 payment link unless you use the owner key.
      </p>
    </div>
  );
}

function OwnerKey({ serverName, url }: { serverName: string; url: string }) {
  return (
    <li className="ml-8">
      <details className="group rounded-md border border-line bg-bg-2 px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted group-open:mb-2">
          Owner mode: let your own Claude run paid actions directly (Stripe test mode)
        </summary>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-faint">
            With the owner key, actions run and are paid in Stripe test mode instead of returning a payment link. Keep the
            key private; replace an existing entry first.
          </p>
          <CopyLine prompt value={`claude mcp remove ${serverName} -s user`} />
          <CopyLine
            prompt
            value={`claude mcp add --scope user --transport http ${serverName} ${url} --header "X-Doorway-Key: $DOORWAY_KEY"`}
          />
        </div>
      </details>
    </li>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <Icon name="chevron" size={13} className="mt-1 shrink-0 text-faint" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function DocLink({ label, hint, href }: { label: string; hint: string; href: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <a href={href} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[13px] text-text hover:text-green">
          <span className="truncate">{label}</span>
          <Icon name="external" size={12} className="shrink-0 text-faint" />
        </a>
        <div className="truncate font-mono text-xs text-faint">{href}</div>
        <div className="text-xs text-faint">{hint}</div>
      </div>
      <CopyButton text={href} />
    </div>
  );
}

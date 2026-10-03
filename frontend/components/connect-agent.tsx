"use client";

import { mcpUrl } from "@/lib/doorway";
import { CopyCommand } from "@/components/px/client";
import { Panel } from "@/components/px/ui";

/** "Connect your agent": the one command an agent needs, plus what it gets. */
export function ConnectAgent({ siteId, className }: { siteId?: string; className?: string }) {
  const url = mcpUrl(siteId);
  const base = url.replace(/\/doorway\/.*$/, "");
  return (
    <Panel title="Connect your agent" icon="agent" className={className}>
      <div className="flex flex-col gap-3">
        <CopyCommand command={`claude mcp add --transport http doorway ${url}`} />
        <ul className="flex flex-col gap-1 text-base text-muted">
          <li>
            <span className="text-green">▸</span> Tools are named{" "}
            <code className="text-text">{siteId ? `${siteId}__<tool>` : "<site_id>__<tool>"}</code>
          </li>
          <li>
            <span className="text-green">▸</span> Reads are free · actions cost{" "}
            <span className="text-gold">$0.50</span> per successful call (Stripe MPP, test mode)
          </li>
          <li>
            <span className="text-green">▸</span> Paid HTTP:{" "}
            <code className="text-text">POST {base}/doorway/run/&lt;site&gt;/&lt;tool&gt;</code> → 402 → pay → retry
          </li>
          <li>
            <span className="text-green">▸</span> Catalog for agents:{" "}
            <a href={`${base}/llms.txt`} target="_blank" rel="noreferrer" className="text-green underline">
              /llms.txt
            </a>
          </li>
        </ul>
      </div>
    </Panel>
  );
}

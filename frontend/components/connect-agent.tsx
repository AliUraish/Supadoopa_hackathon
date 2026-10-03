"use client";

import { CircleDollarSign, FileText, Plus, Receipt, Wrench, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { mcpUrl } from "@/lib/doorway";
import { CopyCommand } from "@/components/px/client";
import { Panel } from "@/components/px/ui";

function Line({ icon: Glyph, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <Glyph size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** "Connect your agent": the one command an agent needs, plus what it gets. */
export function ConnectAgent({ siteId, className }: { siteId?: string; className?: string }) {
  const url = mcpUrl(siteId);
  const base = url.replace(/\/doorway\/.*$/, "");
  return (
    <Panel title="Connect your agent" icon="agent" className={className}>
      <div className="flex flex-col gap-4">
        <CopyCommand command={`claude mcp add --scope user --transport http doorway ${url}`} />
        <ul className="flex flex-col gap-2 text-[13px] text-muted">
          <Line icon={Wrench}>
            Tools are named{" "}
            <code className="font-mono text-xs text-text">{siteId ? `${siteId}__<tool>` : "<site_id>__<tool>"}</code>
          </Line>
          <Line icon={CircleDollarSign}>
            Reads are free. Actions cost <span className="font-mono tabular-nums text-text">$0.50</span> per successful
            call (Stripe MPP, test mode).
          </Line>
          <Line icon={Receipt}>
            Paid HTTP:{" "}
            <code className="break-all font-mono text-xs text-text">
              POST {base}/doorway/run/&lt;site&gt;/&lt;tool&gt;
            </code>{" "}
            returns 402, pay, retry.
          </Line>
          <Line icon={Plus}>
            Codex, Cursor, VS Code, Claude Desktop, Gemini:{" "}
            <Link href="/dashboard?tab=install" className="text-green underline-offset-2 hover:underline">
              Install guide
            </Link>
          </Line>
          <Line icon={FileText}>
            Agent catalog:{" "}
            <a
              href={`${base}/llms.txt`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-green underline-offset-2 hover:underline"
            >
              /llms.txt
            </a>
          </Line>
        </ul>
      </div>
    </Panel>
  );
}

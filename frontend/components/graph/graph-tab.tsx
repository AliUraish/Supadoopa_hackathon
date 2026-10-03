"use client";

// Graph tab: every site → capability → tool → shared pattern, live. Tools recolour as they
// break and self-heal; new sites appear as they are discovered. Click a node to open it.

import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { doorway, type Graph, type Tool } from "@/lib/doorway";
import { TONE_COLOR, type Tone } from "@/lib/doorway/format";
import { useLive } from "@/lib/doorway/live";
import { useDashboardNav } from "@/components/dashboard/dashboard-tabs";
import { LiveBadge } from "@/components/px/client";
import { Button, Empty, ErrorBanner, Loading, Panel, StatusDot } from "@/components/px/ui";
import styles from "./graph.module.css";
import { layoutGraph, nodeKey, type FlowNode } from "./layout";
import { NODE_TYPES } from "./nodes";

interface GraphData {
  graph: Graph;
  tools: Tool[];
}

// Tools enrich tool/capability cards (kind, price, strategy); the graph still renders without them.
async function loadGraph(): Promise<GraphData> {
  const [graph, tools] = await Promise.all([doorway.graph(), doorway.tools().catch((): Tool[] => [])]);
  return { graph, tools };
}

/** Site ids in the order this view first saw them, so new sites append instead of reshuffling. */
function useFirstSeenOrder(ids: readonly string[]): readonly string[] {
  const [seen, setSeen] = useState<readonly string[]>([]);
  const missing = ids.filter((id) => !seen.includes(id));
  if (missing.length) {
    const next = [...seen, ...(seen.length ? missing : [...missing].sort())];
    setSeen(next);
    return next;
  }
  return seen;
}

// Never shrink below readable: a tall graph pans instead of turning into confetti.
const FIT = { padding: 0.08, minZoom: 0.6, maxZoom: 1.1 } as const;

const LEGEND: { label: string; tone: Tone; pulse?: boolean }[] = [
  { label: "verified / ready", tone: "ok" },
  { label: "broken", tone: "bad" },
  { label: "repairing", tone: "warn", pulse: true },
  { label: "discovering / queued", tone: "info" },
  { label: "draft", tone: "muted" },
];

function EdgeSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width="28" height="6" aria-hidden className="shrink-0">
      <line x1="0" y1="3" x2="28" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "6 4" : undefined} />
    </svg>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b-2 border-line px-3 py-2 text-sm text-muted">
      {LEGEND.map((l) => (
        <span key={l.label} className="flex items-center gap-1.5">
          <StatusDot tone={l.tone} pulse={l.pulse ?? false} size={8} />
          {l.label}
        </span>
      ))}
      <span className="mx-1 h-4 w-[2px] bg-line" aria-hidden />
      <span className="flex items-center gap-1.5">
        <EdgeSwatch color={TONE_COLOR.muted} /> has
      </span>
      <span className="flex items-center gap-1.5">
        <EdgeSwatch color={TONE_COLOR.ok} /> compiled to
      </span>
      <span className="flex items-center gap-1.5">
        <EdgeSwatch color={TONE_COLOR.violet} dashed /> reuses pattern
      </span>
    </div>
  );
}

export function GraphTab({ active }: { active: boolean }) {
  const router = useRouter();
  const { goTo } = useDashboardNav();
  const { data, error, loading, refresh } = useLive("graph", loadGraph, {
    tables: ["doorway_tools", "doorway_events", "doorway_jobs"],
    debounceMs: 300,
  });
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);

  const siteIds = useMemo(
    () => (data?.graph.nodes ?? []).filter((n) => n.type === "site").map((n) => n.id),
    [data],
  );
  const siteOrder = useFirstSeenOrder(siteIds);
  const layout = useMemo(
    () => (data ? layoutGraph(data.graph, data.tools, siteOrder) : null),
    [data, siteOrder],
  );
  const shape = layout ? layout.nodes.map((n) => n.id).join(",") : "";

  // Re-frame when the tab is shown (it is display:none while hidden) or the shape changes.
  useEffect(() => {
    if (!active || !flow || !shape) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => void flow.fitView({ ...FIT, duration: 250 }));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [active, flow, shape]);

  const onNodeClick = (_: unknown, node: FlowNode) => {
    if (node.type === "site") router.push(`/sites/${encodeURIComponent(nodeKey(node.id))}`);
    else if (node.type === "tool") router.push(`/tools/${nodeKey(node.id)}`);
    else if (node.type === "capability" && node.data.siteSlug)
      router.push(`/sites/${encodeURIComponent(node.data.siteSlug)}`);
    else if (node.type === "pattern") goTo("sandboxes");
  };

  const c = layout?.counts;
  return (
    <Panel
      title="Capability graph"
      icon="graph"
      bodyClassName="p-0! flex flex-col"
      actions={
        <>
          <LiveBadge />
          <Button
            size="sm"
            variant="ghost"
            icon="graph"
            disabled={!flow || !shape}
            onClick={() => void flow?.fitView({ ...FIT, duration: 250 })}
          >
            Fit
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b-2 border-line bg-panel-2 px-3 py-2 text-base">
        {c ? (
          <>
            <span>
              <span className="text-green">{c.site}</span> <span className="text-muted">sites</span>
            </span>
            <span>
              <span className="text-text">{c.capability}</span> <span className="text-muted">capabilities</span>
            </span>
            <span>
              <span className="text-text">{c.tool}</span> <span className="text-muted">tools</span>{" "}
              <span className="text-faint">
                (<span className="text-green">{c.verified}</span> verified)
              </span>
            </span>
            <span>
              <span className="text-violet">{c.pattern}</span> <span className="text-muted">shared patterns</span>
            </span>
          </>
        ) : (
          <span className="text-muted">Mapping sites…</span>
        )}
        <span className="ml-auto text-sm text-faint">Click a site or tool to open it · scroll to zoom</span>
      </div>
      <Legend />
      {error && layout ? <ErrorBanner error={error} className="m-3" /> : null}

      <div className={`${styles.flow} h-[calc(100vh-300px)] min-h-[520px] w-full`}>
        {loading ? (
          <Loading label="Mapping the graph" className="h-full" />
        ) : !layout ? (
          <div className="flex h-full items-center justify-center p-6">
            <ErrorBanner
              error={error}
              className="w-full max-w-xl"
              action={
                <Button size="sm" variant="ghost" onClick={refresh}>
                  Retry
                </Button>
              }
            />
          </div>
        ) : !layout.nodes.length ? (
          <Empty
            icon="graph"
            title="No sites yet"
            hint="Add one in the Sites tab and watch its capabilities, tools and shared patterns appear here."
            className="h-full"
            action={
              <Button size="sm" icon="plus" onClick={() => goTo("sites")}>
                Add a site
              </Button>
            }
          />
        ) : (
          <ReactFlow<FlowNode, Edge>
            nodes={layout.nodes}
            edges={layout.edges}
            nodeTypes={NODE_TYPES}
            onInit={setFlow}
            onNodeClick={onNodeClick}
            colorMode="dark"
            fitView
            fitViewOptions={FIT}
            minZoom={0.15}
            maxZoom={1.75}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            edgesFocusable={false}
            zoomOnDoubleClick={false}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1.5} color="rgba(62, 207, 142, 0.14)" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        )}
      </div>
    </Panel>
  );
}

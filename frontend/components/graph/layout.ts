// Deterministic left-to-right layout for the capability graph (no dagre).
// Columns: site → capability → tool → pattern. Each site owns a horizontal band holding its
// capabilities and their tools; patterns sit in the last column, centred on the tools that
// reuse them. Positions depend only on ids + structure, so status updates never move a node.

import type { Edge, Node } from "@xyflow/react";
import type { Graph, GraphNode, GraphNodeType, Tool, ToolKind } from "@/lib/doorway/types";
import { statusTone, TONE_COLOR, type Tone } from "@/lib/doorway/format";

export type SiteData = { label: string; status: string | null; slug: string; verified: number; total: number };
export type CapData = { label: string; status: string | null; siteSlug: string | null; kind: ToolKind | null };
export type ToolData = { label: string; status: string | null; tool: Tool | null };
export type PatternData = { label: string; status: string | null; tools: number; sites: number };

export type SiteFlowNode = Node<SiteData, "site">;
export type CapFlowNode = Node<CapData, "capability">;
export type ToolFlowNode = Node<ToolData, "tool">;
export type PatternFlowNode = Node<PatternData, "pattern">;
export type FlowNode = SiteFlowNode | CapFlowNode | ToolFlowNode | PatternFlowNode;

export const NODE_W = 220;
export const NODE_H = 92;
const ROW = 108;
const BAND_GAP = 40;
const COL_X: Record<GraphNodeType, number> = { site: 0, capability: 300, tool: 600, pattern: 960 };

/** Graph colours: like statusTone(), but queued work reads as "in progress" (blue). */
export function nodeTone(status: string | null | undefined): Tone {
  return status === "queued" ? "info" : statusTone(status);
}

/** "tool:31" → 31, "site:bella-bistro" → "bella-bistro". */
export function nodeKey(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

function nodeNum(id: string): number {
  const n = Number(nodeKey(id));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

const byNum = (a: string, b: string) => nodeNum(a) - nodeNum(b) || a.localeCompare(b);

export interface GraphLayout {
  nodes: FlowNode[];
  edges: Edge[];
  counts: Record<GraphNodeType, number> & { verified: number };
}

export function layoutGraph(graph: Graph, tools: Tool[], siteOrder: readonly string[]): GraphLayout {
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  const typeOf = (id: string) => byId.get(id)?.type;
  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const toolsById = new Map(tools.map((t) => [t.id, t]));

  // ── Who belongs to whom ──
  const capSite = new Map<string, string>();
  const toolSite = new Map<string, string>();
  const capTools = new Map<string, string[]>();
  const toolCap = new Map<string, string>();
  for (const e of edges) {
    if (e.type === "has" && typeOf(e.from) === "site") {
      if (typeOf(e.to) === "capability") capSite.set(e.to, e.from);
      else if (typeOf(e.to) === "tool") toolSite.set(e.to, e.from);
    } else if (e.type === "compiled_to" && typeOf(e.from) === "capability" && typeOf(e.to) === "tool") {
      if (!toolCap.has(e.to)) {
        toolCap.set(e.to, e.from);
        capTools.set(e.from, [...(capTools.get(e.from) ?? []), e.to]);
      }
    }
  }
  const siteOfTool = (id: string): string => {
    const cap = toolCap.get(id);
    const viaCap = cap ? capSite.get(cap) : undefined;
    if (viaCap) return viaCap;
    const direct = toolSite.get(id);
    if (direct) return direct;
    const t = toolsById.get(nodeNum(id));
    return t && byId.has(`site:${t.site_id}`) ? `site:${t.site_id}` : "";
  };
  const siteOfCap = (id: string): string => {
    const direct = capSite.get(id);
    if (direct) return direct;
    const first = capTools.get(id)?.[0];
    return first ? siteOfTool(first) : "";
  };

  // ── Bands, one per site ("" = orphans) ──
  type Band = { caps: string[]; looseTools: string[] };
  const bands = new Map<string, Band>();
  const band = (site: string) => {
    let b = bands.get(site);
    if (!b) bands.set(site, (b = { caps: [], looseTools: [] }));
    return b;
  };
  const siteIds = graph.nodes.filter((n) => n.type === "site").map((n) => n.id);
  for (const s of siteIds) band(s);
  for (const n of graph.nodes) {
    if (n.type === "capability") band(siteOfCap(n.id)).caps.push(n.id);
    else if (n.type === "tool" && !toolCap.has(n.id)) band(siteOfTool(n.id)).looseTools.push(n.id);
  }

  const rank = new Map(siteOrder.map((id, i) => [id, i]));
  const ordered = [...bands.keys()].sort((a, b) => {
    if (a === "" || b === "") return a === "" ? 1 : -1;
    return (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a.localeCompare(b);
  });

  const centers = new Map<string, number>();
  const at = (id: string, centerY: number) => centers.set(id, centerY);
  let y = 0;
  for (const site of ordered) {
    const b = bands.get(site)!;
    let row = 0;
    for (const cap of b.caps.sort(byNum)) {
      const ts = (capTools.get(cap) ?? []).sort(byNum);
      const span = Math.max(1, ts.length);
      ts.forEach((t, i) => at(t, y + (row + i) * ROW + ROW / 2));
      at(cap, y + (row + span / 2) * ROW);
      row += span;
    }
    for (const t of b.looseTools.sort(byNum)) at(t, y + row++ * ROW + ROW / 2);
    const rows = Math.max(1, row);
    if (site) at(site, y + (rows * ROW) / 2);
    y += rows * ROW + BAND_GAP;
  }

  // ── Patterns: centred on their reusers, pushed apart so they never overlap ──
  const reusers = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type === "reuses" && typeOf(e.to) === "pattern") reusers.set(e.to, [...(reusers.get(e.to) ?? []), e.from]);
  }
  const patterns = graph.nodes
    .filter((n) => n.type === "pattern")
    .map((n) => {
      const ys = (reusers.get(n.id) ?? []).map((s) => centers.get(s)).filter((v): v is number => v !== undefined);
      return { id: n.id, want: ys.length ? ys.reduce((a, v) => a + v, 0) / ys.length : Infinity };
    })
    .sort((a, b) => a.want - b.want || byNum(a.id, b.id));
  let floor = -Infinity;
  for (const p of patterns) {
    const c = Math.max(Number.isFinite(p.want) ? p.want : ROW / 2, floor);
    at(p.id, c);
    floor = c + ROW;
  }

  // ── Nodes ──
  const nodes: FlowNode[] = [];
  const counts = { site: 0, capability: 0, tool: 0, pattern: 0, verified: 0 };
  const base = (n: GraphNode) => ({
    id: n.id,
    position: { x: COL_X[n.type], y: (centers.get(n.id) ?? 0) - NODE_H / 2 },
    width: NODE_W,
    height: NODE_H,
  });
  for (const n of graph.nodes) {
    if (!centers.has(n.id) || !(n.type in COL_X)) continue;
    counts[n.type]++;
    if (n.type === "site") {
      const mine = graph.nodes.filter((t) => t.type === "tool" && siteOfTool(t.id) === n.id);
      nodes.push({
        ...base(n),
        type: "site",
        data: {
          label: n.label,
          status: n.status,
          slug: nodeKey(n.id),
          total: mine.length,
          verified: mine.filter((t) => t.status === "verified").length,
        },
      });
    } else if (n.type === "capability") {
      const first = capTools.get(n.id)?.[0];
      const site = siteOfCap(n.id);
      nodes.push({
        ...base(n),
        type: "capability",
        data: {
          label: n.label,
          status: n.status,
          siteSlug: site ? nodeKey(site) : null,
          kind: first ? (toolsById.get(nodeNum(first))?.kind ?? null) : null,
        },
      });
    } else if (n.type === "tool") {
      const tool = toolsById.get(nodeNum(n.id)) ?? null;
      const status = n.status ?? tool?.status ?? null;
      if (status === "verified") counts.verified++;
      nodes.push({ ...base(n), type: "tool", data: { label: n.label, status, tool } });
    } else {
      const users = reusers.get(n.id) ?? [];
      const sites = new Set(users.map((u) => (typeOf(u) === "site" ? u : siteOfTool(u))).filter(Boolean));
      nodes.push({ ...base(n), type: "pattern", data: { label: n.label, status: n.status, tools: users.length, sites: sites.size } });
    }
  }

  // ── Edges ──
  const flowEdges: Edge[] = edges
    .filter((e) => centers.has(e.from) && centers.has(e.to))
    .map((e) => {
      const id = `${e.type}:${e.from}>${e.to}`;
      if (e.type === "reuses") {
        return {
          id,
          source: e.from,
          target: e.to,
          type: "step",
          animated: true,
          style: { stroke: "var(--color-violet)", strokeWidth: 2, strokeDasharray: "6 4", opacity: 0.85 },
        };
      }
      const stroke =
        e.type === "compiled_to" ? TONE_COLOR[nodeTone(byId.get(e.to)?.status)] : "var(--color-faint)";
      return { id, source: e.from, target: e.to, type: "step", style: { stroke, strokeWidth: 2 } };
    });

  return { nodes, edges: flowEdges, counts };
}

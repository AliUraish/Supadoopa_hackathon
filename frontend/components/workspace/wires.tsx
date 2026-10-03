"use client";

// Wires between the agent, the Doorway and every Supabase Compute workstation, and the
// packets that travel them. Anchors are elements marked data-anchor="…" inside the stage;
// a ResizeObserver re-measures them, so routes follow any layout change.

import { useEffect, useRef, useState } from "react";
import { TONE_COLOR } from "@/lib/doorway/format";
import { SPRITES } from "@/components/px/sprite";
import type { PacketSpec } from "./flow";
import { StaticSprite } from "./scene-bits";
import styles from "./workspace.module.css";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StageLayout {
  w: number;
  h: number;
  anchors: Record<string, Box>;
}

const EMPTY: StageLayout = { w: 0, h: 0, anchors: {} };

function sameLayout(a: StageLayout, b: StageLayout): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  const ka = Object.keys(a.anchors);
  if (ka.length !== Object.keys(b.anchors).length) return false;
  return ka.every((k) => {
    const p = a.anchors[k];
    const q = b.anchors[k];
    return q && p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h;
  });
}

/** Measure every [data-anchor] inside the returned ref; `watchKey` re-observes new anchors. */
export function useStageLayout(watchKey: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<StageLayout>(EMPTY);

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let alive = true;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive) return;
        const base = root.getBoundingClientRect();
        const anchors: Record<string, Box> = {};
        root.querySelectorAll<HTMLElement>("[data-anchor]").forEach((el) => {
          const r = el.getBoundingClientRect();
          const name = el.dataset.anchor;
          if (!name || !r.width || !r.height) return;
          anchors[name] = {
            x: Math.round(r.left - base.left),
            y: Math.round(r.top - base.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        });
        const next = { w: Math.round(base.width), h: Math.round(base.height), anchors };
        setLayout((prev) => (sameLayout(prev, next) ? prev : next));
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    root.querySelectorAll("[data-anchor],[data-measure]").forEach((el) => ro.observe(el));
    document.fonts?.ready.then(measure, () => {});
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [watchKey]);

  return { ref, layout };
}

// ── Routes: orthogonal pixel cables ────────────────────────────────────────

type Pt = readonly [number, number];

export interface Route {
  d: string;
  rev: string;
  len: number;
  start: Pt;
  end: Pt;
}

const pathOf = (pts: readonly Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ");

function toRoute(points: Pt[]): Route {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
  return { d: pathOf(pts), rev: pathOf([...pts].reverse()), len, start: pts[0], end: pts[pts.length - 1] };
}

const midX = (b: Box) => Math.round(b.x + b.w / 2);
const midY = (b: Box) => Math.round(b.y + b.h / 2);

/**
 * agent → door: across the wall. door → sandbox: up a riser into the ceiling tray, then down
 * into each workstation. sandbox → db: down through the floor into the Postgres brain.
 */
export function computeRoutes(layout: StageLayout, sandboxIds: string[]): Map<string, Route> {
  const a = layout.anchors;
  const routes = new Map<string, Route>();
  const { agent, door, room, ceiling, floor, db } = a;

  if (agent && door) {
    const s: Pt = [agent.x + agent.w + 2, midY(agent)];
    const e: Pt = [door.x - 2, midY(door)];
    const mx = Math.round((s[0] + e[0]) / 2);
    routes.set(
      "agent>door",
      toRoute(Math.abs(s[1] - e[1]) < 6 ? [[s[0], e[1]], e] : [s, [mx, s[1]], [mx, e[1]], e]),
    );
  }

  const cards = sandboxIds
    .map((id) => [id, a[`sb:${id}`]] as const)
    .filter((c): c is readonly [string, Box] => Boolean(c[1]));
  if (!cards.length) return routes;
  const firstTop = Math.min(...cards.map(([, b]) => b.y));
  const lastTop = Math.max(...cards.map(([, b]) => b.y));

  if (door && room && ceiling) {
    const s: Pt = [door.x + door.w + 2, midY(door)];
    const riser = room.x - 12;
    const tray = ceiling.y + ceiling.h + 4;
    for (const [id, b] of cards) {
      const x = midX(b);
      const y = b.y - firstTop < 8 ? tray : b.y - 16; // lower rows: down the riser, under the row above
      routes.set(`door>sb:${id}`, toRoute([s, [riser, s[1]], [riser, y], [x, y], [x, b.y - 2]]));
    }
  }

  if (room && floor && db) {
    const fy = midY(floor);
    const end: Pt = [midX(db), db.y - 2];
    const side = room.x + room.w - 8;
    for (const [id, b] of cards) {
      const x = midX(b);
      const bottom = b.y + b.h + 2;
      const pts: Pt[] =
        lastTop - b.y < 8
          ? [[x, bottom], [x, fy], [end[0], fy], end]
          : [[x, bottom], [x, bottom + 10], [side, bottom + 10], [side, fy], [end[0], fy], end];
      routes.set(`sb:${id}>db`, toRoute(pts));
    }
  }
  return routes;
}

// ── Overlay ────────────────────────────────────────────────────────────────

export interface WireSpec {
  id: string;
  state: "idle" | "hot" | "dead";
}

const WIRE_COLOR = { idle: "#24b47e", hot: "#3ecf8e", dead: "#ff5f56" } as const;

export function WireOverlay({
  layout,
  routes,
  wires,
  packets,
  onPacketDone,
}: {
  layout: StageLayout;
  routes: Map<string, Route>;
  wires: WireSpec[];
  packets: PacketSpec[];
  onPacketDone: (key: string) => void;
}) {
  if (!layout.w || !layout.h) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 hidden xl:block">
      <svg
        width={layout.w}
        height={layout.h}
        viewBox={`0 0 ${layout.w} ${layout.h}`}
        shapeRendering="crispEdges"
        className="absolute inset-0"
      >
        {wires.map((w) => {
          const r = routes.get(w.id);
          if (!r) return null;
          const color = WIRE_COLOR[w.state];
          return (
            <g key={w.id}>
              <path d={r.d} fill="none" stroke={color} strokeOpacity={0.1} strokeWidth={8} />
              <path
                d={r.d}
                fill="none"
                stroke={color}
                strokeOpacity={w.state === "idle" ? 0.55 : 0.95}
                strokeWidth={2}
                className={w.state === "dead" ? styles.wireDead : w.state === "hot" ? styles.wireFast : styles.wire}
              />
              <rect x={r.start[0] - 3} y={r.start[1] - 3} width={6} height={6} fill={color} />
              <rect x={r.end[0] - 3} y={r.end[1] - 3} width={6} height={6} fill={color} />
            </g>
          );
        })}
      </svg>
      {packets.map((p) => {
        const r = routes.get(p.route);
        if (!r) return null;
        const color = TONE_COLOR[p.tone];
        const ms = Math.round(Math.min(1600, Math.max(700, r.len * 1.8)));
        const steps = Math.min(80, Math.max(6, Math.round(r.len / 12)));
        return (
          <span
            key={p.key}
            className={styles.packet}
            style={{
              offsetPath: `path("${p.reverse ? r.rev : r.d}")`,
              animationDuration: `${ms}ms`,
              animationTimingFunction: `steps(${steps}, end)`,
            }}
            onAnimationEnd={() => onPacketDone(p.key)}
          >
            {p.coin ? (
              <StaticSprite map={SPRITES.coin} scale={2} />
            ) : (
              <span
                className="block size-[10px]"
                style={{ background: color, boxShadow: `0 0 10px ${color}, inset -2px -2px 0 rgba(0,0,0,0.35)` }}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}

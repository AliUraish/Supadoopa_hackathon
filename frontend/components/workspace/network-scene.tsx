"use client";

// The Overview's live network: your agent → the Doorway gateway → Supabase Compute sandboxes →
// Postgres. Every new pipeline event sends a small particle along the matching edge (routes
// from ./flow). Loaded lazily (no SSR) by ./scene-panel; animation runs only while `running`.

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { Grid, Html, QuadraticBezierLine, RoundedBox } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import type { SandboxStatus } from "@/lib/doorway";
import type { Tone } from "@/lib/doorway/format";
import type { PacketSpec } from "./flow";

export interface SceneSandbox {
  id: string;
  status: SandboxStatus;
  jobKind: string | null;
  siteId: string | null;
}

export type SceneTarget = "sandboxes" | "tools" | "sites";

export interface NetworkSceneProps {
  sandboxes: SceneSandbox[];
  sandboxesLoading: boolean;
  patterns: number;
  packets: PacketSpec[];
  agentBusy: boolean;
  running: boolean;
  onNavigate: (target: SceneTarget, siteId?: string) => void;
  onHover: (hovering: boolean) => void;
}

// ── Palette ─────────────────────────────────────────────────────────────────

const BG = "#121212";
const BODY = "#232323";
const BODY_2 = "#1c1c1c";
const EDGE = "#363636";

const hdr = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);
const TONE_HEX: Record<Tone, string> = {
  ok: "#3ecf8e",
  bad: "#f06a6a",
  warn: "#f5a524",
  info: "#5ea8ff",
  muted: "#a1a1a1",
  gold: "#e9c46a",
  violet: "#a78bfa",
};
const GLOW: Record<Tone, THREE.Color> = Object.fromEntries(
  Object.entries(TONE_HEX).map(([k, v]) => [k, hdr(v, 2.2)]),
) as Record<Tone, THREE.Color>;
const DOOR_GLOW = hdr("#3ecf8e", 1.6);
const LIGHT_IDLE = new THREE.Color("#3d5a4c");
const LIGHT_OFF = new THREE.Color("#f06a6a");
const LIGHT_BUSY = new THREE.Color("#3ecf8e");
const SCREEN = new THREE.Color("#16241e");
const SCREEN_HOT = new THREE.Color("#2a6b4f");

// ── Layout ──────────────────────────────────────────────────────────────────

type V3 = [number, number, number];
const AGENT: V3 = [-6.2, 0, 0.4];
const GATE: V3 = [-1.7, 0, 0.4];
const PLATFORM_X = 4.3;
const SPACING = 1.8;
const MAX_SANDBOXES = 8;
const TARGET = new THREE.Vector3(0.3, 0.2, -0.9);
const VIEW_DIR = new THREE.Vector3(0.25, 0.6, 0.76).normalize();

interface Layout {
  sandboxes: { id: string; pos: V3 }[];
  platform: { pos: V3; w: number; d: number };
  db: V3;
}

function computeLayout(ids: string[]): Layout {
  const n = Math.min(ids.length, MAX_SANDBOXES);
  const cols = n <= 3 ? Math.max(n, 1) : Math.ceil(n / 2);
  const rows = n <= 3 ? 1 : 2;
  const w = Math.max(cols * SPACING + 0.7, 3.8);
  const d = rows * SPACING + 1.5;
  const pz = 0.6;
  const sandboxes = ids.slice(0, n).map((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PLATFORM_X + (col - (cols - 1) / 2) * SPACING;
    const z = pz - 0.45 + (row - (rows - 1) / 2) * SPACING;
    return { id, pos: [x, 0.18, z] as V3 };
  });
  return { sandboxes, platform: { pos: [PLATFORM_X, 0, pz], w, d }, db: [PLATFORM_X, 0, pz - d / 2 - 2.6] };
}

interface Edge {
  route: string;
  from: string;
  to: string;
  start: V3;
  mid: V3;
  end: V3;
  curve: THREE.QuadraticBezierCurve3;
}

function edge(route: string, from: string, to: string, start: V3, end: V3, lift: number): Edge {
  const mid: V3 = [(start[0] + end[0]) / 2, Math.max(start[1], end[1]) + lift, (start[2] + end[2]) / 2];
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(...start),
    new THREE.Vector3(...mid),
    new THREE.Vector3(...end),
  );
  return { route, from, to, start, mid, end, curve };
}

function computeEdges(layout: Layout): Edge[] {
  const doorIn: V3 = [GATE[0] - 0.1, 0.85, GATE[2]];
  const doorOut: V3 = [GATE[0] + 0.1, 0.85, GATE[2]];
  const list = [edge("agent>door", "agent", "door", [AGENT[0] + 0.75, 0.55, AGENT[2]], doorIn, 0.5)];
  const dbTop: V3 = [layout.db[0], 1.25, layout.db[2]];
  for (const s of layout.sandboxes) {
    const top: V3 = [s.pos[0], s.pos[1] + 0.85, s.pos[2]];
    list.push(edge(`door>sb:${s.id}`, "door", `sb:${s.id}`, doorOut, top, 1.1));
    list.push(edge(`sb:${s.id}>db`, `sb:${s.id}`, "db", top, dbTop, 0.9));
  }
  return list;
}

// ── Shared animation state (mutated only in effects and frame callbacks) ────

const POOL = 32;
const FLIGHT_S = 0.6;
const PULSE_S = 0.55;

interface Flight {
  route: string;
  reverse: boolean;
  color: THREE.Color;
  coin: boolean;
  start: number;
}

interface Store {
  seen: Set<string>;
  queue: Omit<Flight, "start">[];
  flights: (Flight | null)[];
  pulses: Map<string, number>;
  nextAt: number;
  rig: string;
}

function pulseLevel(storeRef: RefObject<Store>, key: string, t: number): number {
  const at = storeRef.current.pulses.get(key);
  if (at === undefined) return 0;
  const k = 1 - (t - at) / PULSE_S;
  return k > 0 ? k : 0;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Label({
  position,
  children,
  center = true,
  interactive = false,
}: {
  position: V3;
  children: ReactNode;
  center?: boolean;
  interactive?: boolean;
}) {
  return (
    <Html position={position} center={center} zIndexRange={[5, 0]} style={{ pointerEvents: interactive ? "auto" : "none" }}>
      <div className={center ? "whitespace-nowrap text-center leading-tight" : "-translate-y-1/2 whitespace-nowrap leading-tight"}>
        {children}
      </div>
    </Html>
  );
}

function Pulse({ storeRef, id, children }: { storeRef: RefObject<Store>; id: string; children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const s = 1 + 0.07 * pulseLevel(storeRef, id, state.clock.elapsedTime);
    g.scale.setScalar(s);
  });
  return <group ref={group}>{children}</group>;
}

function CameraRig({ storeRef }: { storeRef: RefObject<Store> }) {
  useFrame((state) => {
    const key = `${state.size.width}x${state.size.height}`;
    if (storeRef.current.rig === key) return;
    storeRef.current.rig = key;
    const cam = state.camera as THREE.PerspectiveCamera;
    const aspect = state.size.width / Math.max(1, state.size.height);
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const d = Math.max(8.6 / (tanV * aspect), 3.9 / tanV, 11);
    cam.position.copy(TARGET).addScaledVector(VIEW_DIR, d);
    cam.lookAt(TARGET);
    cam.updateProjectionMatrix();
  });
  return null;
}

function AgentNode({ storeRef, busy }: { storeRef: RefObject<Store>; busy: boolean }) {
  const screen = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((state) => {
    const m = screen.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    const k = Math.max(busy ? 0.5 + 0.5 * Math.sin(t * 4) : 0, pulseLevel(storeRef, "agent", t));
    m.color.copy(SCREEN).lerp(SCREEN_HOT, k);
  });
  return (
    <group position={AGENT}>
      <Pulse storeRef={storeRef} id="agent">
        <RoundedBox args={[1.5, 0.95, 1]} radius={0.09} smoothness={3} position={[0, 0.55, 0]}>
          <meshStandardMaterial color={BODY} roughness={0.55} metalness={0.15} />
        </RoundedBox>
        <mesh position={[0, 0.6, 0.505]}>
          <planeGeometry args={[1.18, 0.6]} />
          <meshBasicMaterial ref={screen} color={SCREEN} />
        </mesh>
        {[0.74, 0.62, 0.5].map((y, i) => (
          <mesh key={y} position={[-0.25 + i * 0.08, y, 0.508]}>
            <planeGeometry args={[0.7 - i * 0.22, 0.035]} />
            <meshBasicMaterial color="#3ecf8e" transparent opacity={0.55 - i * 0.12} />
          </mesh>
        ))}
        <mesh position={[0, 0.03, 0]}>
          <boxGeometry args={[1.7, 0.06, 1.2]} />
          <meshStandardMaterial color={BODY_2} roughness={0.8} />
        </mesh>
      </Pulse>
      <Label position={[0, 1.45, 0]}>
        <span className="block text-[12px] font-medium text-text">Your agent</span>
        <span className="block font-mono text-[10px] text-faint">MCP client</span>
      </Label>
    </group>
  );
}

function GatewayNode({
  storeRef,
  onClick,
  onHover,
}: {
  storeRef: RefObject<Store>;
  onClick: () => void;
  onHover: (h: boolean) => void;
}) {
  const light = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((state) => {
    const m = light.current;
    if (!m) return;
    const k = pulseLevel(storeRef, "door", state.clock.elapsedTime);
    m.color.copy(DOOR_GLOW).multiplyScalar(0.75 + 0.6 * k);
  });
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onClick();
  };
  return (
    <group
      position={GATE}
      onClick={click}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(true);
      }}
      onPointerOut={() => onHover(false)}
    >
      <Pulse storeRef={storeRef} id="door">
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[1.7, 0.08, 0.9]} />
          <meshStandardMaterial color={BODY_2} roughness={0.8} />
        </mesh>
        {[-0.62, 0.62].map((x) => (
          <mesh key={x} position={[x, 0.88, 0]}>
            <boxGeometry args={[0.16, 1.62, 0.3]} />
            <meshStandardMaterial color={BODY} roughness={0.5} metalness={0.2} />
          </mesh>
        ))}
        <mesh position={[0, 1.74, 0]}>
          <boxGeometry args={[1.4, 0.16, 0.3]} />
          <meshStandardMaterial color={BODY} roughness={0.5} metalness={0.2} />
        </mesh>
        <mesh position={[0, 0.88, 0]}>
          <planeGeometry args={[1.06, 1.6]} />
          <meshBasicMaterial ref={light} color={DOOR_GLOW} toneMapped={false} transparent opacity={0.22} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, 0.09, 0]}>
          <boxGeometry args={[1.06, 0.02, 0.28]} />
          <meshBasicMaterial color={DOOR_GLOW} toneMapped={false} />
        </mesh>
      </Pulse>
      <Label position={[0, 2.15, 0]}>
        <span className="block text-[12px] font-medium text-text">Doorway</span>
        <span className="block font-mono text-[10px] text-faint">gateway · MCP + HTTP 402</span>
      </Label>
    </group>
  );
}

function SandboxNode({
  storeRef,
  sandbox,
  position,
  onNavigate,
  onHover,
}: {
  storeRef: RefObject<Store>;
  sandbox: SceneSandbox;
  position: V3;
  onNavigate: NetworkSceneProps["onNavigate"];
  onHover: (h: boolean) => void;
}) {
  const light = useRef<THREE.MeshBasicMaterial>(null);
  const bar = useRef<THREE.Mesh>(null);
  const busy = sandbox.status === "busy";
  const offline = sandbox.status === "offline";
  const id = `sb:${sandbox.id}`;
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const m = light.current;
    if (m) {
      const k = pulseLevel(storeRef, id, t);
      if (offline) m.color.copy(LIGHT_OFF);
      else if (busy) m.color.copy(LIGHT_BUSY).multiplyScalar(1.3 + 0.7 * Math.sin(t * 3.2) + k);
      else m.color.copy(LIGHT_IDLE).lerp(LIGHT_BUSY, k).multiplyScalar(1 + k);
    }
    const b = bar.current;
    if (b) {
      const p = (t * 0.7) % 1;
      b.position.x = -0.42 + p * 0.84;
      b.scale.x = 0.25 + 0.75 * Math.sin(p * Math.PI);
    }
  });
  return (
    <group
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onNavigate("sandboxes");
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(true);
      }}
      onPointerOut={() => onHover(false)}
    >
      <Pulse storeRef={storeRef} id={id}>
        <RoundedBox args={[1.25, 0.8, 1.1]} radius={0.08} smoothness={3} position={[0, 0.4, 0]}>
          <meshStandardMaterial color={offline ? "#1e1e1e" : BODY} roughness={0.55} metalness={0.15} />
        </RoundedBox>
        <mesh position={[0, 0.58, 0.553]}>
          <planeGeometry args={[0.9, 0.06]} />
          <meshBasicMaterial ref={light} color={LIGHT_IDLE} toneMapped={false} />
        </mesh>
        {[0.38, 0.26].map((y) => (
          <mesh key={y} position={[0, y, 0.552]}>
            <planeGeometry args={[0.9, 0.025]} />
            <meshBasicMaterial color="#2e2e2e" />
          </mesh>
        ))}
        {busy && (
          <group position={[0, 0.805, 0.3]} rotation={[-Math.PI / 2, 0, 0]}>
            <mesh>
              <planeGeometry args={[1.0, 0.06]} />
              <meshBasicMaterial color="#2a2a2a" />
            </mesh>
            <mesh ref={bar} position={[0, 0, 0.002]}>
              <planeGeometry args={[0.32, 0.06]} />
              <meshBasicMaterial color={LIGHT_BUSY} toneMapped={false} />
            </mesh>
          </group>
        )}
      </Pulse>
      <Label position={[0, 1.3, 0]} interactive={Boolean(sandbox.siteId)}>
        <span className="block font-mono text-[11px] text-text">{sandbox.id}</span>
        <span
          className="flex items-center justify-center gap-1 font-mono text-[10px]"
          style={{ color: offline ? TONE_HEX.bad : busy ? TONE_HEX.ok : "var(--color-faint)" }}
        >
          {offline ? "offline" : busy ? (sandbox.jobKind ?? "busy") : "idle"}
          {sandbox.siteId && (
            <button
              type="button"
              onClick={() => onNavigate("sites", sandbox.siteId ?? undefined)}
              className="rounded border border-line bg-panel/80 px-1 text-muted hover:border-line-2 hover:text-text"
            >
              {sandbox.siteId}
            </button>
          )}
        </span>
      </Label>
    </group>
  );
}

function Platform({ layout, logo, empty }: { layout: Layout; logo: THREE.Texture | null; empty: string | null }) {
  const { pos, w, d } = layout.platform;
  return (
    <group position={pos}>
      <RoundedBox args={[w, 0.18, d]} radius={0.06} smoothness={2} position={[0, 0.09, 0]}>
        <meshStandardMaterial color="#191919" roughness={0.85} />
      </RoundedBox>
      <mesh position={[0, 0.182, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w - 0.2, d - 0.2]} />
        <meshBasicMaterial color="#1d1d1d" />
      </mesh>
      {logo && (
        <mesh position={[-w / 2 + 0.55, 0.186, d / 2 - 0.45]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.42, 0.435]} />
          <meshBasicMaterial map={logo} transparent />
        </mesh>
      )}
      <Label position={[-w / 2 + 0.85, 0.2, d / 2 - 0.45]} center={false}>
        <span className="text-[11px] font-medium text-muted">Supabase Compute</span>
      </Label>
      {empty && (
        <Label position={[0, 0.45, -0.3]}>
          <span className="text-[12px] text-faint">{empty}</span>
        </Label>
      )}
    </group>
  );
}

function PostgresNode({ storeRef, position, patterns, logo }: { storeRef: RefObject<Store>; position: V3; patterns: number; logo: THREE.Texture | null }) {
  const rings = Math.min(patterns, 8);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((state) => {
    const m = ringMat.current;
    if (!m) return;
    const k = pulseLevel(storeRef, "db", state.clock.elapsedTime);
    m.color.set(TONE_HEX.violet).multiplyScalar(0.7 + 1.4 * k);
  });
  return (
    <group position={position}>
      <Pulse storeRef={storeRef} id="db">
        {[0.2, 0.6, 1.0].map((y) => (
          <mesh key={y} position={[0, y, 0]}>
            <cylinderGeometry args={[1, 1, 0.34, 48]} />
            <meshStandardMaterial color={BODY} roughness={0.5} metalness={0.15} />
          </mesh>
        ))}
        {Array.from({ length: rings }, (_, i) => (
          <mesh key={i} position={[0, 0.06 + ((i + 0.5) / rings) * 1.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.025, 0.012, 6, 64]} />
            <meshBasicMaterial ref={i === 0 ? ringMat : undefined} color={TONE_HEX.violet} transparent opacity={0.75} />
          </mesh>
        ))}
        {logo && (
          <mesh position={[0, 1.175, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.62, 0.64]} />
            <meshBasicMaterial map={logo} transparent />
          </mesh>
        )}
      </Pulse>
      <Label position={[0, 1.75, 0]}>
        <span className="block text-[12px] font-medium text-text">Postgres</span>
        <span className="block font-mono text-[10px] text-faint">
          {patterns} shared pattern{patterns === 1 ? "" : "s"}
        </span>
      </Label>
    </group>
  );
}

function EdgeLines({ edges, status }: { edges: Edge[]; status: Map<string, SandboxStatus> }) {
  return (
    <>
      {edges.map((e) => {
        const sb = e.route.startsWith("door>sb:") ? e.to.slice(3) : e.route.startsWith("sb:") ? e.from.slice(3) : null;
        const st = sb ? status.get(sb) : undefined;
        const color = st === "offline" ? "#5a2a2a" : st === "busy" ? "#24b47e" : EDGE;
        return (
          <QuadraticBezierLine
            key={e.route}
            start={e.start}
            mid={e.mid}
            end={e.end}
            color={color}
            lineWidth={1}
            transparent
            opacity={st === "busy" ? 0.8 : 0.9}
          />
        );
      })}
    </>
  );
}

function Particles({ storeRef, edges, packets, running }: { storeRef: RefObject<Store>; edges: Edge[]; packets: PacketSpec[]; running: boolean }) {
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const byRoute = useMemo(() => new Map(edges.map((e) => [e.route, e])), [edges]);

  // Queue packets we haven't seen. While paused they're only marked seen (no burst on resume).
  useEffect(() => {
    const s = storeRef.current;
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      if (s.seen.has(p.key)) continue;
      s.seen.add(p.key);
      if (!running || !byRoute.has(p.route)) continue;
      s.queue.push({ route: p.route, reverse: p.reverse, color: GLOW[p.tone] ?? GLOW.muted, coin: Boolean(p.coin) });
    }
    if (s.queue.length > 24) s.queue.splice(0, s.queue.length - 24);
    if (s.seen.size > 600) s.seen = new Set([...s.seen].slice(-300));
  }, [packets, running, byRoute, storeRef]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const s = storeRef.current;
    while (s.queue.length && t >= s.nextAt) {
      const slot = s.flights.findIndex((f) => f === null);
      if (slot < 0) break;
      const next = s.queue.shift();
      if (!next) break;
      s.flights[slot] = { ...next, start: t };
      s.nextAt = t + 0.12;
    }
    for (let i = 0; i < POOL; i++) {
      const mesh = meshes.current[i];
      const f = s.flights[i];
      if (!mesh) continue;
      const e = f ? byRoute.get(f.route) : undefined;
      if (!f || !e) {
        mesh.visible = false;
        s.flights[i] = null;
        continue;
      }
      const k = (t - f.start) / FLIGHT_S;
      if (k >= 1) {
        mesh.visible = false;
        s.flights[i] = null;
        s.pulses.set(f.reverse ? e.from : e.to, t);
        continue;
      }
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      e.curve.getPoint(f.reverse ? 1 - eased : eased, mesh.position);
      (mesh.material as THREE.MeshBasicMaterial).color.copy(f.color);
      mesh.scale.setScalar(f.coin ? 1.5 : 1);
      mesh.visible = true;
    }
  });

  return (
    <>
      {Array.from({ length: POOL }, (_, i) => (
        <mesh
          key={i}
          visible={false}
          ref={(m) => {
            meshes.current[i] = m;
          }}
        >
          <sphereGeometry args={[0.075, 12, 12]} />
          <meshBasicMaterial toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

function useLogoTexture(): THREE.Texture | null {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let alive = true;
    let made: THREE.CanvasTexture | null = null;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      const c = document.createElement("canvas");
      c.width = 436;
      c.height = 452;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      made = new THREE.CanvasTexture(c);
      made.colorSpace = THREE.SRGBColorSpace;
      made.anisotropy = 4;
      setTex(made);
    };
    img.src = "/brand/supabase-logo-icon.svg";
    return () => {
      alive = false;
      made?.dispose();
    };
  }, []);
  return tex;
}

// ── Scene ───────────────────────────────────────────────────────────────────

export function NetworkScene({
  sandboxes,
  sandboxesLoading,
  patterns,
  packets,
  agentBusy,
  running,
  onNavigate,
  onHover,
}: NetworkSceneProps) {
  const storeRef = useRef<Store>({
    seen: new Set(),
    queue: [],
    flights: Array.from({ length: POOL }, () => null),
    pulses: new Map(),
    nextAt: 0,
    rig: "",
  });
  const idKey = sandboxes.map((s) => s.id).join(",");
  const layout = useMemo(() => computeLayout(idKey ? idKey.split(",") : []), [idKey]);
  const edges = useMemo(() => computeEdges(layout), [layout]);
  const status = new Map(sandboxes.map((s) => [s.id, s.status]));
  const byId = new Map(sandboxes.map((s) => [s.id, s]));
  const logo = useLogoTexture();
  const empty = sandboxesLoading ? null : sandboxes.length ? null : "No sandboxes online";

  return (
    <Canvas
      dpr={[1, 1.5]}
      frameloop={running ? "always" : "demand"}
      camera={{ fov: 32, near: 0.1, far: 120, position: [4, 9, 12] }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      onPointerMissed={() => onHover(false)}
    >
      <color attach="background" args={[BG]} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#ffffff", "#0d0d0d", 0.6]} />
      <directionalLight position={[6, 10, 7]} intensity={1.4} />
      <CameraRig storeRef={storeRef} />
      <Grid
        position={[0, -0.001, 0]}
        args={[60, 60]}
        cellSize={0.6}
        cellThickness={0.6}
        cellColor="#1f1f1f"
        sectionSize={3}
        sectionThickness={0.9}
        sectionColor="#2a2a2a"
        fadeDistance={34}
        fadeStrength={1.6}
        infiniteGrid
      />
      <AgentNode storeRef={storeRef} busy={agentBusy} />
      <GatewayNode storeRef={storeRef} onClick={() => onNavigate("tools")} onHover={onHover} />
      <Platform layout={layout} logo={logo} empty={empty} />
      {layout.sandboxes.map(({ id, pos }) => {
        const sb = byId.get(id);
        return sb ? (
          <SandboxNode
            key={id}
            storeRef={storeRef}
            sandbox={sb}
            position={pos}
            onNavigate={onNavigate}
            onHover={onHover}
          />
        ) : null;
      })}
      <PostgresNode storeRef={storeRef} position={layout.db} patterns={patterns} logo={logo} />
      <EdgeLines edges={edges} status={status} />
      <Particles storeRef={storeRef} edges={edges} packets={packets} running={running} />
      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur intensity={0.55} luminanceThreshold={1} luminanceSmoothing={0.2} radius={0.6} />
      </EffectComposer>
    </Canvas>
  );
}

export default NetworkScene;

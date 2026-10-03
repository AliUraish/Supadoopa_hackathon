"use client";

// Landing hero scene: pale website cards drift through a lit door and come out the
// other side as green tool chips that settle into a stack. Loaded lazily (ssr: false)
// by ./door-hero-client, which also pauses it offscreen and freezes it for reduced motion.

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const BG = "#121212";
const GREEN = "#3ecf8e";

const DOOR_W = 1.3;
const DOOR_H = 2.5;
const FRAME = 0.09;
const AJAR = 0.72; // radians the door stands open

const ITEMS = 4;
const PERIOD = 11; // seconds per card → chip cycle
const STILL_T = 7.4; // the moment shown when motion is reduced
const LABELS = [
  "list_slots",
  "book_appointment",
  "search_books",
  "place_hold",
  "get_menu",
  "reserve_table",
  "check_status",
  "send_message",
];

// ── Canvas textures ────────────────────────────────────────────────────────

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A flat, pale website: browser bar, a heading, a few lines and a field. */
function cardTexture(variant: number) {
  return canvasTexture(512, 352, (ctx) => {
    rounded(ctx, 4, 4, 504, 344, 26);
    ctx.fillStyle = "#e9e9e9";
    ctx.fill();
    ctx.fillStyle = "#d6d6d6";
    ctx.fillRect(4, 30, 504, 2);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(30 + i * 20, 18, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#bdbdbd";
      ctx.fill();
    }
    const bar = (x: number, y: number, w: number, h: number, color: string) => {
      rounded(ctx, x, y, w, h, h / 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    bar(36, 64, variant % 2 ? 250 : 300, 22, "#9c9c9c");
    bar(36, 110, 420, 12, "#c6c6c6");
    bar(36, 134, variant % 2 ? 360 : 390, 12, "#c6c6c6");
    bar(36, 158, 300, 12, "#c6c6c6");
    rounded(ctx, 36, 200, 260, 40, 10);
    ctx.strokeStyle = "#bcbcbc";
    ctx.lineWidth = 3;
    ctx.stroke();
    bar(36, 262, 130, 40, "#b0b0b0");
    if (variant % 2) {
      rounded(ctx, 330, 196, 140, 106, 12);
      ctx.fillStyle = "#d9d9d9";
      ctx.fill();
    }
  });
}

/** A verified tool: dark green chip, green hairline, mono label. */
function chipTexture(label: string, font: string) {
  return canvasTexture(640, 120, (ctx) => {
    rounded(ctx, 3, 3, 634, 114, 22);
    ctx.fillStyle = "#0e2419";
    ctx.fill();
    ctx.strokeStyle = "rgba(62, 207, 142, 0.75)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(46, 60, 9, 0, Math.PI * 2);
    ctx.fillStyle = GREEN;
    ctx.fill();
    ctx.font = `500 44px ${font}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#c9f5df";
    ctx.fillText(label, 76, 62);
  });
}

/** Green light thrown onto the floor in front of the door. */
function spillTexture() {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "rgba(62, 207, 142, 0.55)");
    g.addColorStop(0.45, "rgba(62, 207, 142, 0.16)");
    g.addColorStop(1, "rgba(62, 207, 142, 0)");
    ctx.filter = "blur(10px)";
    ctx.beginPath();
    ctx.moveTo(78, 0);
    ctx.lineTo(178, 0);
    ctx.lineTo(250, 256);
    ctx.lineTo(6, 256);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
  });
}

function monoFont() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim();
  return v ? `${v}, ui-monospace, monospace` : "ui-monospace, SFMono-Regular, monospace";
}

// ── Motion helpers ─────────────────────────────────────────────────────────

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const span = (u: number, a: number, b: number) => clamp01((u - a) / (b - a));

const CARD_END = new THREE.Vector3(0.05, 1.2, -0.35);
const CHIP_START = new THREE.Vector3(0.42, 1.2, 0.2);

// ── Scene pieces ───────────────────────────────────────────────────────────

function FlowItem({
  index,
  still,
  cardMap,
  chipMaps,
}: {
  index: number;
  still: boolean;
  cardMap: THREE.Texture;
  chipMaps: THREE.Texture[];
}) {
  const card = useRef<THREE.Mesh>(null);
  const cardMat = useRef<THREE.MeshBasicMaterial>(null);
  const chip = useRef<THREE.Mesh>(null);
  const chipMat = useRef<THREE.MeshBasicMaterial>(null);

  const start = useMemo(
    () => new THREE.Vector3(-2.4 + (index % 2) * 0.35, 0.75 + index * 0.38, -3.6 - (index % 3) * 0.5),
    [index],
  );
  const slot = useMemo(() => new THREE.Vector3(1.62, 0.3 + index * 0.3, 0.55), [index]);

  useFrame((state) => {
    const t = (still ? STILL_T : state.clock.elapsedTime) + (index * PERIOD) / ITEMS;
    const cycle = Math.floor(t / PERIOD);
    const u = (t % PERIOD) / PERIOD;

    // Card: drifts from the back toward the doorway, fading in then out as it reaches the light.
    if (card.current && cardMat.current) {
      const k = ease(span(u, 0, 0.48));
      card.current.position.lerpVectors(start, CARD_END, k);
      card.current.position.y += Math.sin(u * Math.PI * 2 + index) * 0.04;
      card.current.scale.setScalar(1 - k * 0.45);
      card.current.rotation.y = 0.35 * (1 - k);
      cardMat.current.opacity = 0.34 * span(u, 0, 0.08) * (1 - span(u, 0.38, 0.48));
      card.current.visible = cardMat.current.opacity > 0.002;
    }

    // Chip: emerges from the opening, settles into its slot, and holds until the next one arrives.
    if (chip.current && chipMat.current) {
      const born = u >= 0.46 ? cycle : cycle - 1; // the chip from the previous cycle is still parked
      const v = u >= 0.46 ? u - 0.46 : u + 0.54;
      const fly = ease(span(v, 0, 0.2));
      chip.current.position.lerpVectors(CHIP_START, slot, fly);
      chip.current.position.y += Math.sin(fly * Math.PI) * 0.18;
      chip.current.scale.setScalar(0.45 + 0.55 * fly);
      chipMat.current.opacity = span(v, 0, 0.05) * (1 - span(v, 0.94, 1));
      const map = chipMaps[(((index + born * ITEMS) % LABELS.length) + LABELS.length) % LABELS.length];
      if (map && chipMat.current.map !== map) {
        const first = !chipMat.current.map;
        chipMat.current.map = map;
        if (first) chipMat.current.needsUpdate = true; // compile the textured variant once
      }
      chip.current.visible = chipMat.current.opacity > 0.002 && Boolean(chipMat.current.map);
    }
  });

  return (
    <>
      <mesh ref={card}>
        <planeGeometry args={[1.0, 0.69]} />
        <meshBasicMaterial ref={cardMat} map={cardMap} transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh ref={chip} renderOrder={2}>
        <planeGeometry args={[1.0, 0.1875]} />
        <meshBasicMaterial ref={chipMat} transparent opacity={0} depthWrite={false} fog={false} />
      </mesh>
    </>
  );
}

function Door({ still }: { still: boolean }) {
  const hinge = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const frameMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#2a2a2a",
        roughness: 0.55,
        metalness: 0.25,
        emissive: GREEN,
        emissiveIntensity: 0.05,
      }),
    [],
  );
  // HDR colours (no tone mapping): only these cross the bloom threshold.
  const edge = useMemo(() => new THREE.Color(GREEN).multiplyScalar(2), []);
  const opening = useMemo(() => new THREE.Color(GREEN).multiplyScalar(2.6), []);

  useEffect(() => () => frameMat.dispose(), [frameMat]);

  useFrame((state) => {
    const t = still ? STILL_T : state.clock.elapsedTime;
    if (hinge.current) hinge.current.rotation.y = -(AJAR + Math.sin(t * 0.35) * 0.035);
    if (light.current) light.current.intensity = 5 + Math.sin(t * 0.8) * 0.4;
  });

  const postH = DOOR_H + FRAME;
  return (
    <group>
      {/* frame */}
      <mesh position={[-(DOOR_W + FRAME) / 2, postH / 2, 0]} material={frameMat}>
        <boxGeometry args={[FRAME, postH, 0.18]} />
      </mesh>
      <mesh position={[(DOOR_W + FRAME) / 2, postH / 2, 0]} material={frameMat}>
        <boxGeometry args={[FRAME, postH, 0.18]} />
      </mesh>
      <mesh position={[0, DOOR_H + FRAME / 2, 0]} material={frameMat}>
        <boxGeometry args={[DOOR_W + FRAME * 2, FRAME, 0.18]} />
      </mesh>

      {/* soft green inner edge */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (DOOR_W / 2 + 0.004), DOOR_H / 2, 0.091]}>
          <boxGeometry args={[0.012, DOOR_H, 0.004]} />
          <meshBasicMaterial color={edge} />
        </mesh>
      ))}
      <mesh position={[0, DOOR_H + 0.004, 0.091]}>
        <boxGeometry args={[DOOR_W, 0.012, 0.004]} />
        <meshBasicMaterial color={edge} />
      </mesh>

      {/* the light inside the opening */}
      <mesh position={[0, DOOR_H / 2, -0.05]}>
        <planeGeometry args={[DOOR_W, DOOR_H]} />
        <meshBasicMaterial color={opening} />
      </mesh>
      <pointLight ref={light} position={[0.3, 1.1, 0.5]} color={GREEN} intensity={5} distance={5} decay={1.6} />

      {/* the door, hinged on the left, standing ajar toward us */}
      <group ref={hinge} position={[-DOOR_W / 2, 0, 0]} rotation={[0, -AJAR, 0]}>
        <mesh position={[DOOR_W / 2, DOOR_H / 2, 0.02]}>
          <boxGeometry args={[DOOR_W - 0.01, DOOR_H - 0.01, 0.05]} />
          <meshStandardMaterial color="#1c1c1c" roughness={0.75} metalness={0.1} />
        </mesh>
        <mesh position={[DOOR_W - 0.13, DOOR_H * 0.47, 0.06]}>
          <sphereGeometry args={[0.028, 16, 16]} />
          <meshBasicMaterial color={edge} />
        </mesh>
      </group>
    </group>
  );
}

function Floor({ logo }: { logo: THREE.Texture | null }) {
  const spill = useMemo(() => spillTexture(), []);
  useEffect(() => () => spill.dispose(), [spill]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[24, 24]} />
        <meshStandardMaterial color="#131313" roughness={0.92} metalness={0} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.15, 0.002, 1.25]}>
        <planeGeometry args={[2.6, 2.5]} />
        <meshBasicMaterial map={spill} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {logo && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.05, 0.004, 0.62]}>
          <planeGeometry args={[0.62, 0.62]} />
          <meshBasicMaterial map={logo} transparent opacity={0.3} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

function Rig({ still }: { still: boolean }) {
  const group = useRef<THREE.Group>(null);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const invalidate = useThree((s) => s.invalidate);

  const [fontsReady, setFontsReady] = useState(false);
  const [logo, setLogo] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => {
      if (alive) setFontsReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The official Supabase mark, rasterised once at a size that stays crisp on the floor.
  useEffect(() => {
    let alive = true;
    let tex: THREE.Texture | null = null;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      tex = canvasTexture(512, 512, (ctx) => {
        const h = 440;
        const w = (h * 109) / 113;
        ctx.drawImage(img, (512 - w) / 2, (512 - h) / 2, w, h);
      });
      setLogo(tex);
    };
    img.src = "/brand/supabase-logo-icon.svg";
    return () => {
      alive = false;
      tex?.dispose();
    };
  }, []);

  const cardMaps = useMemo(() => [cardTexture(0), cardTexture(1)], []);
  const chipMaps = useMemo(() => {
    const font = fontsReady ? monoFont() : "ui-monospace, monospace";
    return LABELS.map((l) => chipTexture(l, font));
  }, [fontsReady]);

  useEffect(() => () => cardMaps.forEach((t) => t.dispose()), [cardMaps]);
  useEffect(() => () => chipMaps.forEach((t) => t.dispose()), [chipMaps]);
  useEffect(() => invalidate(), [chipMaps, logo, invalidate]);

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const MAX = 0.05; // ≈ 3°
    const tx = still ? 0 : state.pointer.x * MAX;
    const ty = still ? 0 : -state.pointer.y * MAX * 0.5;
    g.rotation.y += (tx - g.rotation.y) * 0.05;
    g.rotation.x += (ty - g.rotation.x) * 0.05;
  });

  const fit = Math.min(1, aspect / 1.2);
  return (
    <group ref={group} scale={fit} position={[-0.15, 0, 0]}>
      <Door still={still} />
      <Floor logo={logo} />
      {Array.from({ length: ITEMS }, (_, i) => (
        <FlowItem key={i} index={i} still={still} cardMap={cardMaps[i % 2]} chipMaps={chipMaps} />
      ))}
    </group>
  );
}

export default function DoorHeroScene({ active = true, still = false }: { active?: boolean; still?: boolean }) {
  return (
    <Canvas
      flat
      dpr={[1, 1.5]}
      frameloop={still ? "demand" : active ? "always" : "never"}
      camera={{ position: [0.25, 1.5, 6.6], fov: 32, rotation: [-0.06, 0, 0], near: 0.1, far: 40 }}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      aria-hidden
    >
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 7.5, 13]} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[-3, 5, 4]} intensity={0.35} />
      <Rig still={still} />
      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur intensity={0.6} luminanceThreshold={0.9} luminanceSmoothing={0.1} radius={0.65} />
      </EffectComposer>
    </Canvas>
  );
}

"use client";

// Lazy wrapper for the landing door scene: static SVG while loading or without WebGL,
// frame loop paused offscreen, a single still frame for prefers-reduced-motion.

import dynamic from "next/dynamic";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cx } from "@/components/px/ui";

const DoorHeroScene = dynamic(() => import("./door-hero"), { ssr: false, loading: () => <DoorFallback /> });

let webgl: boolean | undefined;
function hasWebGL(): boolean {
  if (webgl === undefined) {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      webgl = Boolean(gl);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl = false;
    }
  }
  return webgl;
}
const subscribeNever = () => () => {};

export function DoorHero({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion() ?? false;
  const canRender = useSyncExternalStore(subscribeNever, hasWebGL, () => false);
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={cx("relative", className)}>
      {canRender ? <DoorHeroScene active={onScreen} still={reduced} /> : <DoorFallback />}
    </div>
  );
}

const CHIPS = ["list_slots", "book_appointment", "search_books", "place_hold"];

/** The same idea, drawn flat: cards on the left, the lit door, tool chips on the right. */
export function DoorFallback() {
  return (
    <svg viewBox="0 0 480 400" className="size-full" role="img" aria-label="Websites passing through a door and becoming tools">
      <defs>
        <linearGradient id="dh-spill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3ecf8e" stopOpacity="0.35" />
          <stop offset="1" stopColor="#3ecf8e" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="dh-light" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6ee7b7" />
          <stop offset="1" stopColor="#3ecf8e" />
        </linearGradient>
      </defs>

      <line x1="0" y1="318" x2="480" y2="318" stroke="#2a2a2a" />
      <path d="M196 318h88l60 82H136z" fill="url(#dh-spill)" />

      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${36 + i * 34} ${96 + i * 52})`} opacity={0.22 + i * 0.06}>
          <rect width="96" height="66" rx="6" fill="#e9e9e9" />
          <rect x="10" y="16" width="44" height="6" rx="3" fill="#9c9c9c" />
          <rect x="10" y="30" width="72" height="4" rx="2" fill="#c6c6c6" />
          <rect x="10" y="40" width="60" height="4" rx="2" fill="#c6c6c6" />
          <rect x="10" y="50" width="26" height="8" rx="2" fill="#b0b0b0" />
        </g>
      ))}

      <rect x="190" y="74" width="100" height="244" fill="url(#dh-light)" />
      <path d="M190 74l58 18v214l-58 12z" fill="#1c1c1c" />
      <circle cx="238" cy="198" r="2.5" fill="#3ecf8e" />
      <rect x="184" y="68" width="112" height="250" rx="2" fill="none" stroke="#2a2a2a" strokeWidth="7" />
      <rect x="187.5" y="71.5" width="105" height="247" fill="none" stroke="#3ecf8e" strokeOpacity="0.45" />

      <image href="/brand/supabase-logo-icon.svg" x="226" y="336" width="28" height="29" opacity="0.3" />

      {CHIPS.map((label, i) => (
        <g key={label} transform={`translate(326 ${282 - i * 30})`}>
          <rect width="132" height="22" rx="5" fill="#0e2419" stroke="#3ecf8e" strokeOpacity="0.75" />
          <circle cx="11" cy="11" r="2.5" fill="#3ecf8e" />
          <text x="20" y="15" fontSize="10" fill="#c9f5df" className="font-mono">
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}

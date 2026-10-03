// Pixel-art sprites from string maps. Each character is a palette key; "." is transparent.
//   <Sprite map={SPRITES.door} palette={PALETTE} scale={3} />

import type { CSSProperties } from "react";

export const PALETTE: Record<string, string> = {
  G: "#3ecf8e", // supabase green
  H: "#8cffc6", // green highlight
  g: "#24b47e", // green mid
  d: "#0e3b27", // green deep
  K: "#050706", // near black
  k: "#1b211e", // panel
  s: "#34423b", // steel
  S: "#5a6a62", // light steel
  W: "#e3f5ea", // white-ish
  R: "#ff5f56",
  A: "#ffb224",
  B: "#4cb4ff",
  V: "#b18cff",
  Y: "#f7d046",
};

export const SPRITES = {
  // Doorway logo: a door with a glowing green opening.
  door: [
    "..GGGGGGGGGG..",
    ".GggggggggggG.",
    "GgKKKKKKKKKKgG",
    "GgKdddddHHHKgG",
    "GgKdddddHHHKgG",
    "GgKdGGddHHHKgG",
    "GgKdGGddHHHKgG",
    "GgKdddddHHHKgG",
    "GgKddddYHHHKgG",
    "GgKdddddHHHKgG",
    "GgKdGGddHHHKgG",
    "GgKdGGddHHHKgG",
    "GgKdddddHHHKgG",
    "GgKdddddHHHKgG",
    "GgKKKKKKKKKKgG",
    "GGGGGGGGGGGGGG",
  ],
  // Your agent: a small green robot.
  agent: [
    "......HH......",
    "......GG......",
    "..GGGGGGGGGG..",
    ".GgggggggggggG",
    ".GgKKgggggKKgG",
    ".GgKHgggggKHgG",
    ".GgggggggggggG",
    ".GgggKKKKKgggG",
    "..GGGGGGGGGG..",
    "....ssssss....",
    "..GGGGGGGGGG..",
    ".sGgggYYgggGs.",
    ".sGgggggggggGs",
    "..GGGGGGGGGG..",
    "...ss....ss...",
    "..sss....sss..",
  ],
  // A sandbox: a Supabase Compute box with a screen.
  sandbox: [
    "ssssssssssssss",
    "sKKKKKKKKKKKKs",
    "sKdddddddddKKs",
    "sKdGGGdddddKKs",
    "sKdddGGGdddKKs",
    "sKdGGdddddKKKs",
    "sKdddddddddKKs",
    "sKKKKKKKKKKKKs",
    "ssssssssssssss",
    "skkkkkkkkkkkks",
    "skGkAkkkkSSSks",
    "skkkkkkkkkkkks",
    "ssssssssssssss",
    "..ss......ss..",
  ],
  // Shared memory: the Postgres brain.
  database: [
    "...GGGGGGGG...",
    ".GGHHHHHHHHGG.",
    "GgGGGGGGGGGGgG",
    "GgddddddddddgG",
    "GGggggggggggGG",
    "GgGGGGGGGGGGgG",
    "GgddddddddddgG",
    "GGggggggggggGG",
    "GgGGGGGGGGGGgG",
    "GgddddddddddgG",
    ".GGggggggggGG.",
    "...GGGGGGGG...",
  ],
  // A browser window (the slow way).
  browser: [
    "ssssssssssssss",
    "sRsAsGsSSSSSSs",
    "ssssssssssssss",
    "sWWWWWWWWWWWWs",
    "sWSSSSWWWWWWWs",
    "sWWWWWWWWWWWWs",
    "sWSSSSSSSSWWWs",
    "sWWWWWWWWWWWWs",
    "sWBBBBWWWWWWWs",
    "sWWWWWWWWWWWWs",
    "ssssssssssssss",
  ],
  coin: [
    "...YYYYYY...",
    "..YYWWWWYY..",
    ".YYWYYYYYAY.",
    ".YWYYAAYYYA.",
    ".YWYAYYYYYA.",
    ".YWYYAAYYYA.",
    ".YWYYYYAYYA.",
    ".YWYAAAYYYA.",
    ".YYYYYYYYAY.",
    "..YAAAAAAY..",
    "...YYYYYY...",
  ],
} as const satisfies Record<string, readonly string[]>;

export type SpriteName = keyof typeof SPRITES;

export function Sprite({
  map,
  name,
  palette = PALETTE,
  scale = 3,
  className,
  style,
  title,
}: {
  map?: readonly string[];
  name?: SpriteName;
  palette?: Record<string, string>;
  scale?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const rows = map ?? (name ? SPRITES[name] : []);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const rects: { x: number; y: number; w: number; c: string }[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      const color = palette[ch];
      if (ch !== "." && color) {
        let w = 1;
        while (row[x + w] === ch) w++;
        rects.push({ x, y, w, c: color });
        x += w;
      } else x++;
    }
  });
  return (
    <svg
      width={width * scale}
      height={rows.length * scale}
      viewBox={`0 0 ${width} ${rows.length}`}
      shapeRendering="crispEdges"
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />
      ))}
    </svg>
  );
}

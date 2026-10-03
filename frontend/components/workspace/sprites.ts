// Workspace sprites: animation frames for the agent, its desk, Supabase Compute workstations.
// Same string-map format as components/px/sprite.tsx ("." = transparent, keys from PALETTE).

import { PALETTE, SPRITES } from "@/components/px/sprite";
import type { SandboxStatus } from "@/lib/doorway/types";

const fill = (ch: string, n: number) => ch.repeat(n);

/** A copy of `base` with some rows replaced (one frame of an animation). */
function withRows(base: readonly string[], rows: Record<number, string>): string[] {
  return base.map((row, i) => rows[i] ?? row);
}

// The agent robot (SPRITES.agent) with its eyes shut, and talking with its antenna lit.
export const AGENT_BLINK = withRows(SPRITES.agent, { 4: ".GgggggggggggG", 5: ".GgKKgggggKKgG" });
export const AGENT_TALK = withRows(SPRITES.agent, { 0: "......YY......", 7: ".GggggKKKggggG" });

// A retro CRT on the agent's desk. Screen: x 2–13, y 2–7.
export const MONITOR = [
  fill("S", 16),
  "S" + fill("K", 14) + "S",
  ...Array.from({ length: 6 }, () => "SK" + fill("d", 12) + "KS"),
  "S" + fill("K", 14) + "S",
  fill("S", 16),
  "......ssss......",
  "......ssss......",
  "...ssssssssss...",
];
export const MONITOR_SCREEN = { x: 2, y: 2, w: 12, h: 6 } as const;

// The desk, seen from the side.
export const DESK = [
  fill("S", 34),
  fill("s", 34),
  ...Array.from({ length: 4 }, () => "..ss" + fill(".", 26) + "ss.."),
  ".ssss" + fill(".", 24) + "ssss.",
];

// A Supabase Compute workstation: screen on top, case with a status LED (L) and a green bolt.
export const COMPUTE = [
  fill("s", 18),
  "s" + fill("S", 16) + "s",
  "sS" + fill("K", 14) + "Ss",
  ...Array.from({ length: 6 }, () => "sSK" + fill("d", 12) + "KSs"),
  "sS" + fill("K", 14) + "Ss",
  "s" + fill("S", 16) + "s",
  fill("s", 18),
  "s" + fill("k", 12) + "GG" + fill("k", 2) + "s",
  "skLLkkkkkkkkGGkkks",
  "s" + fill("k", 10) + "GG" + fill("k", 4) + "s",
  fill("s", 18),
  "..sss" + fill(".", 8) + "sss..",
];
export const COMPUTE_SCREEN = { x: 3, y: 3, w: 12, h: 6 } as const;

// Workstation palette per status: the LED colour.
export const COMPUTE_PALETTE: Record<SandboxStatus, Record<string, string>> = {
  idle: { ...PALETTE, L: PALETTE.G },
  busy: { ...PALETTE, L: PALETTE.B },
  offline: { ...PALETTE, L: PALETTE.R },
};

// A dead screen.
export const RED_X = ["R...R", ".R.R.", "..R..", ".R.R.", "R...R"];

// A tiny mouse pointer for the "browser" screen.
export const POINTER = ["W...", "WW..", "WWW.", "WWWW", "W.W.", "...W"];

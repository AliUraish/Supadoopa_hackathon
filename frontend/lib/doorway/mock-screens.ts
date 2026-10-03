// Fake browser-agent "screenshots" for the mock race: tiny pixel-style SVG pages as data: URIs.

export type Scene = "home" | "picker" | "results" | "form" | "confirm";

export interface ShotOptions {
  site: string; // site name, drawn in the header
  url: string; // address bar
  scene: Scene;
  cta?: string; // homepage button label
  items?: string[]; // picker buttons / result rows
  fields?: [string, string][]; // form label → value
  target?: "cta" | "submit" | number | null; // the highlighted element
  code?: string; // confirmation code
}

const W = 320;
const H = 200;
const C = {
  bg: "#0b0e0d",
  chrome: "#171c1a",
  header: "#111614",
  block: "#262c29",
  block2: "#353c38",
  input: "#0f1311",
  text: "#d8e6de",
  muted: "#7d8a83",
  green: "#3ecf8e",
  greenDeep: "#1f6b4a",
  greenInk: "#10241b",
  red: "#e5484d",
  amber: "#f5a623",
};

type Box = { x: number; y: number; w: number; h: number };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const rect = (x: number, y: number, w: number, h: number, fill: string, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;

const text = (x: number, y: number, s: string, size: number, fill: string, anchor = "start", bold = false) =>
  `<text x="${x}" y="${y}" font-family="monospace" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${
    bold ? ' font-weight="bold"' : ""
  }>${esc(s)}</text>`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function chrome(o: ShotOptions): string {
  return [
    rect(0, 0, W, 16, C.chrome),
    rect(5, 6, 4, 4, C.red),
    rect(11, 6, 4, 4, C.amber),
    rect(17, 6, 4, 4, C.green),
    rect(28, 4, 220, 9, C.bg),
    text(32, 11, clip(o.url, 44), 6.5, C.muted),
    rect(0, 16, W, 22, C.header),
    text(10, 31, clip(o.site, 26), 10, C.text, "start", true),
    rect(214, 25, 22, 5, C.block2),
    rect(242, 25, 22, 5, C.block2),
    rect(270, 23, 38, 9, C.block),
  ].join("");
}

function home(o: ShotOptions, boxes: Record<string, Box>): string {
  const cta: Box = { x: 16, y: 98, w: 104, h: 18 };
  boxes.cta = cta;
  return [
    rect(16, 50, 170, 10, C.block2),
    rect(16, 66, 140, 5, C.block),
    rect(16, 75, 156, 5, C.block),
    rect(16, 84, 118, 5, C.block),
    rect(cta.x, cta.y, cta.w, cta.h, C.greenDeep),
    text(cta.x + cta.w / 2, cta.y + 12, clip(o.cta ?? "Book now", 18), 8, C.text, "middle"),
    // hero "image": a pixel landscape
    rect(206, 48, 98, 72, C.block),
    rect(216, 58, 8, 8, C.amber),
    rect(206, 100, 98, 20, C.block2),
    rect(226, 92, 24, 8, C.block2),
    rect(262, 86, 30, 14, C.block2),
    rect(16, 132, 90, 52, C.block),
    rect(115, 132, 90, 52, C.block),
    rect(214, 132, 90, 52, C.block),
    rect(24, 140, 50, 5, C.block2),
    rect(123, 140, 50, 5, C.block2),
    rect(222, 140, 50, 5, C.block2),
  ].join("");
}

function picker(o: ShotOptions, boxes: Record<string, Box>): string {
  const items = (o.items ?? []).slice(0, 6);
  const out = [text(16, 56, "Pick a time", 9, C.text, "start", true), rect(16, 62, 288, 8, C.block)];
  items.forEach((label, i) => {
    const box: Box = { x: 16 + (i % 3) * 98, y: 80 + Math.floor(i / 3) * 30, w: 90, h: 22 };
    boxes[String(i)] = box;
    out.push(rect(box.x, box.y, box.w, box.h, C.block2));
    out.push(text(box.x + box.w / 2, box.y + 14, clip(label, 14), 8, C.text, "middle"));
  });
  out.push(rect(16, 150, 288, 34, C.block));
  return out.join("");
}

function results(o: ShotOptions, boxes: Record<string, Box>): string {
  const items = (o.items ?? []).slice(0, 5);
  const out = [text(16, 56, `${items.length} results`, 9, C.text, "start", true)];
  items.forEach((label, i) => {
    const box: Box = { x: 16, y: 64 + i * 25, w: 288, h: 21 };
    boxes[String(i)] = box;
    out.push(rect(box.x, box.y, box.w, box.h, C.block));
    out.push(text(box.x + 8, box.y + 14, clip(label, 40), 8, C.text));
    out.push(rect(box.x + box.w - 52, box.y + 6, 44, 9, i % 3 === 1 ? C.block2 : C.greenDeep));
  });
  return out.join("");
}

function form(o: ShotOptions, boxes: Record<string, Box>): string {
  const fields = (o.fields ?? []).slice(0, 3);
  const out = [text(16, 56, "Your details", 9, C.text, "start", true)];
  fields.forEach(([label, value], i) => {
    const y = 68 + i * 32;
    const box: Box = { x: 16, y: y + 5, w: 200, h: 16 };
    boxes[String(i)] = box;
    out.push(text(16, y, label, 7, C.muted));
    out.push(rect(box.x, box.y, box.w, box.h, C.input, `stroke="${C.block2}"`));
    if (value) out.push(text(box.x + 5, box.y + 11, clip(value, 30), 8, C.text));
  });
  const submit: Box = { x: 16, y: 72 + fields.length * 32, w: 90, h: 18 };
  boxes.submit = submit;
  out.push(rect(submit.x, submit.y, submit.w, submit.h, C.greenDeep));
  out.push(text(submit.x + submit.w / 2, submit.y + 12, "Confirm", 8, C.text, "middle"));
  out.push(rect(232, 68, 72, 90, C.block));
  return out.join("");
}

function confirm(o: ShotOptions): string {
  const check = [
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 5],
    [4, 4],
    [5, 3],
    [6, 2],
    [7, 1],
  ]
    .map(([x, y]) => rect(146 + x * 4, 70 + y * 4, 4, 4, C.green))
    .join("");
  return [
    rect(60, 56, 200, 100, C.greenInk, `stroke="${C.green}" stroke-width="2"`),
    check,
    text(160, 118, "Confirmed", 11, C.green, "middle", true),
    text(160, 136, o.code ?? "", 9, C.text, "middle"),
    rect(100, 166, 120, 6, C.block),
  ].join("");
}

// A green box around the target plus a white pixel-arrow cursor.
function highlight(box: Box): string {
  const cx = box.x + box.w - 10;
  const cy = box.y + box.h - 6;
  const arrow = [
    [0, 0, 2, 12],
    [2, 2, 2, 8],
    [4, 4, 2, 6],
    [6, 6, 2, 4],
    [8, 8, 2, 2],
  ]
    .map(([x, y, w, h]) => rect(cx + x, cy + y, w, h, "#ffffff"))
    .join("");
  return (
    rect(box.x - 3, box.y - 3, box.w + 6, box.h + 6, C.green, `fill-opacity="0.18" stroke="${C.green}" stroke-width="2"`) +
    arrow
  );
}

/** A 320×200 fake screenshot as a URL-encoded SVG data: URI. */
export function screenshotUrl(o: ShotOptions): string {
  const boxes: Record<string, Box> = {};
  let body = "";
  if (o.scene === "home") body = home(o, boxes);
  else if (o.scene === "picker") body = picker(o, boxes);
  else if (o.scene === "results") body = results(o, boxes);
  else if (o.scene === "form") body = form(o, boxes);
  else body = confirm(o);
  const target = o.target === null || o.target === undefined ? null : boxes[String(o.target)];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">` +
    `<defs><pattern id="s" width="2" height="2" patternUnits="userSpaceOnUse">${rect(0, 0, 2, 1, "#000", 'fill-opacity="0.22"')}</pattern></defs>` +
    rect(0, 0, W, H, C.bg) +
    chrome(o) +
    body +
    (target ? highlight(target) : "") +
    rect(0, 0, W, H, "url(#s)") +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

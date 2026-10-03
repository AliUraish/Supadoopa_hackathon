// Pixel 404: a boarded-up door.

import { Sprite } from "@/components/px/sprite";
import { ButtonLink } from "@/components/px/ui";

const BOARDED_DOOR = [
  "..GGGGGGGGGG..",
  ".GggggggggggG.",
  "GgKKKKKKKKKKgG",
  "GgKddddddddKgG",
  "GgKSSSSSSSSKgG",
  "GgKssssssssKgG",
  "GgKddddddddKgG",
  "GgKddddddddKgG",
  "GgKdddddYddKgG",
  "GgKddddddddKgG",
  "GgKSSSSSSSSKgG",
  "GgKssssssssKgG",
  "GgKddddddddKgG",
  "GgKddddddddKgG",
  "GgKKKKKKKKKKgG",
  "GGGGGGGGGGGGGG",
];

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      <Sprite map={BOARDED_DOOR} scale={8} title="A boarded-up door" className="drop-shadow-[0_0_14px_rgba(255,95,86,0.35)]" />
      <h1
        className="font-pixel text-[40px] leading-none text-red"
        style={{ textShadow: "0 0 18px rgba(255,95,86,0.55)" }}
      >
        404
      </h1>
      <p className="font-pixel text-[10px] uppercase text-muted">This door leads nowhere</p>
      <p className="max-w-md text-lg text-faint">
        No page, site or tool lives at this address. It may have moved, or never existed.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <ButtonLink href="/" icon="door">
          Home
        </ButtonLink>
        <ButtonLink href="/dashboard" variant="ghost" icon="execute">
          Dashboard
        </ButtonLink>
      </div>
    </main>
  );
}

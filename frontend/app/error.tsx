"use client";

// Error boundary for every route below the root layout (Next 16 props: error, retry, reset).

import { useEffect } from "react";
import { describeError } from "@/lib/doorway/errors";
import { PALETTE, Sprite } from "@/components/px/sprite";
import { Button, ButtonLink, Panel } from "@/components/px/ui";

// The door, with its light gone red.
const BROKEN = { ...PALETTE, H: "#ff5f56", G: "#ff5f56", g: "#b8433c", Y: "#ffb224" };

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Panel title="Something broke" icon="broken" tone="bad" className="w-full max-w-lg">
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <Sprite name="door" palette={BROKEN} scale={6} className="animate-pulse-px" />
          <p className="text-xl text-text">{describeError(error) || "Unexpected error."}</p>
          {error.digest && (
            <p className="text-base text-faint">
              Reference <code className="text-muted">{error.digest}</code>
            </p>
          )}
          <p className="text-base text-muted">Doorway heals its tools; this page can try again too.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button icon="heal" onClick={() => retry()}>
              Try again
            </Button>
            <ButtonLink href="/" variant="ghost" icon="door">
              Home
            </ButtonLink>
          </div>
        </div>
      </Panel>
    </main>
  );
}

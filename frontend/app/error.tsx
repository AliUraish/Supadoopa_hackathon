"use client";

// Error boundary for every route below the root layout (Next 16 props: error, retry, reset).

import { useEffect } from "react";
import { describeError } from "@/lib/doorway/errors";
import { Icon } from "@/components/px/icons";
import { Button, ButtonLink } from "@/components/px/ui";

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
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="px-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center">
        <span className="grid size-10 place-items-center rounded-full border border-red/40 bg-red/10 text-red">
          <Icon name="warn" size={18} />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-text">Something went wrong</h1>
          <p className="text-[13px] text-muted">{describeError(error) || "Unexpected error."}</p>
          {error.digest && (
            <p className="text-xs text-faint">
              Reference <code className="font-mono text-muted">{error.digest}</code>
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => retry()}>Try again</Button>
          <ButtonLink href="/" variant="ghost">
            Home
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}

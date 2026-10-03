"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// The Stripe webhook lands asynchronously: re-render the page every 2s until
// the server sees the new entitlement (the parent stops rendering this).
export function RefreshUntilActive({ maxTries = 10 }: { maxTries?: number }) {
  const router = useRouter();

  useEffect(() => {
    let tries = 0;
    const id = setInterval(() => {
      if (++tries > maxTries) return clearInterval(id);
      router.refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [router, maxTries]);

  return null;
}

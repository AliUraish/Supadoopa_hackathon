import Link from "next/link";
import { DOORWAY_MOCK } from "@/lib/doorway";
import { createClient } from "@/lib/supabase/server";
import { NavLinks } from "@/components/nav-links";
import { PixelIcon } from "@/components/px/icons";
import { Sprite } from "@/components/px/sprite";

async function account(): Promise<{ email: string | null; guest: boolean }> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (!claims || claims.is_anonymous) return { email: null, guest: true };
    return { email: typeof claims.email === "string" ? claims.email : null, guest: false };
  } catch {
    return { email: null, guest: true };
  }
}

export async function Nav() {
  const { email, guest } = await account();
  return (
    <header className="sticky top-0 z-40 border-b-2 border-line bg-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-4 px-4">
        <Link href="/" className="group flex items-center gap-2.5" aria-label="Doorway home">
          <Sprite name="door" scale={2} className="drop-shadow-[0_0_6px_rgba(62,207,142,0.6)]" />
          <span className="font-pixel text-[12px] text-green px-glow">DOORWAY</span>
        </Link>
        <NavLinks />
        <div className="ml-auto flex items-center gap-3">
          <span
            className="font-pixel hidden px-1.5 py-1 text-[8px] uppercase sm:inline-block"
            style={{
              color: DOORWAY_MOCK ? "var(--color-amber)" : "var(--color-green)",
              boxShadow: `inset 0 0 0 2px ${DOORWAY_MOCK ? "var(--color-amber)" : "var(--color-green)"}`,
            }}
            title={DOORWAY_MOCK ? "NEXT_PUBLIC_DOORWAY_MOCK=1: fixtures and a fake live stream" : "Connected to the Doorway API"}
          >
            {DOORWAY_MOCK ? "Mock data" : "Live API"}
          </span>
          {guest ? (
            <Link href="/login?next=/dashboard" className="flex items-center gap-1.5 text-base text-muted hover:text-green">
              <PixelIcon name="user" size={12} />
              Guest
            </Link>
          ) : (
            <span className="flex max-w-48 items-center gap-1.5 truncate text-base text-muted" title={email ?? undefined}>
              <PixelIcon name="user" size={12} className="text-green" />
              {email ?? "Signed in"}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

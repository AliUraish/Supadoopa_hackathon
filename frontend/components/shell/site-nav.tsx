import Link from "next/link";
import { DoorwayLogo } from "@/components/brand/doorway-logo";
import { ButtonLink } from "@/components/px/ui";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
        <Link href="/" aria-label="Doorway home">
          <DoorwayLogo />
        </Link>
        <nav className="flex items-center gap-5 text-[13px] text-muted" aria-label="Main">
          <Link href="/#how" className="hover:text-text">
            How it works
          </Link>
          <Link href="/pricing" className="hover:text-text">
            Pricing
          </Link>
          <Link href="/dashboard" className="hover:text-text">
            Dashboard
          </Link>
        </nav>
        <div className="ml-auto">
          <ButtonLink href="/dashboard" size="sm">
            Open dashboard
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}

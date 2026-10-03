"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/px/ui";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/profile", label: "Profile" },
  { href: "/pricing", label: "Pricing" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1" aria-label="Main">
      {LINKS.map((l) => {
        const active = pathname === l.href || pathname.startsWith(`${l.href}/`) ||
          (l.href === "/dashboard" && (pathname.startsWith("/sites/") || pathname.startsWith("/tools/")));
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "font-pixel px-2.5 py-2 text-[9px] uppercase",
              active ? "bg-green-deep text-green" : "text-muted hover:text-text",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

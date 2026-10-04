"use client";

// The product shell: a left sidebar (like the Supabase dashboard) and a slim top bar.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { DoorwayLogo } from "@/components/brand/doorway-logo";
import { SupabaseLogo } from "@/components/brand/supabase-logo";
import { ConnectAgent } from "@/components/connect-agent";
import { DashboardNavProvider, useDashboardNav } from "@/components/dashboard/nav";
import { TABS, type TabId } from "@/components/dashboard/tabs";
import { Icon, type IconName } from "@/components/px/icons";
import { LiveBadge } from "@/components/px/client";
import { cx } from "@/components/px/ui";
import { SignInAlert } from "@/components/shell/signin-alert";

type Account = { email: string | null; guest: boolean };

export function AppShell({ account, children }: { account: Account; children: ReactNode }) {
  return (
    <DashboardNavProvider>
      <div className="flex min-h-screen w-full">
        <Sidebar account={account} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </div>
    </DashboardNavProvider>
  );
}

function useSection(): { label: string; tab: TabId | null } {
  const pathname = usePathname();
  const { tab } = useDashboardNav();
  if (pathname === "/dashboard") return { label: TABS.find((t) => t.id === tab)?.label ?? "Overview", tab };
  if (pathname.startsWith("/sites/")) return { label: "Websites", tab: "sites" };
  if (pathname.startsWith("/tools/")) return { label: "Tools", tab: "tools" };
  if (pathname.startsWith("/profile")) return { label: "Profile", tab: null };
  return { label: "Doorway", tab: null };
}

function Sidebar({ account }: { account: Account }) {
  const pathname = usePathname();
  const { goTo } = useDashboardNav();
  const section = useSection();

  return (
    <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-line bg-bg-2 lg:flex">
      <div className="flex h-14 items-center border-b border-line px-4">
        <Link href="/" aria-label="Doorway home">
          <DoorwayLogo />
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4" aria-label="Dashboard">
        <div className="flex flex-col gap-0.5">
          <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">Doorway</p>
          {TABS.map((t) => (
            <NavItem
              key={t.id}
              href={`/dashboard?tab=${t.id}`}
              icon={t.icon}
              label={t.label}
              active={section.tab === t.id}
              supabase={t.supabase}
              onClick={(e) => {
                if (pathname !== "/dashboard") return;
                e.preventDefault();
                goTo(t.id);
              }}
            />
          ))}
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">Account</p>
          <NavItem href="/profile" icon="user" label="Saved details" active={pathname.startsWith("/profile")} />
          <NavItem href="/pricing" icon="card" label="Pricing" active={false} />
        </div>
      </nav>
      <div className="flex flex-col gap-3 border-t border-line p-4">
        <div className="flex items-center gap-2 text-xs text-muted">
          <SupabaseLogo size={14} />
          <span>Supabase Compute · Postgres</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          {account.guest ? (
            <Link href="/login?next=/dashboard" className="flex items-center gap-1.5 text-xs text-muted hover:text-text">
              <Icon name="user" size={13} />
              Guest
            </Link>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted" title={account.email ?? undefined}>
              <Icon name="user" size={13} />
              <span className="truncate">{account.email ?? "Signed in"}</span>
            </span>
          )}
          <LiveBadge />
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  href,
  icon,
  label,
  active,
  supabase,
  onClick,
}: {
  href: string;
  icon: IconName;
  label: string;
  active: boolean;
  supabase?: boolean;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
        active ? "bg-panel-3 text-text" : "text-muted hover:bg-panel-2 hover:text-text",
      )}
    >
      <Icon name={icon} size={15} className={active ? "text-green" : undefined} />
      <span className="flex-1 truncate">{label}</span>
      {supabase && <SupabaseLogo size={12} className={active ? "" : "opacity-60"} />}
    </Link>
  );
}

function TopBar() {
  const section = useSection();
  const pathname = usePathname();
  const { tab, goTo } = useDashboardNav();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <Link href="/" className="lg:hidden" aria-label="Doorway home">
          <DoorwayLogo />
        </Link>
        <div className="hidden items-center gap-2 text-[13px] lg:flex">
          <span className="text-muted">Doorway</span>
          <span className="text-faint">/</span>
          <span className="text-text">{section.label}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SignInAlert />
          <div className="relative">
            <button type="button" className="px-btn px-btn--ghost px-btn--sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <Icon name="agent" size={13} />
              Connect agent
            </button>
            {open && (
              <>
                <button type="button" aria-label="Close" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
                <div className="absolute right-0 top-10 z-50 w-[min(560px,90vw)] shadow-2xl shadow-black/60">
                  <ConnectAgent />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Small screens: the sidebar's sections as a scrollable row. */}
      <nav className="flex gap-1 overflow-x-auto border-t border-line px-3 py-2 lg:hidden" aria-label="Dashboard">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/dashboard?tab=${t.id}`}
            onClick={(e) => {
              if (pathname !== "/dashboard") return;
              e.preventDefault();
              goTo(t.id);
            }}
            className={cx(
              "shrink-0 rounded-md px-2.5 py-1 text-xs",
              pathname === "/dashboard" && tab === t.id ? "bg-panel-3 text-text" : "text-muted",
            )}
          >
            {t.label}
          </Link>
        ))}
        <Link href="/profile" className="shrink-0 rounded-md px-2.5 py-1 text-xs text-muted">
          Profile
        </Link>
      </nav>
    </header>
  );
}

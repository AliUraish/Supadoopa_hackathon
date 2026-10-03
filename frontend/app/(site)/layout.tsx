import { SiteNav } from "@/components/shell/site-nav";

// Public pages (landing, pricing, login, billing): a slim top nav.
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNav />
      {children}
    </>
  );
}

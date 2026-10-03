import { Suspense } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { createClient } from "@/lib/supabase/server";

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

// The product: sidebar + top bar, like the Supabase dashboard. No login wall.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <AppShell account={await account()}>{children}</AppShell>
    </Suspense>
  );
}

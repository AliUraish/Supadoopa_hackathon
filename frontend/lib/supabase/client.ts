import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

// Supabase client for Client Components. Respects RLS as the signed-in user.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}

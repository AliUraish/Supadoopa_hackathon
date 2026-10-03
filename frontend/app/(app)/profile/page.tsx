import { ProfilePage } from "@/components/profile/profile-page";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Profile" };

// Public: guests get an anonymous session from the client, so there is no login wall.
async function isGuest(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    return !data?.claims || Boolean(data.claims.is_anonymous);
  } catch {
    return true;
  }
}

export default async function Page() {
  return <ProfilePage guest={await isGuest()} />;
}

// Quick deploy check: confirms env vars are present and Supabase is reachable.
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  let supabase = "missing env";
  if (url && key) {
    try {
      const res = await fetch(`${url}/auth/v1/health`, {
        headers: { apikey: key },
        cache: "no-store",
      });
      supabase = res.ok ? "ok" : `error ${res.status}`;
    } catch {
      supabase = "unreachable";
    }
  }

  const ok = supabase === "ok";
  return Response.json({ ok, supabase }, { status: ok ? 200 : 503 });
}

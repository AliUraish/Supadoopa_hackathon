@AGENTS.md

# Supabase Hackathon

Next.js 16 (App Router, Turbopack, Tailwind v4) + Supabase (Auth + Postgres), deployed on Vercel.
Stripe billing lives in the separate FastAPI service in `backend/` — don't add Stripe code to the Next.js app; call the backend with the user's access token (`Authorization: Bearer <session.access_token>`).

## Projects
- Supabase: `Supabase_Hackathon`, ref `bwqjknrqcqelgpixzwut` (us-east-1). Use this ref for every Supabase MCP call. The org also has `Machanize US West` (`kidmwrkraozhsdiycxju`) — never touch it.
- Vercel: project `supabase-hackathon`, team `aliuraishmirani-4593s-projects`; the repo root is linked (`.vercel/`). Production: https://supabase-hackathon-phi.vercel.app. `vercel.json` pins `framework: nextjs` (the project was created with preset "Other", which serves 404s). `backend/` deploys as its own Vercel project and is excluded here by `.vercelignore`.

## Supabase in code
- `lib/supabase/server.ts` — Server Components, Server Actions, Route Handlers: `await createClient()`. RLS applies as the signed-in user.
- `lib/supabase/client.ts` — Client Components.
- `lib/supabase/admin.ts` — secret key, bypasses RLS, server-only. Only for trusted work.
- `proxy.ts` → `lib/supabase/proxy.ts` refreshes the session on every request. Add protected route prefixes to `PROTECTED_PREFIXES`.
- Check auth on the server with `supabase.auth.getClaims()`, not `getSession()`.
- Auth flow: `app/login` (server actions), `app/auth/callback` (email links / OAuth), `/dashboard` is the protected example.
- Types: `lib/database.types.ts`. After any schema change, regenerate with MCP `generate_typescript_types` and overwrite the file.

## Schema changes
1. Write the SQL to `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`.
2. Apply the same SQL with MCP `apply_migration` (same name).
3. Enable RLS on every new `public` table and add its policies in the same migration.
4. Run MCP `get_advisors` (security), fix findings, then regenerate types.

`billing_*` tables are owned by the backend's migration — coordinate before altering them.

## Env
`.env` is the local source of truth (gitignored; `.env.local` only holds Vercel's OIDC token). Vercel has `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` in production, preview and development.
To add a var: put it in `.env`, a placeholder in `.env.example`, then `printf '%s' "$VALUE" | vercel env add NAME <production|preview|development>` per environment. `NEXT_PUBLIC_*` values are inlined at build time, so redeploy after changing them.

## Commands
- `npm run dev` · `npm run build` · `npm run lint`
- Deploy: `vercel deploy --prod`. Preview: `vercel deploy --target=preview` (always pass the target explicitly). Previews sit behind Vercel auth; test them with `vercel curl /api/health --deployment <url>`.
- Health check: `GET /api/health` → `{"ok":true,"supabase":"ok"}`

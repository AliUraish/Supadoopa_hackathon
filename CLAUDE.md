@frontend/AGENTS.md

# Supabase Hackathon

Next.js 16 (App Router, Turbopack, Tailwind v4) in `frontend/` + Supabase (Auth + Postgres), deployed on Vercel.
The frontend is the Doorway dashboard (pixel theme); it talks to the FastAPI service in `backend/` (contract: `backend/DOORWAY_API.md`).
Stripe billing lives in the separate FastAPI service in `backend/` (contract in `backend/README.md`) — don't add Stripe code to the Next.js app.

## Billing in the frontend
- `frontend/lib/billing.ts` (server-only) calls the billing API at `BILLING_API_URL` with the user's Supabase access token; the browser never talks to it directly.
- `frontend/app/billing/actions.ts`: `startCheckout` (form field `lookup_key`) and `openPortal` server actions redirect to Stripe.
- Pages: `/pricing` (catalog + checkout, Stripe cancel target), `/billing/success` (polls until the webhook grants access), plan + Manage billing in the `/dashboard` footer (signed-in, non-anonymous users only).
- Every billing call is wrapped so pages still render when the API is down or not deployed.
- Local: run the API with `cd backend && uv run uvicorn app.main:app --port 8000`. On Vercel, set `BILLING_API_URL` once the backend is deployed.

## Projects
- Supabase: `Supabase_Hackathon`, ref `bwqjknrqcqelgpixzwut` (us-east-1). Use this ref for every Supabase MCP call. The org also has `Machanize US West` (`kidmwrkraozhsdiycxju`) — never touch it.
- Vercel: project `supabase-hackathon`, team `aliuraishmirani-4593s-projects`; the repo root is linked (`.vercel/`). Production: https://supabase-hackathon-phi.vercel.app. The project's Root Directory must be `frontend`. `frontend/vercel.json` pins `framework: nextjs` (the project was created with preset "Other", which serves 404s). `backend/` deploys as its own Vercel project and is excluded here by `.vercelignore`.

## Supabase in code (paths under `frontend/`)
- `lib/supabase/server.ts` — Server Components, Server Actions, Route Handlers: `await createClient()`. RLS applies as the signed-in user.
- `lib/supabase/client.ts` — Client Components.
- `lib/supabase/admin.ts` — secret key, bypasses RLS, server-only. Only for trusted work.
- `proxy.ts` → `lib/supabase/proxy.ts` refreshes the session on every request. Add protected route prefixes to `PROTECTED_PREFIXES` (`/dashboard` is public on purpose).
- Check auth on the server with `supabase.auth.getClaims()`, not `getSession()`.
- Auth flow: `app/login` (server actions), `app/auth/callback` (email links / OAuth), no login wall for the dashboard: `lib/doorway.ts` starts an anonymous Supabase session for write actions.
- Types: `frontend/lib/database.types.ts`. After any schema change, regenerate with MCP `generate_typescript_types` and overwrite the file.

## Schema changes
1. Write the SQL to `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`.
2. Apply the same SQL with MCP `apply_migration` (same name).
3. Enable RLS on every new `public` table and add its policies in the same migration.
4. Run MCP `get_advisors` (security), fix findings, then regenerate types.

`billing_*` tables are owned by the backend's migration — coordinate before altering them.

## Env
`.env` is the local source of truth for the backend (gitignored; root `.env.local` only holds Vercel's OIDC token). Next.js only reads env files inside `frontend/`: `frontend/.env.local` holds the public Supabase values plus `DOORWAY_API_URL`, `NEXT_PUBLIC_DOORWAY_API_URL`, `NEXT_PUBLIC_DOORWAY_MOCK` (1 = in-browser fixtures) and `BILLING_API_URL` (template: `frontend/.env.example`). Never put secret keys in `frontend/`. Vercel has `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` in production, preview and development.
To add a frontend var: put it in `frontend/.env.local`, a placeholder in `frontend/.env.example`, then `printf '%s' "$VALUE" | vercel env add NAME <production|preview|development>` per environment. `NEXT_PUBLIC_*` values are inlined at build time, so redeploy after changing them.

## Commands
- In `frontend/`: `npm run dev` · `npm run build` · `npm run lint`
- Deploy: `vercel deploy --prod`. Preview: `vercel deploy --target=preview` (always pass the target explicitly). Previews sit behind Vercel auth; test them with `vercel curl /api/health --deployment <url>`.
- Health check: `GET /api/health` → `{"ok":true,"supabase":"ok"}`

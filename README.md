# Doorway — Supabase × Stripe hackathon

Doorway turns websites with no API into verified, self-healing MCP tools that agents call and pay for per call.

- `frontend/` — Next.js 16 dashboard (Supabase Auth, pixel theme). Deployed on Vercel with Root Directory `frontend`.
- `backend/` — FastAPI: Doorway API (`backend/DOORWAY_API.md`) and Stripe billing (`backend/README.md`).
- `supabase/` — migrations and Supabase Compute workers.

```bash
cd frontend
cp .env.example .env.local   # fill in the public Supabase values
npm install
npm run dev                  # http://localhost:3000
```

`NEXT_PUBLIC_DOORWAY_MOCK=1` runs the dashboard on in-browser fixtures with a fake live stream; set it to `0` to read the real backend at `NEXT_PUBLIC_DOORWAY_API_URL` (start it with `cd backend && uv run uvicorn app.main:app --port 8000`).

- `/` — landing · `/dashboard` — Workspace, Graph, Race, Sandboxes, Sites · `/sites/[id]` · `/tools/[id]` · `/profile`
- `/login` — optional, only for billing · `/pricing` · `/api/health`

See `CLAUDE.md` for project IDs, migration workflow and env conventions.

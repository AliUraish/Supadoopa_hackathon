# Supabase Hackathon

Next.js 16 + Supabase Auth/Postgres, deployed on Vercel. Billing is a separate FastAPI service in `backend/`.

```bash
cp .env.example .env   # fill in Supabase keys
npm install
npm run dev            # http://localhost:3000
```

- `/login` — email/password sign in and sign up
- `/dashboard` — protected example page
- `/api/health` — checks env and Supabase reachability

Deploy with `vercel deploy --prod`. See `CLAUDE.md` for project IDs, migration workflow and env conventions.

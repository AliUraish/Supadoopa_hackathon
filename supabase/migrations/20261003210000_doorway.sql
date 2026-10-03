-- Doorway: websites without an API → verified, self-healing, paid MCP tools.
-- This is the central memory every sandbox shares: sites, capabilities, tools (+ versions),
-- reusable patterns, the job queue, the sandbox registry and message board, runs, races,
-- the live event feed, and users' saved details with per-site consent.
-- Only the backend writes (secret key, bypasses RLS). The dashboard reads the public tables.

create table public.doorway_sites (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  base_url text not null,
  goal text,
  status text not null default 'new' check (status in
    ('new', 'queued', 'discovering', 'verifying', 'ready', 'broken', 'healing', 'failed')),
  is_demo boolean not null default false, -- demo sites expose /admin/version for break/reset
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Shared memory: a tool template learned on one site, reusable on others.
create table public.doorway_patterns (
  id bigint generated always as identity primary key,
  name text not null unique, -- e.g. slot_booking
  description text not null,
  signature jsonb not null default '{}'::jsonb, -- how to recognise it (roles, field names, endpoint shapes)
  template jsonb not null, -- tool spec templates keyed by role
  created_by text, -- sandbox id
  source_site_id text references public.doorway_sites (id) on delete set null,
  used_by text[] not null default '{}', -- site ids that adopted it
  success_count integer not null default 0,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.doorway_capabilities (
  id bigint generated always as identity primary key,
  site_id text not null references public.doorway_sites (id) on delete cascade,
  name text not null,
  description text not null,
  kind text not null check (kind in ('read', 'action')),
  status text not null default 'discovered' check (status in
    ('discovered', 'compiled', 'verified', 'broken', 'repairing')),
  evidence jsonb not null default '{}'::jsonb, -- forms, endpoints, inputs, outputs observed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, name)
);

create table public.doorway_tools (
  id bigint generated always as identity primary key,
  site_id text not null references public.doorway_sites (id) on delete cascade,
  capability_id bigint references public.doorway_capabilities (id) on delete set null,
  name text not null check (name ~ '^[a-z][a-z0-9_]{1,63}$'),
  description text not null,
  kind text not null check (kind in ('read', 'action')),
  status text not null default 'draft' check (status in ('draft', 'verified', 'broken', 'repairing')),
  version integer not null default 0, -- current published version (0 = none yet)
  spec jsonb, -- current spec, denormalized for fast execution
  best_strategy text check (best_strategy in ('api', 'form', 'browser')),
  p50_ms integer,
  success_rate real,
  runs_count integer not null default 0,
  price_cents integer not null default 0,
  pattern_id bigint references public.doorway_patterns (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, name)
);

create table public.doorway_tool_versions (
  id bigint generated always as identity primary key,
  tool_id bigint not null references public.doorway_tools (id) on delete cascade,
  version integer not null,
  spec jsonb not null,
  status text not null check (status in ('verified', 'broken')),
  source text not null check (source in ('discover', 'reuse', 'heal', 'reverify', 'seed')),
  verified_by text, -- sandbox id
  strategies jsonb not null default '{}'::jsonb, -- {"api": {"ms": 84, "passed": true}, ...}
  created_at timestamptz not null default now(),
  unique (tool_id, version)
);

create table public.doorway_sandboxes (
  id text primary key,
  status text not null default 'idle' check (status in ('idle', 'busy', 'offline')),
  current_job_id bigint,
  site_id text,
  job_kind text,
  jobs_done integer not null default 0,
  last_heartbeat timestamptz not null default now(),
  started_at timestamptz not null default now()
);

create table public.doorway_jobs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('discover', 'verify', 'heal', 'optimize', 'race')),
  site_id text references public.doorway_sites (id) on delete cascade,
  tool_id bigint references public.doorway_tools (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  priority integer not null default 0, -- higher first (heal > verify > discover)
  claimed_by text,
  not_sandbox text, -- must run on another sandbox (independent verification)
  attempts integer not null default 0,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index doorway_jobs_queue_idx on public.doorway_jobs (priority desc, id) where status = 'queued';

-- Sandbox-to-sandbox blackboard. to_sandbox null = broadcast.
create table public.doorway_messages (
  id bigint generated always as identity primary key,
  from_sandbox text not null,
  to_sandbox text,
  kind text not null check (kind in
    ('hello', 'tool_published', 'pattern_published', 'need_tool', 'validated', 'broken')),
  body jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.doorway_runs (
  id bigint generated always as identity primary key,
  tool_id bigint references public.doorway_tools (id) on delete set null,
  site_id text references public.doorway_sites (id) on delete cascade,
  mode text not null check (mode in ('broker', 'browser_agent', 'dashboard', 'verify')),
  strategy text check (strategy in ('api', 'form', 'browser')),
  status text not null check (status in ('success', 'failure')),
  ms integer,
  steps integer,
  tokens integer,
  paid_reference text,
  error text,
  created_at timestamptz not null default now()
);

create index doorway_runs_tool_idx on public.doorway_runs (tool_id, id desc);

create table public.doorway_races (
  id text primary key,
  site_id text references public.doorway_sites (id) on delete cascade,
  task text not null,
  inputs jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  browser jsonb not null default '{}'::jsonb,
  broker jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Agent broker requests (may hold personal inputs/results: not publicly readable).
create table public.doorway_requests (
  id text primary key,
  website text not null,
  task text not null,
  site_id text references public.doorway_sites (id) on delete set null,
  tool_id bigint references public.doorway_tools (id) on delete set null,
  status text not null default 'discovering' check (status in
    ('discovering', 'executing', 'done', 'failed')),
  inputs jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.doorway_events (
  id bigint generated always as identity primary key,
  site_id text references public.doorway_sites (id) on delete cascade,
  sandbox_id text,
  kind text not null,
  message text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index doorway_events_site_idx on public.doorway_events (site_id, id desc);

-- Shared memory: lessons learned from mistakes fixed once, read before every new exploration.
-- Sandboxes propose lessons; only approved ones are fed to explorers. (Idea and the curated
-- seed lessons come from the team's earlier project, Skeleton Key.)
create table public.doorway_lessons (
  id bigint generated always as identity primary key,
  lesson text not null unique,
  scope text not null default 'explore' check (scope in ('explore', 'spec', 'session', 'verify')),
  site_id text references public.doorway_sites (id) on delete set null,
  sandbox_id text,
  failure text,
  fix text,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  source text not null default 'auto' check (source in ('auto', 'curated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.doorway_lessons (lesson, scope, status, source) values
  ('Never hard-code one-time headers such as anti-bot tokens, CSRF values or page URLs in a tool spec; keep only constant client headers.', 'spec', 'approved', 'curated'),
  ('Optional inputs such as cursors and filters must be left out of the request when unset; never reuse a captured value as a default.', 'spec', 'approved', 'curated'),
  ('Never put Authorization headers, cookies or tokens in a tool spec; the session is injected per call.', 'spec', 'approved', 'curated'),
  ('A write whose undo is itself (like updating a profile) has no real undo: never execute it during verification.', 'verify', 'approved', 'curated'),
  ('Run a reversible write only together with its undo, so the site ends where it started; never auto-run irreversible writes (payments, deletes, sending messages).', 'verify', 'approved', 'curated'),
  ('Menus are often built from plain divs; treat any pointer-cursor element as clickable or undo options stay invisible.', 'explore', 'approved', 'curated'),
  ('A URL path segment is an id only if it is numeric or a long token containing a digit; hyphenated words are endpoint names.', 'explore', 'approved', 'curated'),
  ('An id followed by a file extension is still an id (/_next/data/<build>/e/<id>.json); static assets are never API calls.', 'explore', 'approved', 'curated'),
  ('Login endpoints often use camelCase names (getLoginToken, verifyOtp): split camelCase before matching auth words, and never turn login flows into tools.', 'explore', 'approved', 'curated'),
  ('Many apps authenticate with a bearer token kept in browser storage (Firebase, Supabase), not a cookie; capture it with the session.', 'session', 'approved', 'curated'),
  ('Decode response bodies as UTF-8 regardless of the declared charset; a guessed encoding garbles text such as curly quotes.', 'spec', 'approved', 'curated');

-- A user's saved form details, reused only on sites they consented to.
create table public.doorway_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  fields jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.doorway_consents (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  site_id text not null references public.doorway_sites (id) on delete cascade,
  fields text[] not null,
  granted_at timestamptz not null default now(),
  unique (user_id, site_id)
);

-- Claim the next queued job atomically (sandboxes never grab the same job).
create function public.doorway_claim_job(p_sandbox text, p_kinds text[] default null)
returns setof public.doorway_jobs
language sql
as $$
  update public.doorway_jobs as j
     set status = 'running', claimed_by = p_sandbox, started_at = now(), attempts = j.attempts + 1
   where j.id = (
     select q.id from public.doorway_jobs as q
      where q.status = 'queued'
        and (p_kinds is null or q.kind = any (p_kinds))
        and (q.not_sandbox is null or q.not_sandbox <> p_sandbox)
      order by q.priority desc, q.id
      for update skip locked
      limit 1)
  returning j.*;
$$;

-- Put jobs back in the queue when their sandbox stopped heartbeating.
create function public.doorway_requeue_stale(p_seconds integer default 60)
returns integer
language sql
as $$
  with stale as (
    update public.doorway_jobs as j
       set status = 'queued', claimed_by = null, started_at = null
      from public.doorway_sandboxes as s
     where j.status = 'running'
       and s.id = j.claimed_by
       and s.last_heartbeat < now() - make_interval(secs => p_seconds)
    returning j.id)
  select count(*)::integer from stale;
$$;

-- Atomic pattern bookkeeping when a sandbox reuses a pattern.
create function public.doorway_pattern_used(p_id bigint, p_site text, p_success boolean)
returns void
language sql
as $$
  update public.doorway_patterns
     set used_by = case when p_site = any (used_by) then used_by else array_append(used_by, p_site) end,
         success_count = success_count + case when p_success then 1 else 0 end,
         failure_count = failure_count + case when p_success then 0 else 1 end,
         updated_at = now()
   where id = p_id;
$$;

revoke execute on function public.doorway_claim_job(text, text[]) from public, anon, authenticated;
revoke execute on function public.doorway_requeue_stale(integer) from public, anon, authenticated;
revoke execute on function public.doorway_pattern_used(bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.doorway_claim_job(text, text[]) to service_role;
grant execute on function public.doorway_requeue_stale(integer) to service_role;
grant execute on function public.doorway_pattern_used(bigint, text, boolean) to service_role;

-- Row level security: public dashboard tables are readable by anyone; private ones per user.
alter table public.doorway_sites enable row level security;
alter table public.doorway_patterns enable row level security;
alter table public.doorway_capabilities enable row level security;
alter table public.doorway_tools enable row level security;
alter table public.doorway_tool_versions enable row level security;
alter table public.doorway_sandboxes enable row level security;
alter table public.doorway_jobs enable row level security;
alter table public.doorway_messages enable row level security;
alter table public.doorway_runs enable row level security;
alter table public.doorway_races enable row level security;
alter table public.doorway_requests enable row level security;
alter table public.doorway_events enable row level security;
alter table public.doorway_profiles enable row level security;
alter table public.doorway_consents enable row level security;
alter table public.doorway_lessons enable row level security;

create policy "Public read" on public.doorway_sites for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_patterns for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_capabilities for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_tools for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_tool_versions for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_sandboxes for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_jobs for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_messages for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_runs for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_races for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_events for select to anon, authenticated using (true);
create policy "Public read" on public.doorway_lessons for select to anon, authenticated using (true);
create policy "Own profile" on public.doorway_profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Own consents" on public.doorway_consents for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on
  public.doorway_sites, public.doorway_patterns, public.doorway_capabilities, public.doorway_tools,
  public.doorway_tool_versions, public.doorway_sandboxes, public.doorway_jobs, public.doorway_messages,
  public.doorway_runs, public.doorway_races, public.doorway_requests, public.doorway_events,
  public.doorway_profiles, public.doorway_consents, public.doorway_lessons
  from anon, authenticated;

grant select on
  public.doorway_sites, public.doorway_patterns, public.doorway_capabilities, public.doorway_tools,
  public.doorway_tool_versions, public.doorway_sandboxes, public.doorway_jobs, public.doorway_messages,
  public.doorway_runs, public.doorway_races, public.doorway_events, public.doorway_lessons
  to anon, authenticated;
grant select on public.doorway_profiles, public.doorway_consents to authenticated;

grant select, insert, update, delete on
  public.doorway_sites, public.doorway_patterns, public.doorway_capabilities, public.doorway_tools,
  public.doorway_tool_versions, public.doorway_sandboxes, public.doorway_jobs, public.doorway_messages,
  public.doorway_runs, public.doorway_races, public.doorway_requests, public.doorway_events,
  public.doorway_profiles, public.doorway_consents, public.doorway_lessons
  to service_role;

-- Live dashboard.
alter publication supabase_realtime add table
  public.doorway_events, public.doorway_sandboxes, public.doorway_jobs, public.doorway_tools,
  public.doorway_messages, public.doorway_races, public.doorway_runs, public.doorway_lessons;

-- Screenshots and logs.
insert into storage.buckets (id, name, public)
values ('doorway-artifacts', 'doorway-artifacts', true)
on conflict (id) do nothing;

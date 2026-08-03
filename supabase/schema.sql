-- ============================================================================
-- PostCleaner — optional Supabase schema.
--
-- You do NOT need this. Jobs live in Durable Objects and work without any
-- database. Apply this only if you set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
-- and want job history to outlive the 30-day session cookie.
--
-- Note what is deliberately absent: no OAuth tokens, no post text, no post IDs.
-- Only counters and status. If this database leaks, nobody learns what anyone
-- deleted.
--
-- Apply with:  psql "$SUPABASE_DB_URL" -f supabase/schema.sql
--          or: paste into the Supabase SQL editor.
-- ============================================================================

create table if not exists public.jobs (
  id                text primary key,
  session_id        text not null,
  kind              text not null,
  source            text not null,
  dry_run           boolean not null default false,
  status            text not null,
  total             integer not null default 0,
  deleted           integer not null default 0,
  failed            integer not null default 0,
  skipped           integer not null default 0,
  label             text,
  cost_estimate_usd numeric(10, 4),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists jobs_session_created_idx
  on public.jobs (session_id, created_at desc);

create table if not exists public.preferences (
  session_id text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- The Worker talks to PostgREST with the service role key, which bypasses RLS.
-- We still enable it and add no permissive policies, so that an accidentally
-- leaked anon key grants exactly nothing.
-- ---------------------------------------------------------------------------

alter table public.jobs        enable row level security;
alter table public.preferences enable row level security;

revoke all on public.jobs        from anon, authenticated;
revoke all on public.preferences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping: drop finished job records after 90 days.
-- Requires pg_cron (available on Supabase). Safe to skip.
-- ---------------------------------------------------------------------------

-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'postcleaner-prune',
--   '0 4 * * *',
--   $$ delete from public.jobs
--      where finished_at is not null and finished_at < now() - interval '90 days' $$
-- );

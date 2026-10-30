-- ── The Supabase surface a plain Postgres does not have ─────────────────────
--
-- `supabase/migrations` is written against a hosted project, which supplies a
-- few things PostgreSQL itself does not: the `auth` schema and its token
-- helpers, the `storage` schema and its bucket tables, and the three request
-- roles every policy names. Without them the migrations are not *wrong*, they
-- simply cannot be read — `to authenticated` is a syntax-adjacent failure, not
-- a policy decision.
--
-- This file provides only that surface. It is deliberately not a Supabase
-- emulator: nothing here issues tokens, and the policies are never exercised.
-- The check that uses it asks one question — can the whole set be applied
-- twice? — so the shapes need to be faithful enough for `create policy`,
-- `references auth.users`, and the receipt bucket insert to compile.
--
-- Kept in step with the migrations by `scripts/check-migrations.mjs`: if a file
-- starts reaching for something else Supabase provides, the second pass fails
-- here rather than on the hosted project.

create schema if not exists auth;
create schema if not exists storage;

-- The three roles Supabase creates per project. `nologin` because nothing in
-- this check ever signs in; the point is that `grant ... to authenticated`
-- resolves to a real role, the way it does on the project.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- `auth.users` is the parent of almost every owner column, so only the columns
-- the migrations touch are needed: `id` for the foreign keys, `email` for the
-- disposable-address trigger, and a creation time for completeness.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- The caller's id, read from the JWT claims Supabase sets per request. With no
-- claims set this is null, which is exactly the "signed out" answer the
-- security-definer functions already handle.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- The verified token itself, which `is_admin()` reads the email out of.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

-- The two storage tables the receipts bucket writes to.
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Policies are attached to this table by the receipts migration, and a policy
-- on a table without RLS enabled is accepted but never applied. Enabling it
-- here matches the hosted project and keeps the check honest about the schema.
alter table storage.objects enable row level security;

-- The folder portion of an object name, excluding the file itself: the receipts
-- policies compare `foldername(name)[1]` with the caller's uid.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  if parts is null or array_length(parts, 1) is null then
    return array[]::text[];
  end if;
  return parts[1:array_length(parts, 1) - 1];
end
$$;

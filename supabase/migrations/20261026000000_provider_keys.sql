-- ── Model keys an account brings itself ─────────────────────────────────────
-- A key is a credential, so it is stored like one: sealed with the deployment's
-- 32-byte key (AES-256-GCM, lib/github/crypto.ts) before it is written, and
-- readable only by its owner. The browser never receives it again — the keys
-- route answers with a four-character hint — so a stolen row is ciphertext, and
-- a stolen session can replace a key but not read one.
--
-- The row is per account and per provider, not per device: a person who brings
-- a Gemini key expects it to work on their phone too. Where the request is made
-- is decided by the route that calls the provider, with the caller's own token,
-- exactly as every other read here.
--
-- Nothing in this table is authority over anything but the owner's own requests.
-- A key here cannot unlock the administrator's console, cannot change a policy,
-- and cannot read another account's row: `owner = auth.uid()` is the whole rule,
-- in both directions.

create table if not exists public.provider_keys (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text not null check (provider in ('openrouter', 'gemini', 'groq')),
  sealed text not null,
  hint text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, provider)
);

alter table public.provider_keys enable row level security;

drop policy if exists provider_keys_owner on public.provider_keys;
create policy provider_keys_owner on public.provider_keys
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- The administrator's console has no business reading anybody's key either; the
-- policies above are complete without an admin branch, and this table is
-- deliberately not added to one.
grant select, insert, update, delete on public.provider_keys to authenticated;

-- The setup audit learns about the new table, so a deployment that forgot this
-- migration says which one is missing instead of failing a request later.
insert into public.schema_expected (object_name, kind, migration)
values ('provider_keys', 'table', '20261026000000_provider_keys')
on conflict (object_name) do nothing;

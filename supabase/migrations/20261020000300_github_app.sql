-- Phase 2: GitHub App installations.
--
-- An installation (not a user OAuth token) is the credential used for repo
-- writes. Installations are linked to users through a signed `state` value in
-- the install flow; `user_id` stays nullable so a webhook that lands before the
-- browser callback can record the installation without guessing an owner.

create table if not exists public.github_installations (
  installation_id bigint primary key,
  user_id uuid references auth.users (id) on delete cascade,
  account_login text not null,
  account_type text,
  repository_selection text not null default 'selected'
    check (repository_selection in ('all', 'selected')),
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One linked installation per user in Phase 2.
create unique index if not exists github_installations_user_key
  on public.github_installations (user_id)
  where user_id is not null;

create index if not exists github_installations_login_idx
  on public.github_installations (lower(account_login));

-- Short-lived installation tokens (1h). Cached so a multi-step task does not
-- mint a new token for every step; ciphertext only, never plaintext.
create table if not exists public.github_installation_tokens (
  installation_id bigint primary key
    references public.github_installations (installation_id) on delete cascade,
  token_ciphertext text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

drop trigger if exists github_installations_touch on public.github_installations;
create trigger github_installations_touch before update on public.github_installations
  for each row execute function public.touch_updated_at();

alter table public.github_installations enable row level security;
alter table public.github_installation_tokens enable row level security;

drop policy if exists github_installations_select_own on public.github_installations;
create policy github_installations_select_own on public.github_installations
  for select to authenticated using (auth.uid() = user_id);

-- Token material is never client-readable.
drop policy if exists github_installation_tokens_no_client_access
  on public.github_installation_tokens;
create policy github_installation_tokens_no_client_access
  on public.github_installation_tokens
  for select to authenticated using (false);

-- ── Background turns ──────────────────────────────────────────────────────────
-- A message sent in background mode has to survive the tab that sent it. The
-- browser cannot keep a stream alive after it closes, so the turn runs on the
-- server and this table is its receipt: what was asked, which rows the answer
-- belongs to, and the answer itself once it exists.
--
-- The result is stored on the job as well as written into `chat_messages`. That
-- duplication is deliberate. The browser uploads a chat as a whole (it deletes
-- the chat's rows and re-inserts what it holds), so a background answer that
-- lands between two uploads can be removed from `chat_messages` before the tab
-- that closed ever sees it. The job row is not part of that upload, so it is
-- what lets the next visit hand the answer back.
--
-- Owner-only, like the chats. The job is written with the caller's own token;
-- there is no service key in this deployment. A caller can therefore mark its
-- own job done — it can already write its own messages, so that grants nothing
-- new — and cannot see or touch anybody else's job at all.

create table if not exists public.chat_jobs (
  id text primary key check (char_length(id) between 8 and 64),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  chat_id text not null,
  user_message_id text not null,
  assistant_message_id text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'failed')),
  error text,
  /** The answer, kept even when the chat upload replaced its message row. */
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, user_message_id)
);

create index if not exists chat_jobs_owner_idx
  on public.chat_jobs (owner, created_at desc);
create index if not exists chat_jobs_status_idx
  on public.chat_jobs (owner, status, created_at desc);

alter table public.chat_jobs enable row level security;

drop policy if exists chat_jobs_owner on public.chat_jobs;
create policy chat_jobs_owner on public.chat_jobs
  for all
  using (owner = auth.uid())
  with check (owner = auth.uid());

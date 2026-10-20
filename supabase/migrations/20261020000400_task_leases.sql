-- Serverless task leases.
--
-- Cloudflare Workflows serialises execution per instance, so it never needed a
-- lease. On Vercel the runner is a plain function that can die mid-task and be
-- re-dispatched by cron, so a task must have an expiring ownership marker:
-- whichever invocation successfully extends the lease owns the task, and a
-- crashed invocation's lease expires instead of blocking recovery forever.

alter table public.tasks
  add column if not exists lease_expires_at timestamptz;

create index if not exists tasks_lease_idx
  on public.tasks (status, lease_expires_at);

comment on column public.tasks.lease_expires_at is
  'Ownership lease for a running task. Expired leases may be re-dispatched; steps are idempotent.';

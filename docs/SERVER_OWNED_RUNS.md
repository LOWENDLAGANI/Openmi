# Server-owned runs — implementation plan

Goal: the browser sends a prompt and then **only reads**. The model call, the
streaming and the stored answer belong to a server-side run, so closing the tab
does not stop an answer and reopening the page picks it up where it is.

This plan covers **chat first**. Moving the repository agent's multi-step loop is
a separate, optional tail (item 10), because the agent's loop is currently
client-driven on purpose (`app/api/agent/step/route.ts`).

Effort is in focused days for one developer, and assumes no surprises in the
provider stream.

## Why it cannot be done in place

| Today | Consequence |
|---|---|
| `req.signal` is threaded into `callProvider` (`app/api/chat/route.ts`) | the tab closing aborts the upstream request |
| `maxDuration = 120`, `runtime = "nodejs"` | the function is frozen when the response ends |
| History is Dexie-first: the browser writes the row, then `lib/cloudHistory.ts` pushes it with the caller's JWT | browser gone means no row at all, not even partial text |
| The agent loop and the turn budget live in the client (`lib/agent/turns.ts`) | a background run has to own both |

## The shape

Three actors, one database:

1. **Enqueue** (`POST /api/runs`, request-scoped) — verifies the caller, checks
   config and rate limit, charges Dew, creates the `runs` row **and the empty
   assistant `chat_messages` row**, returns `{ runId, messageId }`.
2. **Runner** (always-on process, not Vercel) — claims a run with a lease, calls
   the provider, appends `run_events`, renews the lease, writes the final
   `chat_messages.content`, marks the run done or failed.
3. **Read** (`GET /api/runs/[id]/stream?after=<seq>`) — stateless SSE tail over
   `run_events` for a run the caller owns. Disconnecting stops the tail, not the
   run.

The browser keeps the exact rendering it has today; only what feeds it changes.

## Work items

| # | Item | Main files | Effort |
|---|---|---|---|
| 1 | Schema, RLS, publication | `supabase/migrations/20261029000000_runs.sql` | 0.5 d |
| 2 | Enqueue route | `app/api/runs/route.ts`, `lib/runs.ts` | 1–1.5 d |
| 3 | Runner core | `lib/runs/worker.ts`, `lib/runs/lease.ts` | 1.5–2 d |
| 4 | Runner host + deploy | `worker/`, `worker/Dockerfile`, `docs` | 1–1.5 d |
| 5 | Tail route | `app/api/runs/[id]/stream/route.ts` | 0.5–1 d |
| 6 | Client attach + resume | `app/page.tsx`, `lib/runsClient.ts` | 1.5–2 d |
| 7 | Dew at enqueue, release on failure | `lib/serverDew.ts`, `lib/runs.ts` | 0.5–1 d |
| 8 | Temp chat, share, admin console | `app/page.tsx`, `lib/cloudAdmin.ts` | 0.5 d |
| 9 | Tests | `tests/server-runs.test.ts` | 1 d |
| | **Chat total** | | **7.5–10.5 d** |
| 10 | Agent loop server-side (optional) | `lib/agent/*`, `app/api/agent/step/route.ts` | 3–5 d |

### 1. Schema (0.5 d)

Two tables, owner-only RLS, following `20261023000200_chats.sql` exactly.

```sql
create table public.runs (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  chat_id text not null,
  message_id text not null,              -- the assistant row this run fills
  kind text not null default 'chat' check (kind in ('chat', 'agent')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'error', 'cancelled')),
  request jsonb not null,                -- api messages, mode, prefs
  client_run_id text,                    -- idempotency key from the browser
  charged_millidew integer not null default 0,
  attempts integer not null default 0,
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, client_run_id)
);

create table public.run_events (
  seq bigint generated always as identity primary key,
  run_id text not null references public.runs (id) on delete cascade,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in
    ('mode', 'search', 'delta', 'usage', 'truncated', 'done', 'error')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

`owner` is denormalised on `run_events` for the same reason it is on
`chat_messages`: the policy must not join back to a row the caller could name.
Indexes: `runs (owner, created_at desc)`, `runs (status, lease_until)` for
claiming, `run_events (run_id, seq)`.

Also add `public.runs` to the `supabase_realtime` publication using the same
`do $$ … exception when undefined_object / duplicate_object` wrapper as
`20261023000000_init.sql`, so a second tab can attach later without a migration.

Retention: delete `run_events` for runs older than 24 h in the same nightly job
that already cleans the trash.

### 2. Enqueue route (1–1.5 d)

`POST /api/runs`. It is `app/api/chat/route.ts` up to the first provider call —
`isSameOriginRequest`, `verifyCaller`, `readConfig`, `checkRateLimit`,
`deductDew` — then it stops and returns. Nothing streams from this route.

- Creates the assistant `chat_messages` row **server-side** with the caller's
  JWT. This is the important change: today `app/page.tsx` creates that row
  locally (`appendMessage`) and `lib/cloudHistory.ts` pushes it, so a
  server-written row would be fought over by the browser's empty one. Making the
  server the creator, and returning `messageId` to the browser, removes the
  double write entirely.
- Rejects a duplicate `(owner, client_run_id)` by returning the existing run, so
  a flaky retry cannot start or charge a second generation.
- Refuses while the account already has a running run (cap: 1 concurrent, raise
  later), so a tab reloading in a loop cannot fan out.

### 3. Runner core (1.5–2 d)

`lib/runs/worker.ts`, reusable as a library so it can be tested without a host.

Loop: `claim → heartbeat → stream → finalise`.

- **Claim**: `update runs set status='running', lease_until = now() + 60s,
  attempts = attempts + 1 where id = (select id from runs where status='queued'
  order by created_at for update skip locked limit 1) returning *`. `skip locked`
  is what keeps two runners from taking the same row.
- **Stream**: the provider loop from `app/api/chat/route.ts` (retry, family
  fallback, continuation on `finish_reason: "length"`) moves here almost
  verbatim. Instead of `controller.enqueue`, it inserts `run_events` rows in
  batches of ~10 deltas or every 200 ms, whichever comes first.
- **Heartbeat**: renew the lease every 20 s and check `status`. If the row has
  become `cancelled`, stop between chunks and finalise as cancelled.
- **Finalise**: write `content`, `model`, `usage`, `truncated`, `error` onto the
  `chat_messages` row, append the `done` event, set `status`.
- **Reaper**: a 30 s sweep marks `running` runs whose `lease_until` has passed and
  whose `attempts < 3` back to `queued`, otherwise `error`. Without this a crashed
  runner leaves the UI spinning forever.

The runner needs the deployment provider keys, `GITHUB_TOKEN_KEY` (to open an
account's own provider keys), and its own database credential.

### 4. Runner host (1–1.5 d)

A small Bun process on an always-on host (Fly/Railway/VPS) rather than Vercel:
`worker/main.ts` polls `claim` every second, runs up to N in parallel, logs one
line per run. Ship a `Dockerfile`, a health endpoint, and the env list in
`README.md`. Restart policy is the host's.

**Decision to lock before day 1:** the runner is not the caller's request, so it
cannot borrow the caller's JWT. Either (a) a dedicated Supabase credential on the
worker's host with a policy `using (owner = auth.uid() or public.is_runner())`,
or (b) run as the owner by minting a short-lived token server-side. Option (a) is
recommended and is the one place the "no service-role key anywhere" rule needs an
explicit, written exception — narrow policy, own host, not in this app's env.

### 5. Tail route (0.5–1 d)

`GET /api/runs/[id]/stream?after=<seq>`: verifies the caller, checks the run
belongs to them, then streams `run_events` where `seq > after` in order,
emitting the same `data: {...}` frames the client parses today
(`content`, `model`, `search`, `usage`, `truncated`, `error`), plus
`{ run: { status } }`. It re-queries every 250 ms while the run is `queued` or
`running` and ends on `done`/`error`/`cancelled`. No state, no provider, no Dew:
a tab that dies costs one closed reader.

A `Last-Event-ID` header or the `after` query is what makes reconnect lossless.
`revalidate = 0`, `runtime = "nodejs"`, `maxDuration` can stay high because the
tail is cheap.

Ordering rule: the SSE frame's `seq` is `run_events.seq`, and the client drops
anything `<= lastSeen` — the only way a reconnect cannot duplicate text.

### 6. Client attach + resume (1.5–2 d)

- Split the `flushLine` / read loop out of `app/page.tsx` (~line 1030) into
  `lib/runsClient.ts`: `startRun()` posts to `/api/runs`, `attachRun(runId,
  after)` reads the tail. The render path is unchanged — it still calls
  `writeContent`, `patchMessage`, `writeUsage`, `markError`.
- **Resume**: on hydration, once `account` is known, `select` runs for
  `auth.uid()` with `status in ('queued','running')` and attach to the newest. One
  query, one reattach; if it finished while the tab was closed, the final row is
  already in Postgres and the normal pull shows it.
- **Stop** becomes `PATCH /api/runs/[id]` with `{ status: 'cancelled' }` plus
  aborting the local tail. Say plainly in the UI that it stops at the next chunk.
- **Temporary chats** must stay request-scoped. A run has to persist to be
  readable, so a temporary chat is either excluded (it keeps today's behaviour,
  and says so) or it stops being temporary. Recommend: excluded.

### 7. Dew (0.5–1 d)

Charge in the enqueue route, before the provider call, exactly as
`/api/chat` does now (`deductDew` with the caller's JWT), and record
`charged_millidew` on the run. The runner never touches the wallet.

Failure before any token spent (provider down, bad key, lease exhausted) needs a
refund: a new `release` ledger action in `lib/serverDew.ts`, written by the
runner through the narrow credential, idempotent per run id. Without it a failed
run is a silent charge.

### 8. Cross-feature edges (0.5 d)

- `/api/share` copies the message, so it is unaffected once `done` ran.
- `lib/cloudAdmin.ts` wipes by owner: `runs`/`run_events` need the same admin
  policy and the same delete in a wipe.
- `lib/privacy.ts` and `app/privacy/page.tsx` must name published prompts and
  their stored events.
- Trash and permanent delete cascade through `chat_messages`; add the `runs`
  delete so a deleted chat leaves no run behind.

### 9. Tests (1 d)

`tests/server-runs.test.ts` in the existing source-contract style, plus pure
units:

- claim uses `for update skip locked`; a second claim on a leased run returns
  nothing;
- reaper requeues under 3 attempts and errors at 3;
- duplicate `client_run_id` returns the first run and does not charge twice;
- tail drops frames `<= after` and ends on `done`;
- the runner never calls `deductDew`; the enqueue route always does;
- RLS source check: `runs`/`run_events` carry owner policies and grants.

Manual, once, against a local Supabase: start a run, kill the tab, confirm the
run finishes and the row is complete; reload and confirm the text appears with no
gap; cancel mid-stream and confirm `cancelled` plus no further events.

### 10. Agent loop, optional (3–5 d)

The same runner, `kind = 'agent'`: it owns the loop in `lib/agent/run.ts` instead
of the browser, storing transcript and step state **on the run row**. That
retires `lib/agent/turns.ts` (the HMAC budget exists only because the client
carries the state) and makes the step cap and token cap ordinary columns.

`propose_edits` output already lands in `change_sets` through
`lib/changesets.ts`, so proposals survive the tab. `Approve & commit` stays
request-scoped and unchanged.

## Sequencing

| Milestone | Items | Ships |
|---|---|---|
| A | 1, 3 (library, no host) | a runner provable in tests |
| B | 2, 5, 6 | chat runs end-to-end on a laptop |
| C | 4, 7 | deployed, charged, refunded |
| D | 8, 9 | safe to enable for accounts |
| E | 10 | agent turns outlive the tab |

A and B are the risky half; do not start C until the tab-kill test passes
locally.

## Risks

| Risk | Mitigation |
|---|---|
| Two writers of the assistant row (browser and server) | server creates the row, returns `messageId`; the client never appends it |
| Orphaned `running` runs | lease + reaper + attempt cap, surfaced in the console |
| Double charge on retry | `unique (owner, client_run_id)` and the charge inside the same transaction as the insert |
| Paying for runs nobody reads | one concurrent run per account; the tail closing does not cancel |
| Provider key exposure to a new host | the runner holds `GITHUB_TOKEN_KEY`; that is a real expansion of trust and belongs in `README.md` |
| Reconnect duplicates text | `seq` ordering, `after` on every attach |

## Non-goals

Multi-device live sync of a run (Realtime can add it later once `runs` is in the
publication), resumable tool execution, and any change to the one endpoint that
writes to GitHub.

## Total

**7.5–10.5 focused days** for chat; **+3–5 days** for the agent. The cheap
alternative that captures only "the answer is not lost" — server-written partial
rows plus resume on reload, no worker — is about **1 day**, and is worth doing
even if the full plan waits.

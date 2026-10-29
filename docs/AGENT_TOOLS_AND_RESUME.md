# The agent's tools, its input contract, and a turn that outlives its tab

Status: **shipped and verified, except where marked otherwise.** This is the one
file to read before changing the repository agent. It records what was built,
what was actually checked, what is still open, and the conventions a new tool has
to follow so it does not half-register.

Commits:

| Commit | What it contains |
|---|---|
| `ff64a2d` | `read_issue` tool, attachments reaching the agent, per-model input gating |
| `49831c2` | A repository turn that resumes after the tab is closed |

Companion documents: `docs/AGENT_CAPABILITIES.md` (the read/propose/commit
boundary — still the authority on what the agent may do), `docs/ROADMAP.md`.

---

## 1. `read_issue` — the agent can read the issue it was asked to fix

Before this, "fix issue 42" was unanswerable: the agent could read files and
search code, and had no way to see the issue. It either invented requirements or
burned steps searching for a phrase it had never read.

- `lib/github/client.ts` → `getIssue(token, fullName, number)`. A GET, like
  everything in that file. GitHub serves pull requests through the issues
  endpoints, so one read covers both. Bound at the source: body **6,000 chars**,
  the **8 most recent** comments at **1,500 chars** each, returned oldest-first
  so they read in order, plus `commentTotal` so the reader knows what was left
  out.
- `lib/agent/tools.ts` → the tool itself. Registered in the name union, in
  `READ_ONLY_TOOLS` (so the "no tool can write" test keeps its meaning), in
  `AGENT_TOOL_SCHEMAS`, in `describeToolCall`, and in `runTool`. The tool
  validates the number before anything is fetched and returns a refusal the
  model can act on instead of throwing — a throw ends the turn.
- `lib/agent/run.ts` → `context.readIssue`, implemented with the caller's token,
  and `repoPrompt` now names five tools.
- `lib/types.ts` → `AgentStep["tool"]` gained `read_issue`.
- `lib/agentStream.ts` and `lib/chatSync.ts` → their `STEP_TOOLS` allowlists.
  **These matter:** without them a `read_issue` step is silently dropped from the
  live stream and from account sync, and the thread shows a step that vanished.

Cost: roughly **85 tokens** added to every agent request, since every schema is
serialised on each call and a turn can make up to 40 of them.

## 2. Attachments now reach the agent

The composer used to send anything with an attachment to plain chat — where no
repository exists — and never said so. The agent silently disappeared.

- `app/chat/page.tsx` → a turn goes to the agent when a repository is attached
  and the attachments are **not** images (`agentTurn = Boolean(project) &&
  images.length === 0`). Images still fall back to chat, because the Code model
  has no vision.
- The extracted file text travels as `context` on every step request, capped at
  **12,000 chars** in `app/api/agent/step/route.ts`.
- `lib/agent/run.ts` → `StepRequest.context`, injected as one user message
  prefixed with `ATTACHMENT_MARKER`. It is re-sent per step rather than folded
  into the transcript, so a pasted log cannot be mistaken for something the
  person said in an earlier turn.

## 3. Per-model input gating

A text-only model was being handed images. One declaration now answers "may I
attach this?" for both the composer and the server.

- `lib/models.ts` → `ModeCapabilities` and `MODE_CAPABILITIES`:
  Auto `{ images: true, documents: true }`, Code and Flash `{ images: false,
  documents: true }`. `modeCapabilities(id)` is the accessor.
- `components/ChatInput.tsx` → Camera, Gallery and Files are disabled with a
  tooltip that says why, and `addFiles` / `addDocuments` refuse with a message in
  the composer's own words rather than letting the provider drop it.
- `app/api/chat/route.ts` → the server refuses an image sent to a mode that
  cannot read one. The composer is a courtesy; this is the check that survives
  somebody editing the bundle.

## 4. A turn that resumes after the tab closes

The loop is client-driven: the browser asks for one step at a time and carries
the transcript and the signed turn token back with each request. Close the tab
and step N+1 is never asked for. That is still true — what changed is that the
work is no longer lost.

- `lib/db.ts` → an `agentRuns` store (Dexie version 6) holding the loop's wire
  state: `transcript`, `turnToken`, `context`, `content`, `steps`, `projectId`.
  Helpers: `saveAgentRun`, `readAgentRun`, `clearAgentRun`,
  `nextResumableAgentRun`. Runs are also cleared with their chat on delete and
  with a full data wipe.
- `app/chat/page.tsx` → the loop writes the record after **every completed,
  non-final step** (only once a turn token exists — a run without one would start
  a fresh turn rather than continue this one). A `resume` option seeds the loop
  and skips appending the question and the answer row, so it continues into the
  message that was already being written. The record is cleared in `finally`:
  a finished, failed or deliberately stopped turn must never be resumed.
- A mount effect picks up `nextResumableAgentRun(project.id)` and continues it.

### The honest boundary

This is **pickup**, and — when the deployment holds a service key — **background
execution**. The difference is one environment variable:

- With `SUPABASE_SERVICE_ROLE_KEY` set, a turn is a row in `agent_runs` and the
tick advances it whether or not a tab is open. `app/chat/page.tsx` starts the run
and polls it; closing the tab only stops the rendering.
- With no key, `POST /api/agent/runs` answers `503 runs-unconfigured` and the page
falls back to the in-tab step loop it always had. Same turn, same bounds, and it
stops when the tab does.

The in-tab path is otherwise unchanged:

- A step that was in flight when the tab closed is re-asked, so that one step
  costs twice in GitHub reads. There is no double charge: the hour covers the
  turn and the signed token only advances forward.
- Resuming needs the same repository attached and a live hour session. Records
  are filtered by `projectId`; a run for another repository is skipped rather than
  continued.
- Records are device-local **by design**. The transcript is working state for one
  turn, not conversation history, and syncing it would hand a half-finished turn
  to a device that cannot continue it.

---

## What is still open

### Background execution (built)

A turn outlives its tab when the deployment holds a service key. The pieces:

1. `supabase/migrations/20261029000000_agent_runs.sql` — `agent_runs`, RLS shaped
   like `changesets`, except `authenticated` gets SELECT and nothing else.
2. `lib/supabaseAdmin.ts` — the only importer of `SUPABASE_SERVICE_ROLE_KEY`. It
   returns null when the variable is unset, which is the supported no-runs state.
3. `lib/agentRuns.ts` — create / read / claim / saveProgress / finish /
   listStaleRuns. `readOwnRun` uses the caller's token; the rest are the tick's.
4. `POST /api/agent/runs` — hour and repository checks, a row, a first tick.
5. `POST /api/agent/tick` — verifies the signed run token, runs exactly one
   `runAgentStep`, persists, chains the next tick, stops at the turn bounds.
6. `GET /api/agent/runs/[id]` — owner-scoped view the chat polls.
7. `POST /api/agent/runs/sweep` — the `pg_cron` entry point that re-ticks runs
   whose chain dropped.

**Idempotency is the hard part, not plumbing.** Two ticks on one run is two model
calls, so `claimRun` is what stands between the sweep and a double charge: a
conditional update on `status='running' AND heartbeat_at < now() - interval '90
seconds' AND attempts = <seen>`. The turn's own bounds (`MAX_STEPS = 40`,
`MAX_TURN_TOKENS = 200_000`, `TURN_TTL_MS = 30 minutes`) are enforced by the
driver, or an abandoned run quietly burns a 200k-token turn and the GitHub rate
limit with nobody watching.

**What does not change:** an unattended run still ends at a proposal.
`propose_edits` stages; committing requires a human approval signature
(`lib/changesets.ts`). That gate is the product, not a limitation to remove.

### Known test state

`tests/chat-sync.test.ts` → **"signing out leaves none of the previous session on
screen"** fails, and fails identically on a clean checkout (`git stash` confirmed
it). It is pre-existing, unrelated to this work, and deliberately not "fixed"
into passing. 21 of its 22 checks pass.

`tests/focus-home.test.ts` fails one check as well: **"the empty screen is the
only place Focus replaces the thread"**, because `app/chat/page.tsx` computes
`focusHome` without the `!temporary` the test expects. It fails identically at
`9070330` and before it, so it is pre-existing too. The full `bun run test`
script never reaches it — the chain stops at the `chat-sync` failure — which is
why the suite reports only that one.

### Not verified here

- `getIssue` against live GitHub — no token available in the environment it was
  built in. It is a GET through the same `githubFetch` helper as every other
  read.
- The attachment path end to end through a real model call.
- The browser reload-and-resume behaviour, which needs a real session, a live
  hour and a repository.

---

## The remaining work, in phases

Ordered so each phase is verifiable alone, and so the risky change (a new way for
a run to end) lands on top of tests rather than under them.

Delivered: **A** (`tests/agent-runs.test.ts`, 31 checks) and **B**
(`POST /api/agent/runs/[id]/cancel`). C, D and E are open.

### Phase A — Prove the claim

Goal: idempotency stops being a comment.

- New `tests/agent-runs.test.ts`: `claimRun` wins once per attempt and refuses a
  second tick holding the same number; a tick is refused when run, owner or
  attempt does not match the row, when expired, or truncated; `openRunState`
  answers null under another key; `toView` never carries `state`; the sweep fails
  a run at `RUN_MAX_ATTEMPTS` and re-dispatches the attempt it holds below it.
- No network: fake the admin client the way `tests/repo-agent.test.ts` fakes
  fetch. If the module-scope client blocks that, add the smallest seam — a
  parameter defaulted to `supabaseAdmin()` — not a container.
- Add the file to the hand-maintained list in `package.json`.

Exit: the new test passes, `typecheck` is clean, the rest of the suite unchanged.

### Phase B — Stop means stop

Goal: pressing Stop ends the run, not just the polling.

- `POST /api/agent/runs/[id]/cancel`: caller's JWT, same-origin, the `agent`
  rate-limit scope. Ownership is proved with the caller's token (`readOwnRun`);
  only then is the row closed with the service key — `cancelled`, `state: ''`.
  Cancelling a finished run returns the run, not an error.
- `finishRun` accepts `cancelled`. The status is already in the type and the
  check constraint, and nothing writes it.
- The composer calls it before aborting; a refused cancel must never block the
  abort. The poll renders `cancelled` as an ending, not a failure.
- Tests: another account cannot cancel this one; a late tick claims nothing.

Exit: Stop, then close the tab, leaves `cancelled` and no further heartbeat.

### Phase C — Make it operable

Goal: a fresh deployment can turn both features on from the docs alone.

- `.env.example`: "Never put the service_role key here or in any server route:
  nothing in this app needs it" is now false. Replace it, and list
  `SUPABASE_SERVICE_ROLE_KEY` (server only, optional, what it enables and what
  stops without it) and `AGENT_SWEEP_SECRET`.
- `supabase/README.md`: add `20261029000000_agent_runs.sql`; the table stops at
  `20261028000400_email_guard.sql`.
- A follow-up migration registering `agent_runs` in `schema_expected`, as the
  `provider_keys` migrations do, so `/api/setup` names the missing table instead
  of the run route answering 503 after the fact.
- The schedule: `pg_cron` + `pg_net` SQL with header, cadence and the secret, in
  the README rather than only in the route's comment. Until it exists the
  watchdog is code nobody calls.

Exit: no variable required by the code is absent from the documentation.

### Phase D — Say what is true

The header claims "shipped and verified" while background execution sits under
"What is still open"; split the two claims. Record the deliberate exceptions —
`tick` and `sweep` are gated by a signed claim and a shared secret and are
neither origin-checked nor rate-limited, and `GET /api/agent/runs/[id]` is not
rate-limited — where the cross-cutting rule is stated, or the rule is wrong by
omission.

### Phase E — The live pass

The three unverified paths plus the two new endings (cancelled, swept). Needs an
account, a live hour and a test repository. It also settles the pre-existing
`chat-sync` failure: fix it, or record it as known-failing where a reader looks.

Not in any phase: the approval gate, a write tool, code execution, or the BYOK
and AdSense items in `docs/ROADMAP.md`. Nothing here moves the boundary in
`docs/AGENT_CAPABILITIES.md`.

---

## Adding a tool: the registration checklist

A tool is not one function. Miss a step and it fails in a specific way.

1. `ToolName` union — `lib/agent/tools.ts`.
2. `READ_ONLY_TOOLS` or `PROPOSAL_TOOLS`. Never both. This is what gives the
   "no write tool" test its meaning.
3. `AGENT_TOOL_SCHEMAS` — the only part with a recurring cost.
4. `describeToolCall` — the timeline label.
5. The `runTool` branch. Validate before any fetch; never throw.
6. `ToolContext` — a lazy capability, absent when the deployment cannot do it.
7. `AgentStep["tool"]` in `lib/types.ts`.
8. `STEP_TOOLS` in **both** `lib/agentStream.ts` and `lib/chatSync.ts`.
9. `tests/repo-agent.test.ts` — two hardcoded lists assert the exact tool set,
   and the forbidden-name loop must keep passing.

## Invariants worth keeping

- Read plus propose. No tool writes to GitHub; `lib/github/client.ts` is GET-only
  and a test enforces that.
- A tool result is untrusted input and is bounded at its source, because every
  result is re-sent with each later step of the turn.
- A refusal is a result, not an exception.
- The model never receives a GitHub token.

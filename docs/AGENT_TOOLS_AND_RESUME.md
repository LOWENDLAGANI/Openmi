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

This is **pickup, not background execution**. Nothing runs while the tab is
closed. The turn continues when the page is opened again, from the last completed
step.

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

### Background execution (not built)

For a turn to keep working while the browser is closed, the loop has to move
server-side. The design that fits this codebase:

1. `agent_runs` in Postgres (RLS shaped like `changesets`): status, history,
   transcript, sealed turn token, steps, content, error, `heartbeat_at`,
   `attempts`.
2. `POST /api/agent/runs` creates the row and dispatches the first tick.
3. An internal tick endpoint, authorised by a **server-signed run token** rather
   than the user's session, running exactly one step and persisting it.
4. Chaining: each tick fires the next with a fire-and-forget `fetch` held open by
   `after()` / `waitUntil`. One dropped link silently stops a run.
5. A watchdog sweeping `status='running'` with a stale heartbeat and re-ticking
   it. Supabase already provides `pg_cron` + `pg_net`; no new vendor is needed.
   A search for a managed durable queue surfaced no suitable service, so the
   honest options are "build it on what exists" or buy a workflow engine
   separately.

**The hard part is idempotency, not plumbing.** Two ticks on one run is two
model calls. Claim the run with a conditional update — `status='running' AND
heartbeat_at < now() - interval '90 seconds'` — and keep a per-account cap on
simultaneous runs. The turn's own bounds (`MAX_STEPS = 40`,
`MAX_TURN_TOKENS = 200_000`, `TURN_TTL_MS = 30 minutes`) must be enforced by the
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

### Not verified here

- `getIssue` against live GitHub — no token available in the environment it was
  built in. It is a GET through the same `githubFetch` helper as every other
  read.
- The attachment path end to end through a real model call.
- The browser reload-and-resume behaviour, which needs a real session, a live
  hour and a repository.

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

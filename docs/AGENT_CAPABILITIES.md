# The repository agent: what it can and cannot do

Status: **Phase 0 diagnosis complete.** The live approve-and-commit run is the
only part still unverified; it needs an account and a test repository.

## The answer

The agent is **read + propose**, not read-only.

| Action | Allowed? | Where it is enforced |
|---|---|---|
| List files, read a file, search code | Yes | `lib/agent/tools.ts` |
| Stage a whole-file or exact-string edit, shown as a diff | Yes | `propose_edits` → `lib/agent/edits.ts` |
| Write a file to GitHub | No | no write tool; `lib/github/client.ts` is GET-only |
| Commit, push, open a PR | Only after the person approves | `app/api/changesets/[id]/commit/route.ts` → `lib/github/commit.ts` |
| Run tests, execute code, deploy | No | out of scope (`docs/OVERHAUL_SPEC.md`) |

The model never receives a GitHub token. The only route that writes to GitHub
takes a signed approval bound to the user, repository, base commit and
change-set hash, refuses a moved branch, and only ever creates an `agent/`
branch.

## Why it looked read-only

1. **The label was wrong.** The repository chip in the chat rendered the word
   **"read-only"** next to the repo name and base SHA
   (`app/page.tsx`). That word described the file viewer, but sat in the line
   that also describes the agent's working repository. Phase 1 replaces it
   with **"reads · proposes"** and a title that explains the approval step.
2. **Nothing asked for a proposal.** An answer that described a change had no
   next action. Phase 1 adds **Propose this change** to a finished agent
   answer that staged nothing, and says in the empty state that Openmi can
   read the repository and stage a diff.
3. **`/about` said the feature was not built.** The progress trail listed
   proposals and approved commits as "next" although both shipped. Fixed in
   Phase 1.
4. **A refused proposal only said "Nothing proposed".** The reasons were in
   the tool's response to the model, not in the thread. Phase 1 carries a
   short `detail` onto the step so the reader sees the reason
   ("path: old_string matches twice", "file too large", and so on).

## What the live run still has to prove

The code path exists and its pure parts are covered by
`tests/repo-agent.test.ts` (signature, hash, expiry, approval mismatch, branch
policy, double submit). What has not been exercised here is the network path
with a real account:

1. Connect a token with `repo` scope (or the OAuth App) and attach a test
   repository.
2. Ask for a small, unambiguous change in Code mode.
3. Confirm `propose_edits` is called and the proposal is saved
   (`changesets` row, `change_sets` policies applied).
4. Confirm the diff cards render and the message stores `changesetId`.
5. Press **Approve & commit** once. Confirm a PR exists on an `agent/...`
   branch.
6. Press it again. Confirm the first commit is returned instead of a second.

If step 3 fails, check the `changesets`, `approvals` and `commits` policies in
`supabase/migrations/20261023000400_changesets.sql` first. If step 5 fails,
check the token's reported scopes (`lib/github/pat.ts` describes them) and
whether the base branch moved.

## Failure modes that look like "read-only"

| What the person sees | Likely cause | Where |
|---|---|---|
| No diff, just prose | The model chose not to call `propose_edits` | Prompt behaviour; the new button asks explicitly |
| "Nothing proposed" plus a reason | Edit matched zero or several places, unsafe path, file too large | `lib/agent/edits.ts`, now shown as step detail |
| "Proposals are unavailable" | The step has no `propose` context | `lib/agent/run.ts` |
| "This change could not be saved for review" | `changesets` insert refused | Supabase policies |
| Approval refused | Change set expired, branch moved, approval mismatch, or another account | `commitGate` in `lib/changesets.ts` |
| Commit works but no PR | PR creation refused; the commit still landed | `lib/github/commit.ts` |

## Decision

Keep the approval gate. It is the product's differentiating promise, not a
limitation to remove. The work was to make it visible; Phase 1 does that. Code
execution remains out of scope.

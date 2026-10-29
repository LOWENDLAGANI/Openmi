# Openmi — next work, in phases

Status: **Phases 1–3 complete; Phase 0 complete except its live run.** Phase 2's
AdSense application, consent message and review are dashboard tasks, not code,
and Phase 3's cross-tab acceptance needs a shared store. This is the working
plan and the progress record; update the tracker when a phase moves, not just
at the end.
Last updated: 2026-10-28.

## Locked decisions (owner, 2026-10-25)

| Decision | Answer |
|---|---|
| Ads | **Mandatory.** Google AdSense. One small horizontal banner, about the height of the chat bar, directly **above the chat composer**. |
| BYOK billing | **Free**: a user's own key costs 0 Dew, with the same rate limits and no silent fallback to the deployment's key. |
| Promotion page | **Deferred.** Not scheduled in this plan. |
| Agent | Keep the approval gate. Make read-vs-write legible before adding anything on top. |
| Context circle | A circular gauge of the request budget, opening into a breakdown of what is in the context. |
| Rate limits | One policy, one error shape, visible countdown, no unguarded routes. |

## Phases at a glance

| Phase | Outcome | Items | Effort | Status |
|---|---|---|---|---|
| 0 | Baseline verified; agent diagnosed | 2, 5 | 0.5–1 d | **Done, live run pending** |
| 1 | Agent's propose-and-approve path is legible | 5 | 2–4 d | **Done** |
| 2 | Composer gains a context ring and the AdSense banner | 4, 1 | 5–7 d | **Done (code); review pending** |
| 3 | Rate limits are complete, consistent and visible | 8 | 3–4 d | **Done** |
| 4 | Bring your own key, free of Dew | 3 | 8–12 d | **Partly shipped** — storage and routing, not yet free |
| — | Public promotion page | 9 | 4–6 d | **Deferred** |

Roughly **4–6 focused weeks** for Phases 0–4. AdSense approval is calendar
time on top of the code, which is why the account application starts in
Phase 0 while the banner is built in Phase 2.

Why the order differs from the list:

- **Agent before everything.** It is the product's promise. If the path from
  a question to an approved commit is invisible, accounts and ads on top only
  hide that. Phase 0 decides whether Phase 1 is code or copy.
- **Ads share the composer with the context ring.** Both are layout changes
  in the same stack; doing them together means one layout pass instead of
  two, and gets the mandatory banner shipped with the least churn.
- **BYOK last** because it is the only item that adds a table and a new
  server secret. It should not be in flight while the composer is moving.

---

## The agent question, answered plainly

**Can the AI write or commit to my GitHub?**

- It can **read** a repository: list files, read a file, search code.
- It can **propose** a change. `propose_edits` stages whole-file rewrites or
  exact replacements; the server computes the diff from the base commit.
- It **cannot write** to GitHub. There is no write tool, and
  `lib/github/client.ts` contains only GET requests. The model never holds a
  token.
- **You** can approve the proposal. Only then does the server commit — to a
  new `agent/<repo>-<id>` branch — and open a pull request. The approval is
  cryptographically bound to you, the repository, the base commit and the
  exact diff. A moved branch is refused, and a second submit returns the
  first commit.

So the accurate label is **read + propose**, not read-only.

And the reason it *looks* read-only is concrete: the repository chip in the
chat currently renders the word **"read-only"**
([app/page.tsx:1480](app/page.tsx#L1480)), which describes the file viewer,
not the agent. Phase 1 fixes that label and adds a one-click way to ask for
a proposal.

Whether the approve-and-commit path works end to end for a normal account is
the remaining Phase 0 question. The code path exists; it has not been
exercised against a live repository in this environment (no GitHub
connection, no deployment keys). That test needs an account and a test repo.

---

## Phase 0 — Baseline and diagnosis

**Goal:** know exactly what is real before changing anything.

### Done

- [x] Confirmed item 2: `e68ff7f` removed the line that raised
      "The model was changed automatically because the current model is
      experiencing a problem." in `app/page.tsx`. The assistant badge still
      updates from the streamed `evt.model`, which is the honest outcome.
- [x] Grepped source for the sentence and for "experiencing": no remaining
      surface announces a fallback as a failure.
- [x] Audited the agent path: three read tools + `propose_edits` in
      `lib/agent/tools.ts`; `lib/github/client.ts` is GET-only; the only
      write is `lib/github/commit.ts`, called only by
      `app/api/changesets/[id]/commit/route.ts` behind `commitGate`.
- [x] Found the misleading **"read-only"** chip in the chat
      ([app/page.tsx:1480](app/page.tsx#L1480)).
- [x] Found the AdSense blockers: the CSP in `next.config.mjs` allows scripts
      from `'self'` only and frames only `'self'`; there is no privacy page.
- [x] Found a stale sitemap entry: `app/sitemap.ts` lists `/notes`, which no
      longer exists (it points crawlers at a 404).

### Remaining

- [x] Added the regression test for item 2 in `tests/feature-batch.test.ts`:
      the removed sentence must not return, and `evt.model` must still patch
      the badge.
- [x] Removed the stale `/notes` sitemap entry (it pointed a crawler at a 404)
      and added a test for it.
- [x] Wrote `docs/AGENT_CAPABILITIES.md`: the read/propose/commit boundary,
      why it looked read-only, and the manual verification steps.
- [ ] Reproduce one agent turn against a repository the owner controls: ask
      for a small edit; record whether `propose_edits` is called, whether a
      change-set row is saved, whether diff cards render, and whether
      Approve & commit opens a PR.
- [ ] Test both GitHub doors: pasted PAT with `repo` scope, and the OAuth App
      flow. Record the scope GitHub actually reports.
- [ ] Rule out the failures that look like "read only" to a user: no project
      attached, the model choosing not to propose, `read_file` failures, an
      edit matching zero/several places, missing `change_sets` RLS.
- [ ] Start the AdSense application now (account + site verification), so the
      calendar review runs alongside the code. It needs the privacy page from
      Phase 2 before it can pass.
**Exit:** a one-page diagnosis, a decision for Phase 1, and an AdSense
application in review. The decision is recorded in
`docs/AGENT_CAPABILITIES.md`: keep the approval gate and make it visible.

---

## Phase 1 — Make the agent's propose-and-approve path legible

**Goal:** a person who asks for a change sees a path to a committed change,
without weakening the rule that nothing reaches GitHub unapproved.

Delivered:

- [x] Replaced the misleading **"read-only"** chip with **"reads · proposes"**
      and a tooltip that names what commits: your approval. The file viewer is
      still read-only; the chip no longer says that about the agent.
- [x] The empty state, when a repository is attached, now says: Openmi can read
      this repository and stage a diff; nothing is committed until you approve
      it. The repo panel already carried the approval rule, so it was left
      alone.
- [x] Added **Propose this change** to a finished agent answer that staged
      nothing. It sends a follow-up turn asking the agent to stage the change.
      That is a new Code request, and the button's title says so — it is not a
      free add-on to the previous turn.
- [x] A refused proposal now shows the server's reasons on the step line
      instead of only "Nothing proposed". `AgentStep.detail` carries the short
      cause through `lib/agent/tools.ts` and `lib/agent/run.ts`.
- [x] Updated the stale `/about` progress trail: repository reading, proposals
      and approved commits are all "Shipped". The README was already accurate
      about the approval rule and the read-only viewer.
- [x] Commit-gate coverage already existed in `tests/repo-agent.test.ts`
      (missing approval, edited approval, mismatch, expiry, branch policy,
      repeat submit), so no duplicate test was added.

Not done, and why: the live acceptance run (ask → diff → approve → PR) still
needs an account and a test repository. See `docs/AGENT_CAPABILITIES.md` for
the exact steps and the failure modes to check.

If a real blocker appears in that run, fix the blocker rather than adding more
UI. Explicit non-goal: **no code execution, sandbox, test runner or preview.**
That stays Phase 3 in `docs/OVERHAUL_SPEC.md` and is out of scope.

**Acceptance:** on a test repository, ask for a one-file change → diff cards →
approve → PR on an `agent/` branch → the chat says "proposed" before approval
and "committed" only after it. **Pending the live run.**

---

## Phase 2 — Composer: context circle + AdSense banner

**Goal:** answer "how full is this conversation?" and carry the mandatory ad,
in one layout pass above the composer.

### 2a. Context circle (3–4 d)

What exists: every assistant message stores
`usage: { prompt, completion, total }` (`lib/types.ts`), currently shown as a
small token count in `components/ChatThread.tsx`. The server caps a request
at roughly 30k tokens (`app/api/chat/route.ts`: 120 messages, 32k chars each,
200k total) and refuses a longer one with a 413 sentence.

- [x] `components/ContextRing.tsx`: one SVG ring, two arcs, no chart
      dependency (the technique already used by the Dew ring on
      `app/plus/page.tsx`). Thresholds at 70% and 90%; percent inside;
      `role="img"` with numbers in the label; focusable button.
- [x] Placement: composer header, right side; hidden on Focus home. Clicking
      opens a popover, not a dialog, with the breakdown and **Start a new
      chat** at >90%.
- [x] Denominator: Openmi's per-request budget, served by `GET /api/chat` as
      `contextBudget` (a number, no model id). Never expose a provider's
      context window — it is not the limit enforced and it leaks the vendor.
- [x] Numerator: the last assistant message's actual `usage.prompt`, plus an
      estimate for the draft, attachments and selected web sources. Reuse
      `estimateTokenUsage` from `lib/dew.ts`; label it approximate.
- [x] Breakdown buckets: system & tools, conversation, attachments, repo
      context (files read this turn), web sources. The server already knows
      the tool reads; pass counts on the done event rather than re-deriving
      them in the browser.
- [x] States: new chat (0%, muted), streaming (last known + spinner), no
      usage yet (estimate only), over budget (red + new-chat CTA), error
      (keep last known, never blank).
- [x] Persist the last prompt count per chat in Dexie (usage is already on
      the message; this is a read, not a new table).
- [x] Tests: percent clamping, thresholds, draft estimate, accessible label,
      and a source-contract test that the budget is a product number rather
      than a provider model name.

**Acceptance:** a 25k-token conversation shows ~83%; the popover explains
where the tokens went; a 32k draft warns before the server's 413.

### 2b. AdSense banner (3–4 d, plus calendar review)

Owner's specification: **mandatory**, one small horizontal banner about the
height of the chat bar, directly above the chat composer. This overrides the
earlier "no display ads in chat" recommendation; the constraints below keep
it from damaging the composer.

What has to change before a single ad can render:

- [x] **CSP** in `next.config.mjs` currently allows `script-src 'self'` and
      `frame-src 'self'`. Add only the AdSense origins, in the existing
      "boundaries" style, with a comment naming what each is for:
      - `script-src`: `https://pagead2.googlesyndication.com`,
        `https://*.googlesyndication.com`, `https://*.googleadservices.com`,
        `https://adservice.google.com`
      - `frame-src`: `https://googleads.g.doubleclick.net`,
        `https://tpc.googlesyndication.com`
      - `img-src`: `https://*.doubleclick.net`,
        `https://*.googlesyndication.com`
      - `connect-src`: the same origins as `script-src`
      Verify in dev with the console open; a blocked ad request is the
      failure this catches.
- [x] **Env**: `NEXT_PUBLIC_ADSENSE_CLIENT_ID` (`ca-pub-…`, public by design)
      and `NEXT_PUBLIC_ADSENSE_SLOT_ID`. No key is a secret here. Add both to
      `.env.example` with the dashboard path; absent means no ad, not a
      broken box.
- [x] **`components/AdBanner.tsx`**: load `adsbygoogle.js` once with
      `next/script` (`strategy="afterInteractive"`), render one labelled
      `<ins class="adsbygoogle">`, push once. No refresh on message send, no
      auto ads, no second unit.
- [x] **Layout**: a reserved-height container above `ChatInput` in
      `app/page.tsx` (between the repo chip and the composer), centered,
      `max-w-[728px]`, 50px mobile / 60px desktop, hairline border,
      `overflow-hidden`, the word "Ad" in the corner. Reserving the height is
      the whole point: a banner that arrives late and pushes the composer is
      worse than no banner.
- [x] Do not render on the auth screen, in temporary chats, or in Focus home;
      those are the places where an ad contradicts what the screen is for.
      State that in the component, so the choice is auditable.
- [x] **Kill switch**: `adsEnabled` in `app_config` (admin console) in
      addition to the env var, so the banner can be turned off without a
      deploy. Default on only when both id and slot are present.
- [ ] **Consent**: configure Google's own GDPR message in AdSense →
      Privacy & messaging for EEA/UK/CH rather than adding a CMP dependency.
      The ad script must not load before consent where consent is required.
- [x] **`app/ads.txt/route.ts`**: derived from the client id (strip `ca-`),
      cached; an empty 404 when unset. Same single-source pattern as robots
      and sitemap.
- [x] **`app/privacy/page.tsx`**: a short factual page — what Openmi stores,
      what Google collects for ads, how to change ad settings, how to delete
      an account. Required by AdSense and by basic honesty; this is not the
      deferred promotion page.
- [ ] **Review risk**: reviewers need public content. Today `/` is a sign-in
      screen, and AdSense does not approve a site whose root is a login. The
      public surface is `/about`, `/plus` and `/share/[id]`. Submit with those
      live; if the application is rejected for thin content, the smallest fix
      is a public product overview at `/` for signed-out visitors — a slice
      of the deferred promotion page, not the whole thing. Do that only if
      review demands it.
- [x] Tests: no ad without env or flag, one push per mount, reserved height
      constant, ads.txt content, and a source-contract test that the CSP
      contains no wildcard beyond the named AdSense hosts.

**Acceptance:** with id, slot and flag set, exactly one labelled banner renders
above the composer at its reserved size, the composer does not move when it
fills, clicking **Send** is nowhere near the ad, and removing the env id makes
the slot disappear without a gap. With no consent, no ad request is made in a
consent-required region.

**Not done in this pass, and why:** the AdSense account application, the GDPR
consent message and the review submission are dashboard and calendar tasks.
None of them blocks the code: the banner renders only when both public ids
exist, and `/privacy`, `/about` and the share pages are live for the review.

### Phase 2 order

Do 2a first, then 2b in the same layout: the ring occupies the composer
header, the banner sits above it. One visual pass, one set of screenshots,
one round of layout review.

Delivered: `lib/contextBudget.ts` (budget, thresholds, estimates),
`components/ContextRing.tsx` (SVG ring, popover, new-chat CTA at 90%), the
ring in the composer header hidden on Focus home, `GET /api/chat` serving
`contextBudget`, `components/AdBanner.tsx` with a reserved 50/60 px slot,
the CSP's named AdSense origins, `/ads.txt`, `/privacy`, and the `adsEnabled`
console kill switch (migration `20261025000100_ads_enabled.sql`).

---

## Phase 3 — Rate limits: complete, consistent, visible

**Goal:** a 429 reads as a queue position, and no expensive route is
unprotected.

What exists: `lib/serverControl.ts` has a per-uid (or per-IP) minute bucket,
backed by Upstash when configured and an in-process Map otherwise. Chat is
30/min, agent steps 20/min, commits 10/min; the client can already parse
"wait Ns" (`lib/rateLimit.ts`) and show a countdown. Gaps:

- `app/api/setup/route.ts`, `app/api/github/status/route.ts`,
  `app/api/admin/config/route.ts` and `app/api/admin/models/route.ts` call no
  limiter.
- Chat and agent refuse in different shapes (SSE `error` event vs JSON
  `{ error }`), so the client cannot always find the wait.
- No `Retry-After` or `X-RateLimit-*` headers.
- Limits are literals at eighteen call sites, so the policy cannot be
  reviewed as a policy.

- [x] One table of scopes and limits (`RATE_LIMITS`), imported everywhere.
- [x] Guard the four unguarded routes (admin: identity + tight burst; status
      and setup: cheap but public).
- [x] Return `Retry-After` plus `X-RateLimit-Limit/Remaining/Reset`; include
      `retryAfterSeconds` in every body, including the SSE one.
- [x] Distinguish **burst (429)**, **daily identity cap (403, resets at local
      midnight)** and **no Dew (402, top up)** in copy and code.
- [x] Client: one countdown source in `app/page.tsx` drives the composer hint
      and disables send; no toast stacked on the inline notice; clear early
      when the server says remaining > 0.
- [x] Keep the existing properties: an aborted request still spends one unit;
      a request that never reached a model spends no Dew.
- [x] Tests: fake clock for the local bucket, Redis-null fallback, per-uid
      isolation, header presence, parser against every server sentence.
- [x] State the deployment caveat where operators look: without Upstash the
      limit is per instance and resets on cold start (`.env.example` and the
      admin console, not only a code comment).

**Acceptance:** 31 messages in a minute returns 429 with `Retry-After`; the
composer counts down; a second tab sees the same budget; BYOK and platform
turns share the burst budget.

Delivered: `lib/rateLimitPolicy.ts` as the single table (20 scopes, imported by
every route — no literal ceilings remain), the four unguarded routes limited,
`Retry-After` plus `X-RateLimit-*` on refusals, one JSON refusal shape with
`retryAfterSeconds`, the SSE refusal carrying the same field, the composer
reading the field before the sentence and clearing a stale countdown on the
next success, and the per-instance caveat in `.env.example` and the console.
The fake-clock, per-uid, header and parser tests live in
`tests/rate-limit.test.ts`. The cross-tab half of the acceptance still needs
Upstash configured in the deployment; without it each instance counts alone,
which is the documented behaviour rather than a bug.

---

## Phase 4 — Bring your own key

**Goal:** a person can use Openmi with their own provider key, at no Dew
cost, without the deployment ever falling back to the owner's key.

**Locked:** free, same rate limits, no silent fallback.

**Status, 2026-10-28 — partly shipped.** Storage, validation and routing exist in
`app/api/keys`, `lib/providerKeys.ts` and the `provider_keys` table: each key is
checked with the vendor before it is saved, sealed with AES-256-GCM under the
GitHub token key, returned only as a four-character hint, and scoped to its
owner by row-level security. The chat and agent paths prefer an account's key.

Two parts of the locked decision are **not** implemented, and this file should
not imply otherwise:

- **Not free.** The hour check in `app/api/chat/route.ts` runs before provider
  selection and carries no BYOK exemption, so a turn on your own key still needs
  a live hour bought in Dew. The "free" rule is outstanding.
- **A silent fallback exists.** `getProviders()` uses the account key *or the
  deployment's*, so a revoked or broken account key quietly falls back to
  platform credit — the opposite of "never a hidden retry". A failed key should
  stop the turn and offer platform credit as a choice.
- The dedicated `BYOK_SECRET` from the plan was not added; keys reuse
  `GITHUB_TOKEN_KEY` through `lib/github/crypto.ts`.

Those are the remaining edits in this phase, not new scope.

- Providers at launch: **OpenRouter** and **Gemini**, matching the two modes.
- A stored key is used **instead of** platform credit. A failed key is an
  error with a "use Openmi credit instead" button, never a hidden retry.
- Storage: a `user_api_keys` table, ciphertext sealed with AES-256-GCM using
  a dedicated `BYOK_SECRET` (32-byte hex). Reuse `seal`/`open` from
  `lib/github/crypto.ts`. The app returns only provider, masked hint and
  verified time — never a key.

### 4a — Storage and API (4–5 d)

- [ ] Migration `supabase/migrations/<ts>_user_api_keys.sql`: one row per
      `(user_id, provider)`, `ciphertext`, `hint` (last four), `verified_at`,
      timestamps; RLS select/insert/update/delete for `auth.uid()` only.
- [ ] `lib/byok.ts` (server-only): validate, verify with a cheap provider
      call, seal, read, revoke; never log the value.
- [ ] `app/api/keys/route.ts`: GET presence list, POST verify + save, DELETE
      revoke. Same-origin, rate-limited (`keys` scope), 401/403/429 in the
      house style.
- [ ] `.env.example`, `lib/setupChecks.ts`, `/about` setup banner: list
      `BYOK_SECRET`. Unset means BYOK is unavailable and the UI says so
      instead of failing at save.
- [ ] Tests: seal round-trip, ciphertext at rest (row starts `v1.`, does not
      contain the key), cross-user 404, key never in a response, invalid key
      rejected with the provider's reason.

### 4b — Runtime routing (3–4 d)

- [ ] `lib/providers.ts` and the chat/agent routes resolve per request:
      caller's sealed key → decrypt → provider; platform env only when no
      BYOK key is selected. No module-scope cache keyed by uid.
- [ ] Charge path: skip `canAfford`/`deductDew`; record `byok: true` as
      telemetry, not a ledger row. `/activity` labels it so it does not look
      like a missing charge.
- [ ] Search stays platform-funded and free; state that so the bill is not a
      surprise.
- [ ] Agent steps use the same resolution; a Code key cannot serve an Auto
      turn.
- [ ] Tests: BYOK turn charges 0, platform turn charges normal, invalid key
      does not fall back, admin exemption unaffected.

### 4c — UI, onboarding, errors (3–4 d)

- [ ] `SettingsPanel.tsx`: "Your API keys" — provider, masked hint, verified
      date, Replace, Remove, link to where the key is created. Copy states:
      encrypted at rest, used only for your requests, never shown again.
- [ ] Out-of-Dew state and `/plus` name the option.
- [ ] Error mapping: 401/403 → "your key was rejected", 429 → "your key is
      rate-limited", network → "could not reach the provider". Never a vague
      "Openmi is having trouble" when the key is the problem.
- [ ] Tests + a two-account manual pass: A's key is invisible to B; removing
      a key restores platform billing immediately.

**Acceptance:** with a valid personal key, chat and agent turns succeed and
Dew is unchanged; with a revoked key, the turn fails with a key-specific
message and no platform fallback; the database holds only ciphertext.

**Risk:** key exfiltration is the whole risk. Dedicated secret, sealed at
rest, no logging, presence-only API, RLS, revoke deletes the row. If
`BYOK_SECRET` is lost, keys must be re-entered — say so in the copy.

---

## Deferred — Public promotion page (item 9)

Owner's instruction: forget this for now. Kept here so the work is not lost.

When it returns: a public page explaining the three-step loop, Dew pricing,
BYOK and the approval rule; metadata, OG image, `/privacy` and `/terms`
linked; sitemap/robots updated. It is also the cleanest answer to AdSense
"thin content" review and to the stale `/about` progress list. Until then,
the only slice worth building is the minimum public explanation if AdSense
rejects the root.

---

## Risks and dependencies

| Risk | Where it bites | Mitigation |
|---|---|---|
| AdSense rejects a root that is a sign-in screen | Phase 2b go-live | Submit with `/about`, `/plus`, share pages live; add a minimal public `/` overview only if demanded. |
| CSP blocks AdSense and the failure looks like "no ad" | Phase 2b | Add named origins, verify in console; never widen to `*`. |
| Ad pushes the composer / causes CLS | Phase 2b | Reserved height, `overflow-hidden`, no refresh, hide cleanly when unset. |
| Agent diagnosis finds the commit path broken | Phase 1 | Fix the blocker instead of the affordance work; keep the approval gate. |
| BYOK key leak | Phase 4 | Dedicated secret, sealed at rest, no logs, presence-only API, revoke. |
| Upstash absent in production | Phase 3 | Per-instance limiter is a speed bump; document it where operators look. |
| Owner's timezone / account | Phase 4 | BYOK is per-user; no shared secret per deployment beyond `BYOK_SECRET`. |

## Cross-cutting rules for every phase

- No provider model id, API key name or vendor name reaches the browser
  (`lib/models.ts` is the only client catalog).
- No service-role key for BYOK, ads or the admin console; all use the caller's JWT
  and RLS. The one exception is the run routes (`lib/supabaseAdmin.ts`), which
  create and advance a turn with no caller attached.
- Every new route is same-origin checked, identity-gated where it touches
  user data, and rate-limited.
- The exception is the run chain: `POST /api/agent/tick` and
  `POST /api/agent/runs/sweep` are called by the server and by a scheduler, so
  they have no browser origin to check and no user to key a bucket on. The tick
  is authorised by a signed claim naming one run, owner and attempt; the sweep by
  a shared secret. `GET /api/agent/runs/[id]` is RLS-gated but not rate-limited,
  because polling is how a chat renders a run it is already allowed to read. See
  `docs/AGENT_TOOLS_AND_RESUME.md` → "Deliberate exceptions".
- Every phase ends with `bun run typecheck`, `bun run test`, `bun run lint`,
  and one manual pass on the path the phase changes.

## Progress log

| Date | Change |
|---|---|
| 2026-10-25 | Plan created; item 2 verified as shipped in `e68ff7f`. |
| 2026-10-25 | Owner decisions locked: AdSense above composer, BYOK free, promotion page deferred. Phase order revised; tracker added; agent read-vs-write answer recorded. |
| 2026-10-25 | Phase 0 code items done: model-notice regression test, `/notes` sitemap fix, `docs/AGENT_CAPABILITIES.md`. Typecheck and tests pass. |
| 2026-10-25 | Phase 1 delivered: “reads · proposes” chip, **Propose this change**, proposal refusal reasons in the thread, honest new-request disclosure, `/about` copy fixed. New source-contract tests pass; live repro still pending. |
| 2026-10-25 | Verified: `bun run typecheck`, full `bun run test`, `bun run lint` (0 errors, 6 pre-existing warnings), `bun run build`, and dev-server HTTP checks for `/`, `/about` and `/sitemap.xml`. Five pre-existing `no-explicit-any` errors in `lib/preferences.ts` blocked the build; fixed without behaviour change. |
| 2026-10-25 | Phase 2 delivered: context ring with popover and 70/90 thresholds, `contextBudget` from `GET /api/chat`, AdSense banner with reserved height, named CSP origins, `/ads.txt`, `/privacy`, `adsEnabled` kill switch. `tests/context-ring.test.ts` (20) and `tests/ads.test.ts` (15) pass. |
| 2026-10-25 | Phase 3 delivered: one `RATE_LIMITS` table, four routes guarded, uniform 429 body and headers, SSE refusal field, composer countdown source. `tests/rate-limit.test.ts` (17) passes; the parser now reads “Try again in Ns”, which the old one missed. Typecheck, full suite (21 scripts), lint (0 errors) and build are green; 429 verified live against `/api/setup`. |
| 2026-10-28 | `/privacy` rewritten from the code: subprocessors, retention windows and administrator access added; linked from sign-in, Settings and About. Claims that were not true were corrected rather than kept — the EEA/UK consent message is still unconfigured, so the page says so. Also corrected this file (Phase 4 was marked Planned while most of it shipped) and `OVERHAUL_SPEC.md` §4–§6 (per-request pricing, Firebase identity, and a module table naming files that no longer exist). |

// ── A repository run, stored so it can outlive its tab ───────────────────────
//
// The agent's step loop used to live in the browser: the page asked for one step
// at a time and carried the transcript and signed turn token back with each
// request. That is a good design for a chat and a bad one for a task — closing
// the tab ended the work.
//
// A run moves the loop's state into `agent_runs` and lets the server drive it.
// This module is the only place that state is read or written, and it is split
// in two on purpose:
//
//   - `readOwnRun` uses the **caller's** token, so a browser can watch its own
//     run and nothing else. RLS is the judge, exactly as everywhere else.
//   - Everything else uses the **service-role** client from `supabaseAdmin`,
//     because a tick has no caller. The migration grants the browser SELECT and
//     nothing more: a client must not be able to create, rewind or finish a run.
//
// The claim is the piece that matters. A tick arrives with an attempt number,
// and `claimRun` advances the row only if that number is still current. Two
// ticks racing on one run means one claim wins and the other does nothing — the
// cheap version of this feature is a run that spends its budget twice.

import { seal, tokenKey, unseal } from "./github/crypto";
import { clientForToken } from "./supabase";
import { supabaseAdmin } from "./supabaseAdmin";
import type { AgentStep, ProposalReview } from "./types";

export type AgentRunStatus = "running" | "done" | "failed" | "cancelled";

/** The working state the next tick needs. Sealed into `agent_runs.state`. */
export interface AgentRunState {
  v: 1;
  uid: string;
  project: { id: string; repoFullName: string; defaultBranch: string; baseSha: string };
  /** The caller's GitHub token. Used by the tick, never by the browser again. */
  githubToken: string;
  /** The account's own provider keys, opened at creation and sealed again here. */
  accountKeys: Record<string, string>;
  /** The conversation the run answers in. Narrowed to the two roles the agent reads. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: unknown[];
  turnToken?: string;
  /** Text the person attached to this turn. */
  context: string;
  content: string;
  steps: AgentStep[];
  /** The attempt this state belongs to; a tick must present the same number. */
  attempt: number;
}

/** What the chat renders. No credentials, no transcript. */
export interface AgentRunView {
  id: string;
  status: AgentRunStatus;
  content: string;
  steps: AgentStep[];
  changesetId: string | null;
  review: ProposalReview | null;
  truncated: boolean;
  error: string | null;
  usage: { prompt: number; completion: number };
  createdAt: number;
}

/** A run as the tick sees it: view plus the sealed state and claim fields. */
export interface AgentRunRecord extends AgentRunView {
  owner: string;
  projectId: string;
  repoFullName: string;
  proposals: unknown[];
  state: string;
  attempts: number;
}

function ms(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stepsOf(value: unknown): AgentStep[] {
  return Array.isArray(value) ? (value as AgentStep[]) : [];
}

/** One stored row, in the shape the routes use. */
export function normalizeRun(raw: unknown): AgentRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  const owner = str(row.owner);
  if (!id || !owner) return null;
  const status = row.status;
  return {
    id,
    owner,
    projectId: str(row.project_id),
    repoFullName: str(row.repo_full_name),
    status:
      status === "done" || status === "failed" || status === "cancelled" ? status : "running",
    content: str(row.content),
    steps: stepsOf(row.steps),
    proposals: Array.isArray(row.proposals) ? row.proposals : [],
    changesetId: typeof row.changeset_id === "string" ? row.changeset_id : null,
    review: (row.review ?? null) as ProposalReview | null,
    truncated: row.truncated === true,
    error: typeof row.error === "string" && row.error ? row.error : null,
    usage: { prompt: num(row.prompt_tokens), completion: num(row.completion_tokens) },
    state: str(row.state),
    attempts: num(row.attempts),
    createdAt: ms(row.created_at),
  };
}

/** The public projection, so a route cannot accidentally return the state. */
export function toView(run: AgentRunRecord): AgentRunView {
  return {
    id: run.id,
    status: run.status,
    content: run.content,
    steps: run.steps,
    changesetId: run.changesetId,
    review: run.review,
    truncated: run.truncated,
    error: run.error,
    usage: run.usage,
    createdAt: run.createdAt,
  };
}

// ── Sealed state ─────────────────────────────────────────────────────────────

/**
 * Seals the run's working state.
 *
 * Null means this deployment has no `GITHUB_TOKEN_KEY`, and therefore cannot
 * keep a credential anywhere — which is the same condition that already stops
 * GitHub from being connected at all, so the caller turns it into the existing
 * setup message rather than a new one.
 */
export function sealRunState(state: AgentRunState): string | null {
  const key = tokenKey();
  if (!key) return null;
  return seal(JSON.stringify(state), key);
}

export function openRunState(sealed: string): AgentRunState | null {
  const key = tokenKey();
  if (!key || !sealed) return null;
  const plaintext = unseal(sealed, key);
  if (!plaintext) return null;
  try {
    const parsed = JSON.parse(plaintext) as AgentRunState;
    if (!parsed || parsed.v !== 1 || typeof parsed.uid !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Creating and reading ─────────────────────────────────────────────────────

export interface CreateRunInput {
  id: string;
  owner: string;
  projectId: string;
  repoFullName: string;
  state: AgentRunState;
}

/** Inserts a new run. False means the deployment or the database refused. */
export async function createRun(input: CreateRunInput): Promise<boolean> {
  const admin = supabaseAdmin();
  if (!admin) return false;
  const sealed = sealRunState(input.state);
  if (!sealed) return false;
  try {
    const { error } = await admin.from("agent_runs").insert({
      owner: input.owner,
      id: input.id,
      project_id: input.projectId,
      repo_full_name: input.repoFullName,
      status: "running",
      state: sealed,
      attempts: 0,
      heartbeat_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * One run, read with the caller's own token.
 *
 * This is the only read in the module that does not need the service key, and it
 * is the one the chat uses: RLS answers "is this yours?" without the route
 * having to trust the id it was handed.
 */
export async function readOwnRun(
  authorization: string | null,
  uid: string,
  id: string
): Promise<AgentRunView | null> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = token ? clientForToken(token) : null;
  if (!client || !uid || !id) return null;
  try {
    const { data, error } = await client
      .from("agent_runs")
      .select(
        "id, owner, project_id, repo_full_name, status, content, steps, proposals, changeset_id, review, truncated, prompt_tokens, completion_tokens, error, state, attempts, created_at"
      )
      .eq("owner", uid)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    const run = normalizeRun(data);
    return run ? toView(run) : null;
  } catch {
    return null;
  }
}

/** A run the tick is about to advance. Service role: it has no caller. */
export async function readRun(id: string): Promise<AgentRunRecord | null> {
  const admin = supabaseAdmin();
  if (!admin || !id) return null;
  try {
    const { data, error } = await admin.from("agent_runs").select("*").eq("id", id).maybeSingle();
    if (error || !data) return null;
    return normalizeRun(data);
  } catch {
    return null;
  }
}

/**
 * The live run for this account and repository, if there is one.
 *
 * Kept for the reconnect path: opening the chat after a reload should attach to
 * the turn that is already going rather than start a second one.
 */
export async function activeRunFor(
  authorization: string | null,
  uid: string,
  projectId: string
): Promise<AgentRunView | null> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = token ? clientForToken(token) : null;
  if (!client || !uid || !projectId) return null;
  try {
    const { data, error } = await client
      .from("agent_runs")
      .select(
        "id, owner, project_id, repo_full_name, status, content, steps, proposals, changeset_id, review, truncated, prompt_tokens, completion_tokens, error, state, attempts, created_at"
      )
      .eq("owner", uid)
      .eq("project_id", projectId)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const run = normalizeRun(data);
    return run ? toView(run) : null;
  } catch {
    return null;
  }
}

// ── Advancing ────────────────────────────────────────────────────────────────

/**
 * Takes ownership of the next step, or refuses.
 *
 * The update only matches when `attempts` is still the number the caller holds,
 * so a duplicate tick — a retried fetch, a chain that fired twice — finds nothing
 * to update and returns false without spending a model call. This is the whole
 * concurrency story, and it is one conditional write.
 */
export async function claimRun(id: string, owner: string, attempt: number, now = Date.now()): Promise<boolean> {
  const admin = supabaseAdmin();
  if (!admin) return false;
  try {
    const { data, error } = await admin
      .from("agent_runs")
      .update({ attempts: attempt + 1, heartbeat_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() })
      .eq("id", id)
      .eq("owner", owner)
      .eq("status", "running")
      .eq("attempts", attempt)
      .select("id");
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

export interface SaveProgressInput {
  id: string;
  state: AgentRunState;
  content: string;
  steps: AgentStep[];
  usage: { prompt: number; completion: number };
}

/** Writes what a step produced, and re-seals the state the next one needs. */
export async function saveProgress(input: SaveProgressInput): Promise<boolean> {
  const admin = supabaseAdmin();
  if (!admin) return false;
  const sealed = sealRunState(input.state);
  if (!sealed) return false;
  try {
    const { error } = await admin
      .from("agent_runs")
      .update({
        state: sealed,
        content: input.content,
        steps: input.steps,
        prompt_tokens: input.usage.prompt,
        completion_tokens: input.usage.completion,
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.id)
      .eq("owner", input.state.uid);
    return !error;
  } catch {
    return false;
  }
}

export interface FinishRunInput {
  id: string;
  owner: string;
  status: Exclude<AgentRunStatus, "running">;
  content: string;
  steps: AgentStep[];
  proposals: unknown[];
  changesetId: string | null;
  review: ProposalReview | null;
  truncated: boolean;
  error: string | null;
  usage: { prompt: number; completion: number };
}

/** Closes a run. The state is dropped: nothing may resume it afterwards. */
export async function finishRun(input: FinishRunInput): Promise<boolean> {
  const admin = supabaseAdmin();
  if (!admin) return false;
  try {
    const { error } = await admin
      .from("agent_runs")
      .update({
        status: input.status,
        content: input.content,
        steps: input.steps,
        proposals: input.proposals,
        changeset_id: input.changesetId,
        review: input.review,
        truncated: input.truncated,
        error: input.error,
        prompt_tokens: input.usage.prompt,
        completion_tokens: input.usage.completion,
        state: "",
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.id)
      .eq("owner", input.owner);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Runs whose chain stopped beating.
 *
 * A chain link is a fire-and-forget fetch: if the process that fired it died, or
 * the request never arrived, the run sits at `running` for ever. The sweep turns
 * that into a retry instead of a mystery.
 */
export async function listStaleRuns(staleAfterMs: number, limit = 5): Promise<AgentRunRecord[]> {
  const admin = supabaseAdmin();
  if (!admin) return [];
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  try {
    const { data, error } = await admin
      .from("agent_runs")
      .select("*")
      .eq("status", "running")
      .lt("heartbeat_at", cutoff)
      .order("heartbeat_at", { ascending: true })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return data.map(normalizeRun).filter((run): run is AgentRunRecord => run !== null);
  } catch {
    return [];
  }
}

/** How long a live tick may be silent before the sweep calls it dead. */
export const RUN_STALE_MS = 90_000;
/** The most a run may be resumed after a dropped chain before it is failed. */
export const RUN_MAX_ATTEMPTS = 40;

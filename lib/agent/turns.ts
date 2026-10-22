// ── A turn, signed ───────────────────────────────────────────────────────────
//
// The step endpoint is stateless: the client sends the conversation and the
// tool transcript back with each request. That is fine for the content, and
// dangerous for the budget — "how many steps have I used" and "have I paid for
// this turn" are exactly the two numbers a client must not be able to choose.
//
// So they travel in an HMAC-signed blob. The client can read it and send it
// back; it cannot alter a step count, raise the cap, or extend an expired turn
// without the server's key. No database row is needed, which keeps the whole
// loop working on a deployment that only has rules-based storage.

import { MAX_FILE_BYTES } from "@/lib/github/tree";
import { sign, turnKey, verify } from "@/lib/github/crypto";

/** How many model calls one paid turn may take. */
export const MAX_STEPS = 8;
/** Tokens (in + out) one turn may spend before it is forced to stop. */
export const MAX_TURN_TOKENS = 60_000;
/** A turn that is abandoned cannot be resumed indefinitely. */
export const TURN_TTL_MS = 30 * 60_000;

export interface TurnState {
  v: 1;
  uid: string;
  projectId: string;
  repoFullName: string;
  baseSha: string;
  /** Model calls completed so far. */
  steps: number;
  prompt: number;
  completion: number;
  /** Written by the server once the flat charge has landed. */
  charged: true;
  /** The tools this turn may call. Phase 1 is read-only by construction. */
  tools: "read-only";
  issuedAt: number;
  exp: number;
}

export interface TurnUsage {
  prompt: number;
  completion: number;
}

export function createTurn(input: {
  uid: string;
  projectId: string;
  repoFullName: string;
  baseSha: string;
  usage: TurnUsage;
  now?: number;
}): { token: string; state: TurnState } {
  const now = input.now ?? Date.now();
  const state: TurnState = {
    v: 1,
    uid: input.uid,
    projectId: input.projectId,
    repoFullName: input.repoFullName,
    baseSha: input.baseSha,
    steps: 1,
    prompt: Math.max(0, input.usage.prompt),
    completion: Math.max(0, input.usage.completion),
    charged: true,
    tools: "read-only",
    issuedAt: now,
    exp: now + TURN_TTL_MS,
  };
  return { token: sign(state, turnKey()), state };
}

/**
 * Verifies a turn token against the caller and the project it claims.
 *
 * Every mismatch is a null: a token from another user, another project, an
 * expired one, or one whose signature does not check out. The caller's route
 * treats null as "start a new turn", which is correct — a new turn is paid for
 * again.
 */
export function readTurn(
  token: string | undefined,
  expected: { uid: string; projectId: string; now?: number }
): TurnState | null {
  if (!token) return null;
  const state = verify<TurnState>(token, turnKey());
  if (!state || state.v !== 1) return null;
  const now = expected.now ?? Date.now();
  if (typeof state.exp !== "number" || state.exp <= now) return null;
  if (state.uid !== expected.uid) return null;
  if (state.projectId !== expected.projectId) return null;
  if (state.tools !== "read-only") return null;
  if (!Number.isFinite(state.steps) || state.steps < 0 || state.steps > MAX_STEPS) return null;
  return state;
}

/** Adds one step and its usage, without ever exceeding the caps in the blob. */
export function advanceTurn(state: TurnState, usage: TurnUsage, now = Date.now()): TurnState {
  return {
    ...state,
    steps: Math.min(MAX_STEPS, state.steps + 1),
    prompt: Math.max(0, state.prompt + Math.max(0, usage.prompt)),
    completion: Math.max(0, state.completion + Math.max(0, usage.completion)),
    exp: Math.min(state.exp, now + TURN_TTL_MS),
  };
}

/** True when this turn has used its step or token budget. */
export function turnExhausted(state: TurnState): boolean {
  return state.steps >= MAX_STEPS || state.prompt + state.completion >= MAX_TURN_TOKENS;
}

/** A turn that still has room, with its token re-signed. */
export function signTurn(state: TurnState): string {
  return sign(state, turnKey());
}

/** The file-size ceiling is shared with the tree filter so the two cannot drift. */
export const TURN_FILE_BYTES = MAX_FILE_BYTES;

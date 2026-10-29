// ── The token a run ticks with ───────────────────────────────────────────────
//
// A tick has no caller: that is the feature. So it cannot be authorised by the
// person's session — it is authorised by the server that minted the run, and the
// proof is an HMAC over exactly what the tick is allowed to do:
//
//   { run, uid, attempt, exp }
//
// `attempt` is in the payload rather than only in the database because it is the
// replay guard. A token can be replayed — a retried fetch, a duplicated chain
// link — and the claim in `lib/agentRuns.ts` only succeeds when the attempt is
// still current, so a replay finds nothing to claim and spends nothing.
//
// The lifetime is short because a tick is minutes of work, not a session. An
// expired token means the chain stopped: the watchdog picks the run up again,
// which is why the expiry is a recovery, not a loss.

import { sign, turnKey, verify } from "./github/crypto";

/** A tick must arrive inside this window; the sweep is what recovers a late one. */
export const TICK_TTL_MS = 5 * 60_000;

export interface TickClaim {
  /** The run to advance. */
  run: string;
  /** The account that owns it. Bind the two: a token for one run must not tick another. */
  uid: string;
  /** The attempt number this tick is allowed to claim. */
  attempt: number;
  exp: number;
}

export function signTick(input: { run: string; uid: string; attempt: number }, now = Date.now()): string {
  return sign<TickClaim>({ ...input, exp: now + TICK_TTL_MS }, turnKey());
}

/**
 * Fires one tick at our own origin.
 *
 * Never awaited by its caller: the request that fired it is finished, and the
 * tick has its own budget. A failure here is deliberately silent — the run's
 * heartbeat simply stops, and the watchdog is what turns that into a retry.
 */
export function dispatchTick(origin: string, token: string): Promise<unknown> {
  return fetch(`${origin}/api/agent/tick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
  }).catch(() => undefined);
}

/** Null for a forged, truncated, expired or foreign token — never a partial claim. */
export function verifyTick(token: string, now = Date.now()): TickClaim | null {
  const claim = verify<TickClaim>(token, turnKey());
  if (!claim) return null;
  if (typeof claim.run !== "string" || !claim.run) return null;
  if (typeof claim.uid !== "string" || !claim.uid) return null;
  if (typeof claim.attempt !== "number" || claim.attempt < 0) return null;
  if (typeof claim.exp !== "number" || claim.exp <= now) return null;
  return claim;
}

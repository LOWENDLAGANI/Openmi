import { isBanActive, normalizeConfig, DEFAULT_CONFIG, type AppConfig, type BanRecord } from "./appConfig";
import { clientForToken, publicClient, supabaseConfigured } from "./supabase";

// Server-side enforcement of the administrator's controls.

const adminEmail = process.env.OPENMI_ADMIN_EMAIL?.trim().toLowerCase() ?? "";

/** True when the deployment has a Supabase project configured. */
export const serverControlsConfigured = supabaseConfigured;

/** Result of authenticating a caller, resolved from the token itself. */
export interface CallerIdentity {
  uid: string;
  /** The address on the account. Empty only if a provider withheld it. */
  email: string;
}

let cached: { config: AppConfig; at: number } | null = null;
const CACHE_MS = 5000;

/**
 * Reads the administrator's settings from the database.
 *
 * Cached for a few seconds so a busy chat does not issue one database read per
 * keystroke-sized request. A failure returns the permissive defaults: if the
 * database is unreachable the app must keep answering rather than locking
 * everybody out, and a control that cannot be read cannot be enforced anyway.
 */
export async function readConfig(): Promise<AppConfig> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.config;

  const client = publicClient();
  if (!client) return DEFAULT_CONFIG;

  try {
    const { data, error } = await client
      .from("app_config")
      .select(
        "chat_enabled, search_enabled, announcement, daily_chat_cap, bans, maintenance_enabled, maintenance_message, updated_at"
      )
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return DEFAULT_CONFIG;
    const config = normalizeConfig(configRowToStored(data));
    cached = { config, at: Date.now() };
    return config;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** The column names, as the config normaliser expects them. */
function configRowToStored(row: Record<string, unknown>) {
  return {
    chatEnabled: row.chat_enabled,
    searchEnabled: row.search_enabled,
    announcement: row.announcement,
    dailyChatCap: row.daily_chat_cap,
    bans: row.bans,
    maintenanceEnabled: row.maintenance_enabled,
    maintenanceMessage: row.maintenance_message,
    updatedAt:
      typeof row.updated_at === "string" ? new Date(row.updated_at).getTime() : row.updated_at,
  };
}

/** The stored columns for a normalised config. */
export function storedConfigFrom(config: AppConfig) {
  return {
    chat_enabled: config.chatEnabled,
    search_enabled: config.searchEnabled,
    announcement: config.announcement,
    daily_chat_cap: config.dailyChatCap,
    bans: config.bans,
    maintenance_enabled: config.maintenanceEnabled,
    maintenance_message: config.maintenanceMessage,
    updated_at: new Date(config.updatedAt || Date.now()).toISOString(),
  };
}

/** Drops the cache so an admin's change takes effect on the very next request. */
export function invalidateConfig(): void {
  cached = null;
}

/** Writes the controls with the caller's own token. RLS decides if they may. */
export async function writeAppConfig(
  authorization: string | null,
  config: AppConfig
): Promise<boolean> {
  const token = bearerToken(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client) return false;
  try {
    // `.select()` is not decoration: PostgreSQL filters a refused UPDATE rather
    // than raising, so without reading the row back an administrator's write
    // could be refused and still be reported as saved. The row comes back empty
    // when the policies said no.
    const { data, error } = await client
      .from("app_config")
      .upsert({ id: 1, ...storedConfigFrom(config) }, { onConflict: "id" })
      .select("id");
    if (error) return false;
    return Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

function bearerToken(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

/**
 * Verified identities, keyed by a hash of the token.
 *
 * Without this every request pays for a round trip to the auth server before it
 * can do anything at all — a chat message waits on an identity lookup it does not
 * need, because the same token arrives with the next message a second later.
 * Five minutes is the ceiling: long enough to remove the latency, short enough
 * that a revoked or newly-signed-in token is forgotten almost immediately. The
 * token itself is never stored as a key, only its hash, so a memory dump of this
 * process does not hand out usable credentials.
 */
const verified = new Map<string, { identity: CallerIdentity; at: number }>();
const VERIFY_CACHE_MS = 5 * 60_000;
const VERIFY_CACHE_MAX = 2000;

/** A short, non-reversible key for a token. Not a secret — just not the token. */
async function tokenKey(token: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // A runtime with no Web Crypto (some test harnesses) still has to work;
    // the token is only held for the duration of this process either way.
    return token;
  }
}

/** Verifies a caller's Supabase access token and returns who it belongs to. */
export async function verifyCaller(authorization: string | null): Promise<CallerIdentity | null> {
  const token = bearerToken(authorization);
  if (!token) return fail("no-token");
  if (!supabaseConfigured) return fail("no-project");

  // A repeat of a token seen in the last few minutes is answered locally. This
  // is the common case — one token covers a whole session — so it is checked
  // before any network call is made.
  const key = await tokenKey(token);
  const remembered = verified.get(key);
  if (remembered && Date.now() - remembered.at < VERIFY_CACHE_MS) {
    return remembered.identity;
  }

  const client = clientForToken(token);
  if (!client) return fail("no-client");

  let user;
  try {
    const { data, error } = await client.auth.getUser(token);
    if (error) return fail(`lookup-failed: ${error.message}`);
    user = data.user;
  } catch (error) {
    return fail("lookup-threw", error);
  }
  if (!user?.id) return fail("lookup-returned-no-user");

  // An address is not guaranteed: a provider that withholds it leaves the
  // account without one. The uid is what the ban list and the daily caps act on,
  // so those keep working; only the administrator check needs an address.
  const identity: CallerIdentity = {
    uid: user.id,
    email: typeof user.email === "string" ? user.email.toLowerCase() : "",
  };

  // Only a verified identity is cached. A failure is not, because the next
  // request with the same token deserves its own look — and because caching a
  // refusal would mean a token that becomes valid mid-session stays refused.
  if (verified.size >= VERIFY_CACHE_MAX) {
    const cutoff = Date.now() - VERIFY_CACHE_MS;
    for (const [entryKey, entry] of verified) {
      if (entry.at < cutoff) verified.delete(entryKey);
    }
    if (verified.size >= VERIFY_CACHE_MAX) {
      const oldest = verified.keys().next().value;
      if (oldest !== undefined) verified.delete(oldest);
    }
  }
  verified.set(key, { identity, at: Date.now() });
  return identity;
}

/**
 * Records why an identity could not be established.
 *
 * Without this the only symptom is a generic 401, which is indistinguishable
 * from a genuine permission failure. The token itself is never logged.
 */
function fail(reason: string, detail?: unknown): null {
  console.warn(`[openmi control] caller not identified: ${reason}`, detail ?? "");
  return null;
}

/**
 * True when a mutating request did not come from another site.
 *
 * Auth here is a Bearer token that the app's own code attaches, so a cross-site
 * form post cannot authenticate in the first place. This is the second lock,
 * and it is the one that still holds the day a route accepts a cookie.
 *
 * A request with no `Origin` header is allowed — server-to-server calls, curl
 * and older clients send none — because the job is to reject a *stated* foreign
 * origin, not to require a header. `Origin: null` (a sandboxed frame or a
 * `file://` page) is rejected: it is a browser telling us it cannot name itself.
 */
export function isSameOriginRequest(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;

  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const siteHost = (() => {
    const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    if (!configured) return null;
    try {
      return new URL(configured).host.toLowerCase();
    } catch {
      return null;
    }
  })();

  const candidates = [headers.get("x-forwarded-host"), headers.get("host"), siteHost]
    .filter((value): value is string => Boolean(value))
    // A proxy chain lists hosts left to right; the first is the one the browser
    // asked for.
    .map((value) => value.split(",")[0]!.trim().toLowerCase());

  return candidates.some((candidate) => candidate === host);
}

/** Whether a verified caller carries the administrator's address. */
export function isAdmin(identity: CallerIdentity | null): boolean {
  return Boolean(identity && adminEmail && identity.email === adminEmail);
}

export type AdminCheck = { allowed: true; identity: CallerIdentity } | { allowed: false; status: number; error: string };

/**
 * The one administrator gate, shared by every admin-only route.
 *
 * Each failure is answered with its own status and its own words, because the
 * console acts on them: a 401 means "sign in again", a 403 means "wrong
 * account", and a 503 means "this deployment has no administrator configured at
 * all" — three problems with three different fixes, which a single generic
 * refusal would flatten into one.
 *
 * This is not what enforces administrator access. The policies in
 * `supabase/migrations` compare the caller's verified address against
 * `app_admin.email`, so a request that got past this function and failed that
 * comparison is still refused by Postgres. This gate exists so the console can
 * say *why* in words a person can act on.
 */
export async function requireAdmin(headers: Headers): Promise<AdminCheck> {
  if (!adminEmail) {
    return {
      allowed: false,
      status: 503,
      error:
        "Set `OPENMI_ADMIN_EMAIL` in the deployment environment to match the address seeded in `app_admin`.",
    };
  }

  const identity = await verifyCaller(headers.get("authorization"));
  if (!identity) {
    return {
      allowed: false,
      status: 401,
      error: "Your session could not be verified. Close the console, sign in again, and retry.",
    };
  }
  if (!isAdmin(identity)) {
    return {
      allowed: false,
      status: 403,
      error: identity.email
        ? "This account is not the Openmi administrator."
        : "This account has no verified email address, so it cannot be the administrator. Sign in with the address in app_admin.",
    };
  }
  return { allowed: true, identity };
}

/**
 * Rate limiting, with a shared store when one is configured.
 *
 * This exists because the identity controls above can be switched off: with no
 * ban list and no cap configured, anyone can post to the routes and spend the
 * deployment's provider quota. Per-device caps are the wrong tool for that,
 * since the attacker controls the device, so there needs to be a backstop that
 * does not depend on anything they send.
 *
 * Two backends, chosen once at startup from the environment:
 *
 *   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set → a shared Redis
 *     counter, so the limit holds across cold starts and across every instance
 *     serving the deployment. This is the one that actually means "per minute".
 *   - neither set → an in-process Map, which is per instance and resets on cold
 *     start. It is a speed bump against a casual flood, not a defence against a
 *     determined one, and the code says so rather than pretending otherwise.
 */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
/** Whether requests go to a shared store rather than this process alone. */
export const sharedRateLimit = Boolean(redisUrl && redisToken);

const buckets = new Map<string, { count: number; resetAt: number }>();
const BUCKET_WINDOW_MS = 60_000;

export interface RateLimit {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Reads the client address from the headers a proxy sets. */
function clientKey(req: { headers: Headers }, identity: CallerIdentity | null): string {
  if (identity) return `uid:${identity.uid}`;
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const address = forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
  return `ip:${address}`;
}

/** One increment against the shared counter, or null when the store could not be reached. */
async function redisIncrement(key: string): Promise<{ count: number; ttlMs: number } | null> {
  try {
    const response = await fetch(`${redisUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([["INCR", key], ["PTTL", key]]),
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Array<{ result?: number | string }>;
    const count = Number(payload?.[0]?.result);
    let ttlMs = Number(payload?.[1]?.result);
    if (!Number.isFinite(count)) return null;
    // A fresh key reports -2 from PTTL before its first expire is set. The
    // pipeline cannot branch, so the expire is issued here.
    if (ttlMs < 0) {
      ttlMs = BUCKET_WINDOW_MS;
      void fetch(`${redisUrl}/pexpire/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redisToken}` },
        body: String(BUCKET_WINDOW_MS),
        cache: "no-store",
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
    }
    return { count, ttlMs };
  } catch {
    return null;
  }
}

/** The in-process bucket, used on its own or when the shared store is quiet. */
function localIncrement(key: string, now: number): { count: number; ttlMs: number } {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + BUCKET_WINDOW_MS });
    if (buckets.size > 5000) {
      for (const [entryKey, entry] of buckets) {
        if (entry.resetAt <= now) buckets.delete(entryKey);
      }
    }
    return { count: 1, ttlMs: BUCKET_WINDOW_MS };
  }
  bucket.count += 1;
  return { count: bucket.count, ttlMs: bucket.resetAt - now };
}

export async function checkRateLimit(
  req: { headers: Headers },
  identity: CallerIdentity | null,
  max: number,
  /**
   * Which budget this request spends.
   *
   * Chat and memory suggestions share a client but not a purpose, so they get
   * separate buckets. Sharing one would mean every suggestion request silently
   * costs a message of the user's allowance.
   */
  scope = "chat"
): Promise<RateLimit> {
  const now = Date.now();
  const key = `openmi:rl:${clientKey(req, identity)}:${scope}`;
  const shared = sharedRateLimit ? await redisIncrement(key) : null;
  const { count, ttlMs } = shared ?? localIncrement(key, now);
  if (count > max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }
  return { allowed: true, remaining: max - count, retryAfterSeconds: 0 };
}

/** The bans still in force at `now`. Expired ones lift by themselves. */
export function activeBans(config: AppConfig, now = Date.now()): BanRecord[] {
  return config.bans.filter((ban) => isBanActive(ban, now));
}

/** Whether the administrator has configured anything that needs an identity. */
export function identityControlsActive(config: AppConfig, cap: number, now = Date.now()): boolean {
  return activeBans(config, now).length > 0 || cap > 0;
}

/** Today's date as `2026-03-12`, in UTC, for the refusal a visitor reads. */
function formatBanDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The one sentence a banned visitor receives.
 *
 * It carries the reason and the end date when they exist, because a refusal
 * nobody can interpret is how a mistaken ban turns into a support problem. Both
 * are the administrator's own words, verbatim — nothing is invented here.
 */
export function banMessage(ban: BanRecord): string {
  const until = ban.expiresAt !== null ? ` until ${formatBanDate(ban.expiresAt)}` : "";
  const base = ban.expiresAt !== null
    ? `This device is blocked from Openmi${until}.`
    : "This device is not allowed to use Openmi.";
  const reason = ban.reason.trim().replace(/\.+$/, "");
  if (!reason) return base;
  return `${base} Reason: ${reason}. If you believe this is a mistake, contact the administrator.`;
}

/**
 * Decides whether a caller may spend quota.
 *
 * The important case is an *unidentified* one. Every identity-dependent check
 * below is written as `if (identity && ...)`, which means a caller who simply
 * omits the Authorization header has no identity, skips every check, and is
 * waved through — turning the ban list and the daily caps into decoration
 * removable with a single header. So once the administrator has configured
 * either one, a caller that cannot be identified is refused instead.
 */
export function identityGate(
  identity: CallerIdentity | null,
  config: AppConfig,
  cap: number
): { allowed: boolean; error?: string } {
  const now = Date.now();
  const bans = activeBans(config, now);
  if (bans.length === 0 && cap <= 0) return { allowed: true };
  // The administrator is exempt, like they are from maintenance mode. A ban
  // must never be able to lock the person who runs the product out of it.
  if (identity && isAdmin(identity)) return { allowed: true };
  if (!identity) {
    return {
      allowed: false,
      error: "Openmi needs to identify this device before it can answer. Reload the page and try again.",
    };
  }
  const ban = bans.find((entry) => entry.uid === identity.uid);
  if (ban) return { allowed: false, error: banMessage(ban) };
  return { allowed: true };
}

export { adminEmail };

/** Today's key in UTC, which is what daily caps are counted against. */
export function usageDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type UsageKind = "chat" | "image";
/** Which model mode a chat message used, recorded for the console's breakdown. */
export type UsageMode = "auto" | "code" | "self";

export type UsageCounters = Partial<Record<UsageKind | UsageMode, number>>;

/**
 * Counts one use against the caller's day and answers the new total.
 *
 * `bump_usage()` does the increment in one statement, so two simultaneous
 * requests cannot both read the same counter and write the same value back —
 * the read-modify-write the Realtime Database REST API forced on this. The
 * function runs as the caller, so RLS and the owner check still apply.
 *
 * A refused call means the caller is not who they claim; the route treats that
 * as unauthenticated rather than silently trusting the counter.
 */
export async function consumeUsage(
  authorization: string | null,
  uid: string,
  kind: UsageKind,
  mode?: UsageMode
): Promise<{ used: number; allowed: boolean }> {
  const token = bearerToken(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return { used: 0, allowed: false };

  try {
    const { data, error } = await client.rpc("bump_usage", {
      p_kind: kind,
      p_mode: mode ?? null,
    });
    if (error) return { used: 0, allowed: false };
    // A set-returning function answers with one row.
    const row = (Array.isArray(data) ? data[0] : data) as UsageCounters | null;
    return { used: Number(row?.[kind] ?? 0), allowed: true };
  } catch {
    return { used: 0, allowed: false };
  }
}

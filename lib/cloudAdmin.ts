// ── The admin console's window into the data ────────────────────────────────
// The console reads every visitor's logged chats and can wipe them. That used to
// need a service account, because the browser was not allowed to read chat data
// at all and only the Admin SDK — which ignored the rules — could. It does not
// any more, and it still does not: the policies in `supabase/migrations` grant
// one address elevated read and write across the user tables, and this module is
// the client-side caller for those grants.
//
// So there is no project-wide credential in the deployment environment, and no
// service-role key in this file. The check in `verifyAdminAccess` is cosmetic: it
// only decides which screen to show. Postgres evaluates the same condition on
// every read and write, so patching this file would gain an attacker nothing.
//
// Every call here runs as the signed-in administrator — the session already
// holds their JWT — which is why signing in is a prerequisite for the console
// rather than a convenience.

import { getSupabase } from "./supabase";
import {
  DEW_RESET_TIME_ZONE,
  dailyAllowance,
  dewAvailableFrom,
  dewBalanceFrom,
  dewDay,
  isSupportedTimeZone,
  roundDew,
} from "./dew";
import type { AppConfig } from "./appConfig";
import {
  isValidCode,
  normalizeCode,
  type RedeemCode,
} from "./redeemState";

/** Timestamps are `timestamptz` in the database and epoch ms here. */
function ms(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function iso(value: number): string {
  return new Date(value > 0 ? value : Date.now()).toISOString();
}

function codeOf(cause: unknown): string {
  return (cause as { code?: string } | null)?.code ?? "";
}

/** True when the database refused a read or write for lack of privilege. */
function isPermissionDenied(cause: unknown): boolean {
  const code = codeOf(cause);
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return code === "42501" || /permission denied|row-level security|not authorized/i.test(message);
}

function notConfigured(): Error & { code?: string } {
  const error = new Error("Supabase is not configured") as Error & { code?: string };
  error.code = "app/not-configured";
  return error;
}

function unauthorized(): Error & { code?: string } {
  const error = new Error("This account is not the Openmi administrator.") as Error & { code?: string };
  error.code = "app/permission-denied";
  return error;
}

function rethrow(cause: unknown): never {
  if (isPermissionDenied(cause)) throw unauthorized();
  throw cause;
}

/** The signed-in client, or a thrown coded error the console can explain. */
function requireClient() {
  const client = getSupabase();
  if (!client) throw notConfigured();
  return client;
}

/**
 * Whether the signed-in account is the administrator.
 *
 * Answered by `public.is_admin()` — the same function every policy calls — so
 * the console's answer cannot disagree with the database's. False rather than a
 * throw when the account is simply not the one: that is the ordinary case for a
 * visitor who found the hidden prompt.
 */
export async function verifyAdminAccess(): Promise<boolean> {
  const client = requireClient();
  const session = await client.auth.getSession();
  if (!session.data.session?.user) return false;
  const { data, error } = await client.rpc("is_admin");
  if (error) {
    if (isPermissionDenied(error)) return false;
    throw error;
  }
  return data === true;
}

/**
 * Signs in with Google, returning once the round trip has been requested.
 *
 * Supabase's OAuth is a full-page redirect, so this returns after the browser
 * has already left; the gate re-checks `verifyAdminAccess` when it comes back,
 * which is the only thing that decides whether the console opens.
 */
export async function signInAsAdmin(): Promise<string> {
  const client = requireClient();
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: typeof window === "undefined" ? undefined : window.location.origin },
  });
  if (error) throw error;
  return "";
}

/** Ends the admin session. The app then shows the sign-in screen. */
export async function signOutAdmin(): Promise<void> {
  const client = getSupabase();
  if (!client) return;
  await client.auth.signOut();
}

/** The UID currently signed in, for the first-run setup hint. */
export async function currentUid(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.user?.id ?? null;
}

export async function endAdminSession(): Promise<void> {
  await signOutAdmin();
}

// ── People ──────────────────────────────────────────────────────────────────

export interface AdminUser {
  uid: string;
  name: string | null;
  firstSeen: number | null;
  lastSeen: number | null;
  chats: number;
  messages: number;
}

/**
 * Everyone who has been here at all, not only everyone who has talked.
 *
 * The registry supplies the names and the two timestamps; `admin_user_stats()`
 * supplies the counts in one call rather than downloading every message to count
 * them. Both are administrator-only, so a non-admin gets nothing to draw.
 */
export async function listUsers(): Promise<AdminUser[]> {
  const client = requireClient();

  const [registry, stats] = await Promise.all([
    client.from("visitor_registry").select("owner, name, first_seen, last_seen"),
    client.rpc("admin_user_stats"),
  ]).catch(rethrow);

  if (registry.error) rethrow(registry.error);
  if (stats.error) rethrow(stats.error);

  const names = new Map<string, { name: string; firstSeen: number; lastSeen: number }>();
  for (const row of (registry.data ?? []) as Record<string, unknown>[]) {
    const uid = String(row.owner ?? "");
    if (!uid) continue;
    names.set(uid, {
      name: typeof row.name === "string" ? row.name : "",
      firstSeen: ms(row.first_seen),
      lastSeen: ms(row.last_seen),
    });
  }

  const counts = new Map<string, { chats: number; messages: number; lastChatAt: number }>();
  for (const row of (stats.data ?? []) as Record<string, unknown>[]) {
    const uid = String(row.owner ?? "");
    if (!uid) continue;
    counts.set(uid, {
      chats: Number(row.chats ?? 0),
      messages: Number(row.messages ?? 0),
      lastChatAt: ms(row.last_chat_at),
    });
  }

  const uids = new Set([...names.keys(), ...counts.keys()]);
  const rows: AdminUser[] = [...uids].map((uid) => {
    const profile = names.get(uid);
    const counted = counts.get(uid);
    return {
      uid,
      name: profile?.name ?? null,
      firstSeen: profile?.firstSeen ?? null,
      lastSeen: profile?.lastSeen ?? counted?.lastChatAt ?? null,
      chats: counted?.chats ?? 0,
      messages: counted?.messages ?? 0,
    };
  });

  rows.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  return rows;
}

export interface AdminChat {
  chatId: string;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export async function listChats(uid: string): Promise<AdminChat[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("chats")
    .select("id, title, created_at, updated_at")
    .eq("owner", uid)
    .order("updated_at", { ascending: false });
  if (error) rethrow(error);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    chatId: String(row.id ?? ""),
    id: String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "Untitled",
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at) || ms(row.created_at),
  }));
}

export interface AdminMessage {
  role: "user" | "assistant";
  content: string;
  model: string | null;
  createdAt: number;
  error: string | null;
}

export async function getChat(
  uid: string,
  chatId: string
): Promise<{ title: string; messages: AdminMessage[] }> {
  const client = requireClient();
  const [chat, messages] = await Promise.all([
    client.from("chats").select("id, title").eq("owner", uid).eq("id", chatId).maybeSingle(),
    client
      .from("chat_messages")
      .select("role, content, model, created_at, error")
      .eq("owner", uid)
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true }),
  ]).catch(rethrow);

  if (chat.error) rethrow(chat.error);
  if (messages.error) rethrow(messages.error);
  if (!chat.data) throw new Error("Chat not found.");

  return {
    title: typeof chat.data.title === "string" ? chat.data.title : "Untitled",
    messages: ((messages.data ?? []) as Record<string, unknown>[])
      .filter((row) => typeof row.content === "string" && row.content !== "")
      .map((row) => ({
        role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(row.content ?? ""),
        model: typeof row.model === "string" ? row.model : null,
        createdAt: ms(row.created_at),
        error: typeof row.error === "string" ? row.error : null,
      })),
  };
}

/** The tables a person's content lives in. Ordered so messages go before chats. */
const USER_CONTENT_TABLES = [
  "chat_messages",
  "chats",
  "memories",
  "github_connections",
  "github_default",
  "github_links",
  "projects",
  "changesets",
  "approvals",
  "commits",
] as const;

/**
 * Removes one visitor's content.
 *
 * Deliberately **not** their Dew wallet: a paid-for balance belongs to the person
 * and not to the chat history, so wiping somebody's conversations must not
 * confiscate what they bought. The same is true of the usage ledger, which is
 * the record of what was spent.
 */
export async function wipeUser(uid: string): Promise<void> {
  const client = requireClient();
  for (const table of USER_CONTENT_TABLES) {
    const { error } = await client.from(table).delete().eq("owner", uid);
    if (error) rethrow(error);
  }
}

export async function wipeAll(): Promise<void> {
  const client = requireClient();
  for (const table of USER_CONTENT_TABLES) {
    const { error } = await client.from(table).delete().not("owner", "is", null);
    if (error) rethrow(error);
  }
  for (const table of ["visitor_registry", "usage_daily"] as const) {
    const { error } = await client.from(table).delete().not("owner", "is", null);
    if (error) rethrow(error);
  }
}

// ── Dew ────────────────────────────────────────────────────────────────────
// A manual sale with a buyer standing in front of you needs a direct transfer:
// the codes screen hands over a word, but when someone has paid and you have
// their visitor id, the honest thing is to credit their wallet from here.
//
// The credit is a `dew_credits` row under a TOPUP-… key — the same shape the
// server-side balance reads — and the policies pin every dimension of it: only
// the administrator may write a credit of a chosen amount, and no amount over
// 100,000 is accepted. Nothing here decides access; the browser writes with the
// admin's own verified token and Postgres refuses anything else.

export interface DewGrant {
  uid: string;
  dew: number;
  balance: number;
}

interface WalletSnapshot {
  owner: string;
  spent: number;
  dailyDay: string | null;
  dailySpent: number;
}

interface WalletSnapshots {
  rows: WalletSnapshot[];
  /** False before 20261024000200_daily_dew.sql is applied. */
  dailyTracked: boolean;
}

/**
 * Wallet rows with their daily free bucket.
 *
 * If the daily columns are not there yet — the console can be open while a
 * migration is rolling out — the paid-only columns answer instead, so the
 * People screen shows the balance that still exists rather than failing whole.
 */
async function readWalletSnapshots(uid?: string): Promise<WalletSnapshots> {
  const client = requireClient();
  const query = client.from("dew_wallets").select("owner, spent, daily_day, daily_spent");
  const { data, error } = await (uid ? query.eq("owner", uid) : query);
  if (!error) {
    return {
      dailyTracked: true,
      rows: ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        owner: String(row.owner ?? ""),
        spent: Number(row.spent ?? 0),
        dailyDay: typeof row.daily_day === "string" ? row.daily_day : null,
        dailySpent: Number(row.daily_spent ?? 0),
      })),
    };
  }

  const legacyQuery = client.from("dew_wallets").select("owner, spent");
  const legacy = await (uid ? legacyQuery.eq("owner", uid) : legacyQuery);
  if (legacy.error) rethrow(legacy.error);
  return {
    dailyTracked: false,
    rows: ((legacy.data ?? []) as Record<string, unknown>[]).map((row) => ({
      owner: String(row.owner ?? ""),
      spent: Number(row.spent ?? 0),
      dailyDay: null,
      dailySpent: 0,
    })),
  };
}

/**
 * The stored IANA zone for each profile, where one is readable and valid.
 *
 * An account that has not registered a zone — or a project that has not applied
 * 20261024000300_dew_timezone.sql — contributes nothing here, and the caller
 * falls back to the product's default day.
 */
async function readTimeZones(uid?: string): Promise<Map<string, string>> {
  const client = requireClient();
  const query = client.from("profiles").select("id, timezone");
  const { data, error } = await (uid ? query.eq("id", uid) : query);
  const zones = new Map<string, string>();
  if (error) return zones;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const id = typeof row.id === "string" ? row.id : "";
    if (id && isSupportedTimeZone(row.timezone)) zones.set(id, row.timezone);
  }
  return zones;
}

/**
 * The owners whose paid pass is live right now.
 *
 * The pass table is readable by its owner and by the administrator under the
 * existing policies. A project without 20261028000000_pricing_sessions.sql has
 * no passes, which is the same answer as "nobody is paid".
 */
async function readPaidPasses(uid?: string): Promise<Set<string>> {
  const client = requireClient();
  const query = client.from("paid_passes").select("owner, expires_at");
  const { data, error } = await (uid ? query.eq("owner", uid) : query);
  const paid = new Set<string>();
  if (error) return paid;
  const now = Date.now();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const owner = typeof row.owner === "string" ? row.owner : "";
    const expires = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : 0;
    if (owner && expires > now) paid.add(owner);
  }
  return paid;
}

/** One visitor's Dew, derived the same way the server derives it. */
export async function readDewBalance(uid: string): Promise<number> {
  const client = requireClient();
  const [credits, wallets, zones, passes] = await Promise.all([
    client.from("dew_credits").select("code, amount").eq("owner", uid),
    readWalletSnapshots(uid),
    readTimeZones(uid),
    readPaidPasses(uid),
  ]).catch(rethrow);
  if (credits.error) rethrow(credits.error);

  const map: Record<string, number> = {};
  for (const row of (credits.data ?? []) as Record<string, unknown>[]) {
    if (typeof row.code === "string" && row.amount != null) {
      map[row.code] = Number(row.amount);
    }
  }
  const wallet = wallets.rows[0];
  if (!wallets.dailyTracked) {
    return dewBalanceFrom({ credits: map, spent: wallet?.spent ?? 0 });
  }
  return dewAvailableFrom(
    {
      credits: map,
      spent: wallet?.spent ?? 0,
      dailyDay: wallet?.dailyDay ?? null,
      dailySpent: wallet?.dailySpent ?? 0,
    },
    dewDay(Date.now(), zones.get(uid) ?? DEW_RESET_TIME_ZONE),
    dailyAllowance(passes.has(uid))
  );
}

/**
 * Every visitor's Dew balance, keyed by uid.
 *
 * Two reads cover the whole list, so the People screen can show a balance on
 * every row without a request per person.
 */
export async function readDewBalances(): Promise<Record<string, number>> {
  const client = requireClient();
  const [credits, wallets, zones, passes] = await Promise.all([
    client.from("dew_credits").select("owner, code, amount"),
    readWalletSnapshots(),
    readTimeZones(),
    readPaidPasses(),
  ]).catch(rethrow);
  if (credits.error) rethrow(credits.error);

  const byOwner = new Map<string, Record<string, number>>();
  for (const row of (credits.data ?? []) as Record<string, unknown>[]) {
    const uid = String(row.owner ?? "");
    if (!uid || typeof row.code !== "string") continue;
    const map = byOwner.get(uid) ?? {};
    map[row.code] = Number(row.amount ?? 0);
    byOwner.set(uid, map);
  }

  const walletsByOwner = new Map<string, WalletSnapshot>();
  for (const row of wallets.rows) {
    if (row.owner) walletsByOwner.set(row.owner, row);
  }

  const now = Date.now();
  const balances: Record<string, number> = {};
  for (const uid of new Set([...byOwner.keys(), ...walletsByOwner.keys()])) {
    const wallet = walletsByOwner.get(uid);
    const map = byOwner.get(uid) ?? {};
    balances[uid] = wallets.dailyTracked
      ? dewAvailableFrom(
          {
            credits: map,
            spent: wallet?.spent ?? 0,
            dailyDay: wallet?.dailyDay ?? null,
            dailySpent: wallet?.dailySpent ?? 0,
          },
          dewDay(now, zones.get(uid) ?? DEW_RESET_TIME_ZONE),
          dailyAllowance(passes.has(uid))
        )
      : dewBalanceFrom({ credits: map, spent: wallet?.spent ?? 0 });
  }
  return balances;
}

/**
 * Credits Dew straight to a visitor's wallet.
 *
 * The credit keys on a TOPUP timestamp so a repeat grant adds rather than
 * replaces — a 100-Dew grant issued twice is 200 Dew, not a rewrite of the first
 * — while the policies still pin that only the administrator may write a credit
 * of a chosen amount.
 */
export async function grantDew(uid: string, dew: number): Promise<DewGrant> {
  const client = requireClient();
  const visitor = uid.replace(/[^A-Za-z0-9-]/g, "");
  if (!visitor) throw new Error("Enter the visitor id first.");

  const amount = roundDew(dew);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
    throw new Error("A top-up needs a positive amount of at most 100,000 Dew.");
  }

  // Timestamp plus a short random tail, so two grants issued in the same
  // millisecond add up rather than silently overwrite each other.
  const key = `TOPUP-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const { error } = await client
    .from("dew_credits")
    .insert({ owner: visitor, code: key, amount });
  if (error) rethrow(error);

  const balance = await readDewBalance(visitor);
  return { uid: visitor, dew: amount, balance };
}

export interface PlanGrant {
  uid: string;
  /** Epoch ms the pass now ends. */
  until: number;
}

/**
 * Activates a paid pass after a manual payment.
 *
 * The write goes through `admin_grant_plan()`, which re-checks `is_admin()` in
 * the database: this function cannot grant a pass on its own, and a modified
 * browser can only call a door that will refuse it. Extension starts from
 * whichever is later, now or an unexpired pass, so renewing early never loses
 * the days still owed.
 */
export async function grantPlan(uid: string, days: number): Promise<PlanGrant> {
  const client = requireClient();
  const visitor = uid.replace(/[^A-Za-z0-9-]/g, "");
  if (!visitor) throw new Error("Enter the visitor id first.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(visitor)) {
    throw new Error("That is not a visitor id.");
  }

  const span = Math.round(days);
  if (!Number.isFinite(span) || span < 1 || span > 366) {
    throw new Error("A pass needs between 1 and 366 days.");
  }

  const { data, error } = await client.rpc("admin_grant_plan", { p_uid: visitor, p_days: span });
  if (error) rethrow(error);
  const until = ms(data);
  if (!until) throw new Error("The pass was not saved. Check that the account exists.");
  return { uid: visitor, until };
}

// ── Redeem codes ────────────────────────────────────────────────────────────
// A word the owner picks, carrying a Dew amount, that a buyer types to claim it.
// This exists because a manual top-up needs a name: "I've sent you 100 Dew" has
// to be handed over somehow, and a code is a thing that survives a phone call, a
// screenshot, and a lost message in a figure does not.
//
// Codes are the owner's, not the buyer's: the amount lives in the code, never in
// the claim. See lib/serverRedeem.ts and `lookup_redeem_code()`.

function codeFromRow(row: Record<string, unknown>): RedeemCode | null {
  if (typeof row.code !== "string" || !row.code) return null;
  const dew = Number(row.dew);
  if (!Number.isFinite(dew)) return null;
  return {
    code: row.code,
    dew,
    active: row.active === true,
    createdAt: ms(row.created_at),
    note: typeof row.note === "string" ? row.note : "",
  };
}

/** Writes a new code, replacing any that already had the same word. */
export async function createRedeemCode(input: {
  code: string;
  /** The Dew amount the code grants. */
  dew: number;
  note?: string;
}): Promise<RedeemCode> {
  const client = requireClient();
  const code = normalizeCode(input.code);
  if (!isValidCode(code)) throw new Error("A code needs at least 4 letters or numbers.");

  const note = String(input.note ?? "").trim().slice(0, 120);
  const createdAt = Date.now();

  if (typeof input.dew !== "number" || !Number.isFinite(input.dew) || input.dew <= 0 || input.dew > 100_000) {
    throw new Error("A code needs a positive Dew amount of at most 100,000.");
  }
  const record: RedeemCode = {
    code,
    dew: Math.round(input.dew * 1000) / 1000,
    active: true,
    createdAt,
    note,
  };
  const { error } = await client.from("redeem_codes").upsert(
    {
      code: record.code,
      dew: record.dew,
      active: record.active,
      note: record.note,
      created_at: iso(record.createdAt),
    },
    { onConflict: "code" }
  );
  if (error) rethrow(error);
  return record;
}

/** Every code the owner has made, newest first. */
export async function listRedeemCodes(): Promise<RedeemCode[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("redeem_codes")
    .select("code, dew, active, note, created_at")
    .order("created_at", { ascending: false });
  if (error) rethrow(error);
  return ((data ?? []) as Record<string, unknown>[])
    .map(codeFromRow)
    .filter((code): code is RedeemCode => code !== null);
}

/**
 * Switches a code on or off.
 *
 * Switching off is the urgent one: a word that has been posted publicly and is
 * being resold can be stopped here immediately. A code that has already been
 * claimed also stops being worth anything, because the server re-checks `active`
 * on every request rather than trusting the claim to have been made while it was
 * on.
 */
export async function setRedeemCodeActive(code: string, active: boolean): Promise<void> {
  const client = requireClient();
  const word = normalizeCode(code);
  const { data, error } = await client
    .from("redeem_codes")
    .update({ active })
    .eq("code", word)
    .select("code")
    .maybeSingle();
  if (error) rethrow(error);
  if (!data) throw new Error("That code no longer exists.");
}

/** Deletes a code entirely. */
export async function deleteRedeemCode(code: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("redeem_codes").delete().eq("code", normalizeCode(code));
  if (error) rethrow(error);
}

// ── Usage ──────────────────────────────────────────────────────────────────

export interface AdminUsage {
  uid: string;
  day: string;
  chat: number;
  image: number;
}

function dayOf(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/** Today's counters, one row per visitor that has any. */
export async function listUsage(): Promise<AdminUsage[]> {
  const client = requireClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await client
    .from("usage_daily")
    .select("owner, day, chat, image")
    .eq("day", today);
  if (error) rethrow(error);
  const rows = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    uid: String(row.owner ?? ""),
    day: dayOf(row.day),
    chat: Number(row.chat ?? 0),
    image: Number(row.image ?? 0),
  }));
  rows.sort((a, b) => b.chat + b.image - (a.chat + a.image));
  return rows;
}

export interface UsageHistoryDay {
  day: string;
  uids: string[];
  chat: number;
  image: number;
  auto: number;
  code: number;
  self: number;
}

export async function listUsageHistory(limitDays = 60): Promise<UsageHistoryDay[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("usage_daily")
    .select("owner, day, chat, image, auto, code, self");
  if (error) rethrow(error);

  const byDay = new Map<string, UsageHistoryDay>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const day = dayOf(row.day);
    let entry = byDay.get(day);
    if (!entry) {
      entry = { day, uids: [], chat: 0, image: 0, auto: 0, code: 0, self: 0 };
      byDay.set(day, entry);
    }
    entry.uids.push(String(row.owner ?? ""));
    entry.chat += Number(row.chat ?? 0);
    entry.image += Number(row.image ?? 0);
    entry.auto += Number(row.auto ?? 0);
    entry.code += Number(row.code ?? 0);
    entry.self += Number(row.self ?? 0);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-limitDays);
}

/** Saves the runtime controls. The admin's own token is what makes it allowed. */
export async function saveAppConfig(config: AppConfig): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("app_config").upsert(
    {
      id: 1,
      chat_enabled: config.chatEnabled,
      search_enabled: config.searchEnabled,
      announcement: config.announcement,
      daily_chat_cap: config.dailyChatCap,
      bans: config.bans,
      maintenance_enabled: config.maintenanceEnabled,
      maintenance_message: config.maintenanceMessage,
      updated_at: iso(config.updatedAt),
    },
    { onConflict: "id" }
  );
  if (error) rethrow(error);
}

// ── Audit ──────────────────────────────────────────────────────────────────

export interface AdminAuditEntry {
  id: string;
  at: number;
  action: "createCode" | "deleteCode" | "toggleCode" | "grantDew" | "grantPlan";
  /** The word the entry is about. */
  code?: string;
  /** The Dew the code carried, when it carried any. */
  dew?: number;
  /** For a toggle: the state the code was switched to. */
  active?: boolean;
  /** The uid the action acted on. */
  uid?: string;
  note?: string;
}

export async function appendAdminAudit(
  entry: Omit<AdminAuditEntry, "id">
): Promise<AdminAuditEntry> {
  const client = requireClient();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const { error } = await client.from("admin_audit").insert({
    id,
    at: iso(entry.at),
    action: entry.action,
    code: entry.code ?? null,
    dew: entry.dew ?? null,
    active: entry.active ?? null,
    uid: entry.uid ?? null,
    note: entry.note ?? null,
  });
  if (error) rethrow(error);
  return { ...entry, id };
}

/** Newest first, capped: the console shows the recent ledger, not all of it. */
export async function listAdminAudit(limit = 50): Promise<AdminAuditEntry[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("admin_audit")
    .select("id, at, action, code, dew, active, uid, note")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) rethrow(error);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id ?? ""),
    at: ms(row.at),
    action: row.action as AdminAuditEntry["action"],
    code: typeof row.code === "string" ? row.code : undefined,
    dew: row.dew == null ? undefined : Number(row.dew),
    active: typeof row.active === "boolean" ? row.active : undefined,
    uid: typeof row.uid === "string" ? row.uid : undefined,
    note: typeof row.note === "string" ? row.note : undefined,
  }));
}

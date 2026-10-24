import { getSupabase } from "./supabase";

// ── Runtime controls, read by the server on every request ───────────────────
// The administrator sets these from the admin console. They live in the
// `app_config` table with a public read policy, which is what lets the
// server-side route handlers enforce them without holding any credential of
// their own: an unauthenticated read is exactly what the policy grants, so no
// service key had to be introduced to keep the deployment secret-free.
//
// Every default is permissive. A missing or unreadable row must never take the
// app down, so anything absent is treated as "no restriction configured" rather
// than as a denial.

/**
 * One ban, with everything the console and the visitor need to know about it.
 *
 * A bare uid was enough to refuse somebody, but it answered none of the
 * questions a ban actually raises: why it was made, who made it, when it was
 * made, and whether it ever lifts. A temporary ban that expires by itself is
 * the difference between a sanction and a permanent grudge.
 */
export interface BanRecord {
  uid: string;
  /** Shown to the visitor in the refusal. Empty when none was given. */
  reason: string;
  /** When the ban was made. 0 only for a legacy record with no history. */
  bannedAt: number;
  /** When the ban lifts on its own. null means permanent. */
  expiresAt: number | null;
  /** The administrator's address at the time of the ban, when known. */
  bannedBy: string;
}

/** Whether a ban is still in force at `now`. An expired ban lifts by itself. */
export function isBanActive(ban: BanRecord, now = Date.now()): boolean {
  return ban.expiresAt === null || ban.expiresAt > now;
}

export interface AppConfig {  /** Master switch for chat. */
  chatEnabled: boolean;
  /** Master switch for web search inside chat. */
  searchEnabled: boolean;
  /** A short line shown to every visitor. Empty hides the banner. */
  announcement: string;

  /** Messages per visitor per day. 0 means unlimited. */
  dailyChatCap: number;
  /** Everyone the server refuses, with the reason and the length of the ban. */
  bans: BanRecord[];
  /**
   * Closes Openmi to everyone but the administrator. Enforced in the route
   * handlers, so it holds even for a visitor with a modified bundle.
   */
  maintenanceEnabled: boolean;
  /** Shown on the notice. The administrator sees it too. */
  maintenanceMessage: string;
  updatedAt: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  chatEnabled: true,
  searchEnabled: true,
  announcement: "",
  dailyChatCap: 0,
  bans: [],
  maintenanceEnabled: false,
  maintenanceMessage: "Openmi is down for maintenance. Please check back soon.",
  updatedAt: 0,
};

const asBool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const asCount = (value: unknown) => {
  const n = typeof value === "number" ? Math.trunc(value) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Coerces one stored ban, falling back to the map key as the uid. */
function normalizeBan(raw: unknown, fallbackUid: string): BanRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const uid = typeof value.uid === "string" && value.uid.trim() ? value.uid.trim() : fallbackUid;
  if (!uid) return null;
  return {
    uid,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 200) : "",
    bannedAt: typeof value.bannedAt === "number" && value.bannedAt > 0 ? value.bannedAt : 0,
    // Anything not a positive timestamp is read as "no end recorded", which
    // the console writes back as permanent. A ban must never expire into
    // existence because a field arrived malformed.
    expiresAt: typeof value.expiresAt === "number" && value.expiresAt > 0 ? value.expiresAt : null,
    bannedBy: typeof value.bannedBy === "string" ? value.bannedBy.slice(0, 120) : "",
  };
}

/**
 * Reads the ban list from either shape the database may hold.
 *
 * New writes are a map keyed by uid (`bans/{uid}`), which is what the Realtime
 * Database stores naturally. Older deployments hold a bare `bannedUids` array
 * of uid strings; those bans were permanent and carried no reason, and folding
 * them in here means an existing deployment keeps every ban it had with no
 * migration step and no window in which the list reads as empty.
 */
function normalizeBans(raw: unknown, legacy: unknown): BanRecord[] {
  const bans: BanRecord[] = [];
  const seen = new Set<string>();
  const add = (record: BanRecord | null) => {
    if (record && !seen.has(record.uid)) {
      seen.add(record.uid);
      bans.push(record);
    }
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) add(normalizeBan(entry, ""));
  } else if (raw && typeof raw === "object") {
    for (const [uid, entry] of Object.entries(raw as Record<string, unknown>)) add(normalizeBan(entry, uid));
  }
  if (Array.isArray(legacy)) {
    for (const uid of legacy) {
      if (typeof uid === "string" && uid.trim()) {
        add({ uid: uid.trim(), reason: "", bannedAt: 0, expiresAt: null, bannedBy: "" });
      }
    }
  }
  return bans;
}

/** Coerces whatever is stored into a usable config, ignoring junk values. */
export function normalizeConfig(raw: unknown): AppConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    chatEnabled: asBool(value.chatEnabled, DEFAULT_CONFIG.chatEnabled),
    searchEnabled: asBool(value.searchEnabled, DEFAULT_CONFIG.searchEnabled),
    announcement: typeof value.announcement === "string" ? value.announcement.slice(0, 200) : "",
    dailyChatCap: asCount(value.dailyChatCap),
    bans: normalizeBans(value.bans, value.bannedUids),
    maintenanceEnabled: asBool(value.maintenanceEnabled, DEFAULT_CONFIG.maintenanceEnabled),
    maintenanceMessage:
      typeof value.maintenanceMessage === "string" && value.maintenanceMessage.trim()
        ? value.maintenanceMessage.slice(0, 300)
        : DEFAULT_CONFIG.maintenanceMessage,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

/** The stored row, in the shape `normalizeConfig` understands. */
function rowToStored(row: Record<string, unknown>) {
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

/**
 * Subscribes to the administrator's settings. Used for the announcement banner
 * and to grey out controls, never for enforcement — a client that lies about
 * the config gains nothing, because the server decides.
 *
 * This is the one live listener the app has. It is a Postgres `postgres_changes`
 * subscription on the single config row rather than a poll: an administrator
 * switching chat off should reach every open tab in the time a database
 * notification takes, and the row changes a handful of times a month, so the
 * socket costs nothing between those events. The initial read is separate
 * because a subscription only reports changes from the moment it starts.
 *
 * Every failure is silent. A missing config, a dropped socket, a browser with
 * realtime blocked — all of them leave the permissive defaults in place, which
 * is exactly what an unreachable config has always meant.
 */
export function subscribeAppConfig(onChange: (config: AppConfig) => void): () => void {
  const client = getSupabase();
  if (!client) {
    onChange(DEFAULT_CONFIG);
    return () => {};
  }

  let cancelled = false;

  void client
    .from("app_config")
    .select(
      "chat_enabled, search_enabled, announcement, daily_chat_cap, bans, maintenance_enabled, maintenance_message, updated_at"
    )
    .eq("id", 1)
    .maybeSingle()
    .then(({ data }) => {
      if (!cancelled && data) onChange(normalizeConfig(rowToStored(data)));
    });

  // supabase.channel(topic) returns the existing instance when a channel
  // with that topic is still registered — including one whose async
  // removeChannel has been called but not yet completed. Calling
  // .on("postgres_changes", …) on an already-subscribed instance throws:
  // "cannot add `postgres_changes` callbacks … after `subscribe()`."
  //
  // The one caller that matters (the app root effect) subscribes once for the
  // lifetime of the tab, so the common path is: subscribe, then never touch it
  // again. The defensive check below is for the rare path where a parent
  // re-renders, a child remounts, or the same function is reached again before
  // the previous removal finished — in all of those we must not re-register.
  const channel = client.channel("openmi:app-config");

  // `channel.state` is the public getter on RealtimeChannel (one of the
  // REALTIME_CHANNEL_STATES values: closed / errored / joined / joining /
  // leaving). The internal isJoined/isJoining helpers live in the phoenix
  // adapter and are not exposed on the type in this realtime-js version, so
  // we read state directly.
  const channelState = (channel as { state?: string }).state;
  let alreadySubscribed = false;
  if (channelState === "joined" || channelState === "joining") {
    alreadySubscribed = true;
  }

  if (!alreadySubscribed) {
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "app_config" },
      (payload) => {
        if (cancelled) return;
        const row = (payload.new ?? null) as Record<string, unknown> | null;
        if (row) onChange(normalizeConfig(rowToStored(row)));
      }
    );

    channel.subscribe();
  }

  return () => {
    cancelled = true;
    void client.removeChannel(channel);
  };
}

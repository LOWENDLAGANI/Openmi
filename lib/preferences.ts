// ── Preferences that follow the account ──────────────────────────────────────
//
// The small choices that make Openmi feel like yours — appearance, response
// length, reasoning effort, search mode, the last model and the display name —
// are written to `user_preferences` against
// the signed-in account. A second browser therefore opens with the same settings
// instead of the defaults.
//
// localStorage stays the first read. It is instant, it needs no network, and the
// first paint must not wait for a database round trip. The cloud copy is loaded
// immediately after the session is known and adopted over the local values; a
// failed read or write leaves the local copy standing, because a preference is a
// convenience and never something worth showing an error for.

import { currentUser, getSupabase } from "./supabase";
import {
  DEFAULT_APPEARANCE,
  DEFAULT_HOME_LAYOUT,
  loadAppearance,
  loadHomeLayout,
  loadReasoningEffort,
  loadResponseLength,
  saveAppearance,
  saveHomeLayout,
  saveReasoningEffort,
  saveResponseLength,
  type Appearance,
  type HomeLayout,
  type ReasoningEffort,
  type ResponseLength,
} from "./settings";
import { DEFAULT_MODE_ID, OPENMI_MODES, type ModeId } from "./models";
import type { SearchMode } from "./types";
import { loadSelectedMode, saveSelectedMode } from "./db";
import { loadDisplayName, saveDisplayName, loadAvatar, saveAvatar } from "./visitorName";

const SEARCH_MODE_KEY = "openmi:search-mode";

export interface UserPreferences {
  displayName: string | null;
  avatarUrl: string | null;
  appearance: Appearance;
  homeLayout: HomeLayout;
  responseLength: ResponseLength;
  reasoningEffort: ReasoningEffort;
  searchMode: SearchMode;
  model: ModeId | null;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  displayName: null,
  avatarUrl: null,
  appearance: DEFAULT_APPEARANCE,
  homeLayout: DEFAULT_HOME_LAYOUT,
  responseLength: "balanced",
  reasoningEffort: "low",
  searchMode: "auto",
  model: DEFAULT_MODE_ID,
};

function readSearchMode(): SearchMode {
  if (typeof window === "undefined") return "auto";
  try {
    const value = window.localStorage.getItem(SEARCH_MODE_KEY);
    return value === "always" || value === "off" ? value : "auto";
  } catch {
    return "auto";
  }
}

/** What this browser already knows. Safe on the server and in private mode. */
export function loadLocalPreferences(): UserPreferences {
  return {
    displayName: loadDisplayName() || null,
    avatarUrl: loadAvatar() || null,
    appearance: loadAppearance(),
    homeLayout: loadHomeLayout(),
    responseLength: loadResponseLength(),
    reasoningEffort: loadReasoningEffort(),
    searchMode: readSearchMode(),
    model: loadSelectedMode(),
  };
}

/** Writes the local copy, which is what the next first paint reads. */
export function saveLocalPreferences(preferences: UserPreferences): void {
  saveHomeLayout(preferences.homeLayout);
  saveAppearance(preferences.appearance, preferences.homeLayout);
  saveResponseLength(preferences.responseLength);
  saveReasoningEffort(preferences.reasoningEffort);
  try {
    window.localStorage.setItem(SEARCH_MODE_KEY, preferences.searchMode);
  } catch {
    // Private mode: the preferences simply are not remembered next visit.
  }
  saveSelectedMode(preferences.model ?? DEFAULT_MODE_ID);
  saveDisplayName(preferences.displayName ?? "");
  saveAvatar(preferences.avatarUrl ?? "");
}

/** The row shape read from `user_preferences`. */
function preferencesFromRow(row: Record<string, unknown>): UserPreferences {
  const appearance: Appearance = row.appearance === "dark" ? "dark" : DEFAULT_APPEARANCE;
  const homeLayout: HomeLayout = row.home_layout === "focus" ? "focus" : DEFAULT_HOME_LAYOUT;
  const responseLength: ResponseLength =
    row.response_length === "short" || row.response_length === "detailed"
      ? row.response_length
      : "balanced";
  const reasoningEffort: ReasoningEffort =
    row.reasoning_effort === "medium" || row.reasoning_effort === "high"
      ? row.reasoning_effort
      : "low";
  const searchMode: SearchMode =
    row.search_mode === "always" || row.search_mode === "off" ? row.search_mode : "auto";
  const avatarUrl =
    (typeof row.avatar_url === "string" && row.avatar_url.trim()) ||
    (typeof row.avatarUrl === "string" && row.avatarUrl.trim()) ||
    null;
  return {
    displayName:
      typeof row.display_name === "string" && row.display_name.trim()
        ? row.display_name.trim().slice(0, 40)
        : null,
    avatarUrl,
    appearance,
    homeLayout,
    responseLength,
    reasoningEffort,
    searchMode,
    model:
      typeof row.model === "string" && OPENMI_MODES.some((mode) => mode.id === row.model)
        ? (row.model as ModeId)
        : null,
  };
}

/**
 * The account's copy, or null when there is none to adopt.
 *
 * Null covers "nobody signed in", "the table has not been migrated yet" and
 * "offline". All three mean the same thing to the caller: keep what the browser
 * already has.
 */
export async function loadCloudPreferences(): Promise<UserPreferences | null> {
  const client = getSupabase();
  if (!client) return null;
  const user = await currentUser();
  if (!user) return null;
  try {
    const { data, error } = await client
      .from("user_preferences")
      .select(
        "display_name, avatar_url, appearance, home_layout, response_length, reasoning_effort, search_mode, model"
      )
      .eq("owner", user.id)
      .maybeSingle();
    if (error || !data) return null;
    return preferencesFromRow(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Writes the whole preference row for the signed-in account.
 *
 * An upsert rather than a patch, because the caller always has the complete set
 * after merging a change, and a complete row is what makes a second browser's
 * read deterministic. Never throws: a failed sync must not turn a settings tap
 * into an error message.
 */
export async function saveCloudPreferences(preferences: UserPreferences): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const user = await currentUser();
  if (!user) return false;
  try {
    const { error } = await client.from("user_preferences").upsert(
      {
        owner: user.id,
        display_name: preferences.displayName,
        avatar_url: preferences.avatarUrl,
        appearance: preferences.appearance,
        home_layout: preferences.homeLayout,
        response_length: preferences.responseLength,
        reasoning_effort: preferences.reasoningEffort,
        search_mode: preferences.searchMode,
        model: preferences.model,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner" }
    );
    return !error;
  } catch {
    return false;
  }
}

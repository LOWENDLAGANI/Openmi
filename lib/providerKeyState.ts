// ── A key the person brings for a model provider ────────────────────────────
// Pure rules only: what a key may look like, how it is named, and what the
// interface is allowed to show of it. Nothing here imports Supabase, crypto or
// a provider, so the same rules can be run on the server before a key is sealed
// and in the browser while it is typed — one implementation, two callers.
//
// The prefix check is not security. It is a typo check with a good error
// message: pasting a GitHub token into the Gemini field is a mistake worth
// catching before a round trip to the vendor, and every one of these providers
// has a stable prefix that makes the mistake obvious.

/** The providers an account may bring its own key for. */
export type UserKeyProvider = "openrouter" | "gemini" | "groq";

/** In the order the settings screen lists them. */
export const USER_KEY_PROVIDERS: readonly UserKeyProvider[] = ["openrouter", "gemini", "groq"];

export const USER_KEY_LABELS: Record<UserKeyProvider, string> = {
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  groq: "Groq",
};

/** What this provider's key does in the product, in one line. */
export const USER_KEY_HELP: Record<UserKeyProvider, string> = {
  openrouter: "Auto mode's router — the first model Openmi tries.",
  gemini: "Auto mode's fallback when the router is unavailable.",
  groq: "Code mode, and Auto's last resort.",
};

/** Where a key can be obtained. Shown beside the field, never linked from data. */
export const USER_KEY_SOURCES: Record<UserKeyProvider, string> = {
  openrouter: "openrouter.ai/keys",
  gemini: "aistudio.google.com/apikey",
  groq: "console.groq.com/keys",
};

/** Every key starts with a vendor prefix; these are the ones we expect. */
const KEY_PREFIXES: Record<UserKeyProvider, string> = {
  openrouter: "sk-or-",
  gemini: "AIza",
  groq: "gsk_",
};

/** The shortest key worth sending to a vendor. All three are longer. */
export const MIN_KEY_LENGTH = 20;

/** True when `value` names a provider this deployment can route to. */
export function isUserKeyProvider(value: unknown): value is UserKeyProvider {
  return typeof value === "string" && (USER_KEY_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Why this key cannot be saved, or null when it can.
 *
 * Deliberately about shape, not validity: only the vendor can say whether a key
 * works, and that is asked separately so a network failure is reported as one
 * rather than as a bad key.
 */
export function keyProblem(provider: UserKeyProvider, value: string): string | null {
  const key = value.trim();
  if (!key) return "Paste the key first.";
  if (/\s/.test(key)) return "A key does not contain spaces — check for a line break in the paste.";
  if (key.length < MIN_KEY_LENGTH) return `That is too short for a ${USER_KEY_LABELS[provider]} key.`;
  if (!key.startsWith(KEY_PREFIXES[provider])) {
    return `${USER_KEY_LABELS[provider]} keys start with ${KEY_PREFIXES[provider]}. That looks like a key for a different provider.`;
  }
  if (key.length > 400) return "That is longer than any provider's key, so it is probably not one.";
  return null;
}

/**
 * What the account is shown for a key it already stored.
 *
 * Four characters are enough to recognise a key and not enough to use it. An
 * empty or very short value is never echoed at all.
 */
export function keyHint(value: string): string {
  const key = value.trim();
  return key.length >= 8 ? `••••${key.slice(-4)}` : "••••";
}

/** One stored key, as the settings screen receives it. Never the key. */
export interface StoredKeySummary {
  provider: UserKeyProvider;
  hint: string;
  updatedAt: number;
}

/**
 * How a provider's key source is described on the settings row.
 *
 * Three states, and they are genuinely different things: the account brought a
 * key, the deployment has one, or nobody does and the provider cannot answer.
 */
export type KeySource = "account" | "deployment" | "missing";

export function keySourceLabel(source: KeySource, hint?: string): string {
  if (source === "account") return hint ? `Your key ${hint}` : "Your key";
  if (source === "deployment") return "The deployment's key";
  return "No key";
}

// ── The wire models behind the product names (server only) ───────────────────
//
// The one place a provider's model ids are named. Nothing here may be imported
// by a client component: these strings end up in the browser through any import
// path, and from there in stored messages and in the backup a user downloads.
//
// `toOpenmiName` is the only bridge outward, and it only ever emits a product
// name.

// The names are inverted on purpose — the newest model is the highest number —
// so a name a user learns today stays correct as older models are retired.
const CODE_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"] as const;

/** The wire id of the model each version corresponds to. */
const VERSION_NAMES: Record<string, string> = {
  "3.8": "Openmi V3",
  "3.7": "Openmi V2",
  "3.6": "Openmi V1",
};

/** The OpenAI-compatible router, which picks a model per message. */
export const AUTO_ENGINE = "openrouter/auto";

/** The wire id Code mode prefers, and the ordered fallbacks behind it. */
export const CODE_ENGINE = CODE_MODELS[0];
export const CODE_FALLBACKS = CODE_MODELS.slice(1);

/** The key that enables each mode. Server-side only — never rendered. */
export const MODE_ENV_VARS: Record<string, string> = {
  auto: "OPENROUTER_API_KEY",
  code: "GEMINI_API_KEY",
};

/**
 * Turns a wire model id into the name the product shows.
 *
 * Falls back to plain "Openmi" rather than echoing anything, because this value
 * is rendered in the chat and in error messages: an unrecognised id must not
 * become a vendor name on screen.
 */
export function toOpenmiName(model?: string): string {
  if (!model) return "Openmi";
  if (model === AUTO_ENGINE) return "Openmi Auto";

  const version = model.match(/gemini-(\d+\.\d+)/)?.[1];
  if (version && VERSION_NAMES[version]) return VERSION_NAMES[version]!;
  return "Openmi";
}

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
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"] as const;

/** The wire id of the model each version corresponds to. */
const VERSION_NAMES: Record<string, string> = {
  "3.8": "Openmi V3",
  "3.7": "Openmi V2",
  "3.6": "Openmi V1",
};

/** The OpenAI-compatible router, which picks a model per message. */
export const AUTO_ENGINE = "openrouter/auto";

/**
 * The wire model behind DeepSeek mode.
 *
 * DeepSeek serves one current Flash model under a stable alias — its docs name
 * `deepseek-flash`, which resolves to the newest V4.1 Flash build — so the
 * product does not have to chase dated ids to stay on the current model.
 */
export const DEEPSEEK_ENGINE = "deepseek-flash";

/** The one Groq model the product uses, and the only model Code may answer with. */
export const GROQ_ENGINE = "openai/gpt-oss-120b";

/**
 * The name the product shows for the Groq model.
 *
 * The Code mode is no longer called "Groq": it is pinned to this one model, so
 * the picker names the model a person is actually talking to.
 */
export const GROQ_ENGINE_NAME = "GPT-OSS 120B";

/** The Gemini models Auto falls back through, and the ordered fallbacks behind it. */
export const GEMINI_ENGINE = GEMINI_MODELS[0];
export const GEMINI_FALLBACKS = GEMINI_MODELS.slice(1);

/** The key that enables each mode. Server-side only — never rendered. */
export const MODE_ENV_VARS: Record<string, string> = {
  auto: "OPENROUTER_API_KEY",
  code: "GROQ_API_KEY",
  flash: "DEEPSEEK_API_KEY",
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
  if (model === GROQ_ENGINE) return GROQ_ENGINE_NAME;
  if (model === DEEPSEEK_ENGINE) return "DeepSeek V4.1 Flash";

  const version = model.match(/gemini-(\d+\.\d+)/)?.[1];
  if (version && VERSION_NAMES[version]) return VERSION_NAMES[version]!;
  return "Openmi";
}

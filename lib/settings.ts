export type ResponseLength = "short" | "balanced" | "detailed";
export type Appearance = "dark" | "light";

/** Openmi opens in light mode. Dark is a choice somebody makes, not the state
 *  a first-time visitor is dropped into, so anything unset resolves to light. */
export const DEFAULT_APPEARANCE: Appearance = "light";

/** How hard the model thinks before answering. Openmi defaults to the cheapest. */
export type ReasoningEffort = "low" | "medium" | "high";

const RESPONSE_LENGTH_KEY = "openmi:response-length";
const REASONING_EFFORT_KEY = "openmi:reasoning-effort";
const LEGACY_CUSTOM_INSTRUCTIONS_KEY = "openmi:custom-instructions";
const APPEARANCE_KEY = "openmi:appearance";

export function loadResponseLength(): ResponseLength {
  if (typeof window === "undefined") return "balanced";
  const value = window.localStorage.getItem(RESPONSE_LENGTH_KEY);
  return value === "short" || value === "detailed" ? value : "balanced";
}

export function saveResponseLength(value: ResponseLength): void {
  try { window.localStorage.setItem(RESPONSE_LENGTH_KEY, value); } catch { /* optional preference */ }
}

export function loadReasoningEffort(): ReasoningEffort {
  if (typeof window === "undefined") return "low";
  // The custom-instructions field is gone; drop whatever it left behind.
  try { window.localStorage.removeItem(LEGACY_CUSTOM_INSTRUCTIONS_KEY); } catch { /* optional preference */ }
  const value = window.localStorage.getItem(REASONING_EFFORT_KEY);
  return value === "medium" || value === "high" ? value : "low";
}

export function saveReasoningEffort(value: ReasoningEffort): void {
  try { window.localStorage.setItem(REASONING_EFFORT_KEY, value); } catch { /* optional preference */ }
}

export function loadAppearance(): Appearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  try {
    return window.localStorage.getItem(APPEARANCE_KEY) === "dark" ? "dark" : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** The colour of the browser's own chrome, which cannot follow a CSS class.
    Without this the address bar stays deep green above a sheet of paper. */
function applyThemeColor(value: Appearance): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute("content", value === "light" ? "#f8f9fa" : "#0b1310");
}

export function saveAppearance(value: Appearance): void {
  try { window.localStorage.setItem(APPEARANCE_KEY, value); } catch { /* optional preference */ }
  document.documentElement.classList.toggle("light", value === "light");
  applyThemeColor(value);
}

export type ResponseLength = "short" | "balanced" | "detailed";
export type Appearance = "dark" | "light";

/** Openmi opens in light mode. Dark is a choice somebody makes, not the state
 *  a first-time visitor is dropped into, so anything unset resolves to light. */
export const DEFAULT_APPEARANCE: Appearance = "light";

/**
 * How the empty home screen is laid out.
 *
 * `classic` is the headline over the composer. `focus` is the mobile design:
 * a "New chat" bar, the mark and its repository chip in the middle, and the
 * composer at the foot. Focus carries its own palette — the ink-indigo theme —
 * because the two are one design, not two switches that happen to look right
 * together.
 */
export type HomeLayout = "classic" | "focus";

export const DEFAULT_HOME_LAYOUT: HomeLayout = "classic";

/** How hard the model thinks before answering. Openmi defaults to the cheapest. */
export type ReasoningEffort = "low" | "medium" | "high";

const RESPONSE_LENGTH_KEY = "openmi:response-length";
const REASONING_EFFORT_KEY = "openmi:reasoning-effort";
const LEGACY_CUSTOM_INSTRUCTIONS_KEY = "openmi:custom-instructions";
const APPEARANCE_KEY = "openmi:appearance";
const HOME_LAYOUT_KEY = "openmi:home-layout";

/** The colour of the browser's own chrome, per theme. It cannot follow a CSS
    class, so the meta tag is written here whenever the theme changes. */
const THEME_COLORS = {
  // The paper theme is the landing page's canvas; the two dark appearances and
  // the ink Focus home keep the canvases they were designed on.
  light: "#f3f1e9",
  dark: "#0b1310",
  ink: "#1b1826",
} as const;

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

export function loadHomeLayout(): HomeLayout {
  if (typeof window === "undefined") return DEFAULT_HOME_LAYOUT;
  try {
    return window.localStorage.getItem(HOME_LAYOUT_KEY) === "focus" ? "focus" : DEFAULT_HOME_LAYOUT;
  } catch {
    return DEFAULT_HOME_LAYOUT;
  }
}

function applyThemeColor(color: string): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute("content", color);
}

/**
 * Puts the chosen look on the document.
 *
 * One function rather than a class toggle per call site, because the look is
 * decided by two preferences at once: the Focus home is the ink-indigo theme,
 * so it wins over a light or dark choice while it is on, and turning it off
 * restores the appearance that was chosen underneath. Doing this in one place
 * is what lets a settings change and a page load paint the same way.
 */
export function applyDocumentTheme(appearance: Appearance, homeLayout: HomeLayout): void {
  const root = document.documentElement;
  const ink = homeLayout === "focus";
  root.classList.toggle("ink", ink);
  root.classList.toggle("light", !ink && appearance === "light");
  root.classList.toggle("dark", !ink && appearance === "dark");
  const color = ink
    ? THEME_COLORS.ink
    : appearance === "light"
      ? THEME_COLORS.light
      : THEME_COLORS.dark;
  applyThemeColor(color);
}

export function saveAppearance(value: Appearance, homeLayout: HomeLayout = loadHomeLayout()): void {
  try { window.localStorage.setItem(APPEARANCE_KEY, value); } catch { /* optional preference */ }
  applyDocumentTheme(value, homeLayout);
}

export function saveHomeLayout(value: HomeLayout): void {
  try { window.localStorage.setItem(HOME_LAYOUT_KEY, value); } catch { /* optional preference */ }
  applyDocumentTheme(loadAppearance(), value);
}

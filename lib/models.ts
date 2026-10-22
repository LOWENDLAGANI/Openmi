// ── Model catalog ─────────────────────────────────────────────────────────────
// This module is imported by client components, so it deliberately contains no
// provider name, no API key name, and no wire model id. Those live in
// lib/modelEngines.ts, which is server-only.
//
// The catalog is the product's public face of the models: what a user picks,
// what a stored message is labelled, and what the price list in lib/dew.ts is
// keyed by. Adding a model starts here.

export type ModeId = "auto" | "code";

export interface ModeOption {
  id: ModeId;
  name: string;
  /** The label shown everywhere this mode's model is named to the user. */
  display: string;
  /**
   * When true, picking this mode always opens a fresh session rather than
   * continuing the current conversation under a different model.
   */
  separateSession: boolean;
  /** Short explanation shown in the mode menu. */
  blurb: string;
}

export const OPENMI_MODES: ModeOption[] = [
  {
    id: "auto",
    name: "Auto",
    display: "Openmi Auto",
    separateSession: false,
    blurb: "Routes each message to the best available model",
  },
  {
    id: "code",
    name: "Code",
    display: "Openmi Code",
    separateSession: true,
    blurb: "Tuned for reading and changing a repository",
  },
];

export const DEFAULT_MODE_ID: ModeId = "auto";

export function getMode(id: string): ModeOption {
  return OPENMI_MODES.find((m) => m.id === id) ?? OPENMI_MODES[0];
}

/**
 * A name the product is willing to show. Anything else is not one of its names.
 *
 * Messages store the display name rather than a provider id, so this is
 * normally a pass-through. It is still a filter rather than an echo, because a
 * message written by an older version of the app — or restored from a backup —
 * can carry a provider id, and rendering that to a user is the one thing that
 * must never happen.
 */
const PRODUCT_NAME = /^(?:Openmi(?: Auto| Code| V\d+)?)$/;

export function getModelDisplayName(model?: string): string {
  if (!model) return "Openmi";
  return PRODUCT_NAME.test(model) ? model : "Openmi";
}

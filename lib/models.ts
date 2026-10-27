// ── Model catalog ─────────────────────────────────────────────────────────────
// This module is imported by client components, so it deliberately contains no
// provider name, no API key name, and no wire model id. Those live in
// lib/modelEngines.ts, which is server-only.
//
// The catalog is the product's public face of the models: what a user picks,
// what a stored message is labelled, and what the price list in lib/dew.ts is
// keyed by. Adding a model starts here.

export type ModeId = "auto" | "code" | "flash";

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
    name: "code",
    display: "GPT-OSS 120B",
    separateSession: true,
    blurb: "GPT-OSS 120B only — tuned for reading and changing a repository",
  },
  {
    // The id names the capability, like "code" does, rather than the vendor:
    // this module is compiled into the browser, and a mode id is not a place a
    // provider name may appear. The display name is the one sanctioned place.
    id: "flash",
    name: "Flash",
    display: "DeepSeek V4.1 Flash",
    separateSession: true,
    blurb: "DeepSeek V4.1 Flash only — fast answers for a very long conversation",
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
 *
 * The Code mode's display name is whitelisted so messages written under that
 * name survive unchanged, and so the model picker can say which model the person
 * chose. "Openmi Code" stays listed so a message stored before this rename
 * keeps the label it was written with instead of silently degrading to plain
 * "Openmi".
 */
const PRODUCT_NAME = /^(?:Openmi(?: Auto| Code| V\d+)?|GPT-OSS 120B|DeepSeek V4\.1 Flash)$/;

export function getModelDisplayName(model?: string): string {
  if (!model) return "Openmi";
  return PRODUCT_NAME.test(model) ? model : "Openmi";
}

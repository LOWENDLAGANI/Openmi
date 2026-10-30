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
}

export const OPENMI_MODES: ModeOption[] = [
  {
    id: "auto",
    name: "Auto",
    display: "Openmi Auto",
    separateSession: false,
  },
  {
    id: "code",
    name: "code",
    display: "GPT-OSS 120B",
    separateSession: true,
  },
  {
    // The id names the capability, like "code" does, rather than the vendor:
    // this module is compiled into the browser, and a mode id is not a place a
    // provider name may appear. The display name is the one sanctioned place.
    id: "flash",
    name: "Flash",
    display: "DeepSeek V4.1 Flash",
    separateSession: true,
  },
];

// ── The picker's categories ───────────────────────────────────────────────────
//
// The menu no longer leads with three model names. A person choosing a model is
// really choosing how much they want spent on an answer, so the menu asks that
// question first: Efficient, Balanced, Advanced. Each category holds exactly one
// model today, and picking the category reveals it rather than applying it —
// the model is still the thing that runs, and it stays visible so the choice is
// never a label with an unnamed engine behind it.
//
// The mapping lives here, next to the models themselves, because it is product
// copy and pricing shaped as data: the composer, the menu and the tests all read
// one list instead of three that can drift.

export type ModeCategoryId = "efficient" | "balanced" | "advanced";

export interface ModeCategory {
  id: ModeCategoryId;
  /** The word the menu shows first. */
  label: string;
  /** The one model this category offers. */
  mode: ModeId;
}

export const MODE_CATEGORIES: ModeCategory[] = [
  {
    id: "efficient",
    label: "Efficient",
    mode: "auto",
  },
  {
    id: "balanced",
    label: "Balanced",
    mode: "code",
  },
  {
    id: "advanced",
    label: "Advanced",
    mode: "flash",
  },
];

/** The category a model belongs to, so the menu can open on the current one. */
export function categoryOfMode(id: string): ModeCategory {
  const mode = getMode(id).id;
  return MODE_CATEGORIES.find((category) => category.mode === mode) ?? MODE_CATEGORIES[0];
}

export const DEFAULT_MODE_ID: ModeId = "auto";

/**
 * What a mode's model accepts as input besides text.
 *
 * Declared in this catalog rather than beside the provider config because the
 * composer has to answer "may I attach this?" before a request exists, and this
 * module is the only model catalog the browser is allowed to import.
 *
 * Auto routes to a multimodal model first, so it keeps image input. Code and
 * Flash are pinned to text-only models: an image offered to them is either
 * rejected upstream or silently ignored, and both are worse than refusing it
 * with a reason the person can read.
 */
export interface ModeCapabilities {
  /** Image input, i.e. vision. */
  images: boolean;
  /** Text and code files, extracted to text in the browser. */
  documents: boolean;
}

export const MODE_CAPABILITIES: Record<ModeId, ModeCapabilities> = {
  auto: { images: true, documents: true },
  code: { images: false, documents: true },
  flash: { images: false, documents: true },
};

/** The attachment contract for a mode id, defaulting to Auto's. */
export function modeCapabilities(id: string): ModeCapabilities {
  return MODE_CAPABILITIES[getMode(id).id];
}

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

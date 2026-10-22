// ── Brand ─────────────────────────────────────────────────────────────────────
//
// One place for the product's name and voice. The overhaul is mid-flight and the
// final name is not chosen yet, so nothing user-facing should hard-code it while
// the product is being renamed: change it here.
//
// "Openmi" is kept as the working name so the shell, storage keys and existing
// accounts keep working. Renaming later is a string change plus a storage-key
// migration, not a code change.

export const BRAND = {
  /** Short name, as it appears in the sidebar and the page title. */
  name: "Openmi",
  /** What this product is, in two words. */
  product: "Repo Agent",
  /** One sentence, used on the landing screen and in metadata. */
  tagline: "An agent that reads your repository — and commits only when you say so.",
  /** The currency. */
  currency: "Dew",
} as const;

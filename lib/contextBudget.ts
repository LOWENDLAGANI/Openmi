// ── Context budget ───────────────────────────────────────────────────────────
// "How full is this conversation?" answered against the budget the server
// actually enforces — never a provider's context window. The window is not the
// limit Openmi refuses on, and naming it would put a vendor's number in the
// browser for no benefit.
//
// Pure functions only: the ring, the popover and the tests all read the same
// arithmetic, so a percentage on screen cannot disagree with the warning that
// fires.

import { estimateTokenUsage } from "./dew";

/**
 * The per-request budget, in tokens.
 *
 * The same order of magnitude as the cap enforced in `app/api/chat/route.ts`
 * (120 messages, 32k characters each, 200k total). It is a product number: it
 * describes what Openmi will send in one request, not what any model can hold.
 */
export const CONTEXT_BUDGET = 30_000;

/** At or above this, the ring turns amber: finish the thought, plan a new chat. */
export const CONTEXT_WARN_PERCENT = 70;

/** At or above this, the ring turns red and offers a fresh chat. */
export const CONTEXT_FULL_PERCENT = 90;

/**
 * What one attached image is assumed to cost.
 *
 * Vision input is not character-countable, so this is an estimate on purpose and
 * the popover says so. It is deliberately generous: under-counting is what makes
 * a warning arrive after the refusal.
 */
export const IMAGE_TOKEN_ESTIMATE = 750;

export type ContextLevel = "empty" | "ok" | "warn" | "full";

/** One named slice of the numerator, for the popover. */
export interface ContextPart {
  label: string;
  tokens: number;
}

export interface ContextUsage {
  used: number;
  remaining: number;
  budget: number;
  percent: number;
  level: ContextLevel;
  /** Only the slices that are non-zero, in reading order. */
  parts: ContextPart[];
}

/** Rough token count for prose. The same 4-chars heuristic the server uses. */
export function estimateTokens(text: string): number {
  return text.trim() ? estimateTokenUsage(text).completion : 0;
}

/** A percentage a ring can draw: whole, finite, and inside 0–100. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Used ÷ budget as a whole percentage, clamped. A bad budget reads as 0%. */
export function contextPercent(used: number, budget: number = CONTEXT_BUDGET): number {
  if (!Number.isFinite(used) || !Number.isFinite(budget) || budget <= 0) return 0;
  return clampPercent((used / budget) * 100);
}

export function contextLevel(percent: number): ContextLevel {
  if (percent >= CONTEXT_FULL_PERCENT) return "full";
  if (percent >= CONTEXT_WARN_PERCENT) return "warn";
  return percent > 0 ? "ok" : "empty";
}

/** "25k", "1.2k", "840" — short enough to sit beside a ring. */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  // One decimal below 10k (1_200 → "1.2k"), whole numbers above (25_400 → "25k").
  return `${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
}

export interface ContextInput {
  /**
   * The last completed request's actual prompt tokens.
   *
   * This is the honest part of the numerator: it is what the server sent, so it
   * already includes the system prompt, the conversation, and any web or
   * repository context that turn carried.
   */
  usedTokens?: number | null;
  /** Whatever is sitting in the composer right now, not yet sent. */
  draftText?: string;
  images?: number;
  documentChars?: number;
  budget?: number;
}

/**
 * The ring's number: the last request's real prompt count plus an estimate of
 * what is queued in the composer. Never negative, never above the budget.
 *
 * The estimate is additive rather than a replacement: a 25k-token conversation
 * is 25k whether or not anything is typed, and typing "fix it" should not make
 * the ring jump backwards.
 */
export function estimateContextUsage(input: ContextInput = {}): ContextUsage {
  const budget =
    typeof input.budget === "number" && Number.isFinite(input.budget) && input.budget > 0
      ? input.budget
      : CONTEXT_BUDGET;
  const sent = Math.max(0, Math.round(input.usedTokens ?? 0));
  const draft = estimateTokens(input.draftText ?? "");
  const images = Math.max(0, Math.round(input.images ?? 0));
  const attachments = images * IMAGE_TOKEN_ESTIMATE + Math.round(Math.max(0, input.documentChars ?? 0) / 4);
  const used = sent + draft + attachments;
  const percent = contextPercent(used, budget);
  const parts = [
    { label: "Last request", tokens: sent },
    { label: "Draft", tokens: draft },
    { label: "Attachments", tokens: attachments },
  ].filter((part) => part.tokens > 0);

  return {
    used,
    remaining: Math.max(0, budget - used),
    budget,
    percent,
    level: contextLevel(percent),
    parts,
  };
}

/**
 * What a screen reader hears for the ring. Numbers, not adjectives: "nearly
 * full" is a judgement, and the percentage is the fact somebody can act on.
 */
export function contextLabel(usage: ContextUsage): string {
  const budget = usage.budget.toLocaleString("en-US");
  if (usage.used <= 0) return `Context is empty. The budget is ${budget} tokens per request.`;
  return `Context ${usage.percent}% used: about ${usage.used.toLocaleString("en-US")} of ${budget} tokens per request.`;
}

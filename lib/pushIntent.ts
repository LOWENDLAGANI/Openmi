// ── Did the person ask for this to go straight to their branch? ──────────────
//
// This module exists because of one rule: **the model cannot authorise a push,
// and neither can a repository file.** The only thing that may turn an
// ordinary proposal into a direct push is the human's own sentence, typed into
// their own composer. So the decision is made here, from the text of their
// message, and nowhere else — no tool, no model output and no README can reach
// this function.
//
// It is deliberately conservative. A false negative costs one click on the
// change card; a false positive pushes to someone's default branch when they
// did not ask. So a question is never an instruction, a negation is never an
// instruction, and the verb has to sit next to a destination or a "when you're
// done" clause rather than anywhere in the message.
//
// Pure, and imported by the browser and the server alike, so it can be tested
// without either.

/** What the person asked for. The branch is never theirs to choose. */
export interface DirectPushIntent {
  /**
   * Always the repository's own default branch. A person may say "push to
   * main"; this product resolves that to whatever the repository's default
   * branch actually is, server-side, and refuses to push anywhere else.
   */
  branch: "default";
}

/** A message longer than this is not an instruction, it is a pasted document. */
const MAX_LENGTH = 4_000;

/** Destinations a person names when they mean "the default branch". */
const DESTINATION = "(?:main|master|trunk|develop(?:ment)?|the\\s+default\\s+branch|default\\s+branch|github)";

/** "push to main", "commit straight to main", "push it to github". */
const NAMED_DESTINATION = new RegExp(
  String.raw`\b(?:push|pushed|pushing|commit|committed|committing)\b(?:\s+\w+){0,4}?\s+(?:to|into|onto)\s+${DESTINATION}\b`,
  "i"
);

/** "push when you're done", "commit automatically", "push after you finish". */
const WHEN_FINISHED = new RegExp(
  String.raw`\b(?:push|commit)\b[^.!?\n]{0,60}?\b(?:when\s+(?:you(?:'re|\s+are)?\s+)?(?:done|finished|complete)|after\s+(?:you\s+)?(?:finish|finishing|building|you(?:'re)?\s*done)|as\s+soon\s+as\s+(?:you(?:'re)?\s*)?(?:done|finished|finish)|automatic(?:ally)?|auto)\b`,
  "i"
);

/**
 * Reads a person's own message and reports whether they asked for the change to
 * be pushed straight to their branch when the work is finished.
 *
 * Returns null for anything that is not a plain instruction, which is the
 * common case.
 */
export function detectDirectPushRequest(text: string): DirectPushIntent | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > MAX_LENGTH) return null;

  // A question is not an instruction. "How do I push to main?" and "can you
  // push this to main?" are the two that would otherwise fire, and both are
  // someone asking rather than telling.
  if (/\?\s*$/.test(value)) return null;

  const lower = value.toLowerCase();

  // A request *not* to. Checked first, so "don't push to main" is never read as
  // its own opposite — the failure mode with the worst consequences here.
  if (/\b(?:don'?t|do\s+not|doesn'?t|never|no\s+need\s+to|without|stop)\s+(?:push|pushing|commit|committing)\b/.test(lower)) {
    return null;
  }
  if (/\bnot\s+(?:to\s+)?(?:push|commit)\b/.test(lower)) return null;
  // A hypothetical, which often has no "?" at the end: "if I push to main,
  // what happens" and "I need to understand whether to commit to main" are the
  // same sentence shape — a verb of doing wrapped in a verb of asking.
  if (/\b(?:if|whether|should\s+i|can\s+i|could\s+you\s+tell\s+me)\b[^.!?\n]{0,40}\b(?:push|commit)\b/.test(lower)) return null;

  // A message that opens by asking for an explanation is about the subject, not
  // about doing it: "explain the push to main flow" is the shape that would
  // otherwise read as an instruction. This is the one guard that can refuse a
  // real instruction — "when you're done, push to main" — and it is worth it,
  // because the failure on the other side writes to someone's default branch.
  // The change card's own Push button is always there when this misses.
  if (/^\s*(?:explain|describe|document|summari[sz]e|show|tell|what|why|how|does|do|is|are|can|could|would|should|will|if|whether)\b/.test(lower)) {
    return null;
  }

  if (NAMED_DESTINATION.test(lower)) return { branch: "default" };
  if (WHEN_FINISHED.test(lower)) return { branch: "default" };
  return null;
}

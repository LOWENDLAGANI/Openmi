// ── What the chat says when a turn fails ────────────────────────────────────
//
// The server writes its refusals as sentences with an action in them: "apply
// this migration", "set this key". The chat used to fold anything longer than
// 200 characters back into "Something went wrong. Please try again." — which is
// about the length of a sentence that has to name a migration file, so the
// errors a person could fix became the one they could not. The run-start
// refusals are 290 and 322 characters; the older insert error was 159, and that
// is the only reason it ever appeared in the thread.
//
// So the test is what a message *is*, not how long it is: a response body, an
// HTML page or a stack trace is hidden, and a sentence is shown. Kept out of the
// page component so a test can pin it against the real server sentences.

/** What a person reads when nothing better can be said. */
const GENERIC = "Something went wrong. Please try again.";

/** The length past which a message is a dump rather than prose. */
const PAYLOAD_LENGTH = 600;

/**
 * True when a message is machine output rather than something written for a
 * person: a JSON body, an HTML error page, or a stack frame.
 *
 * Deliberately not a prose length limit — the longest sentence this app writes
 * is around 350 characters, and it is the most useful one it has.
 */
export function looksLikePayload(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (text.includes('{"') || text.includes("[{")) return true;
  if (text.startsWith("<")) return true;
  if (/\n\s*at\s+\S+/.test(text)) return true;
  return text.length > PAYLOAD_LENGTH;
}

/**
 * The message shown for a failed turn.
 *
 * The friendly mappings come first because they are the common causes; a server
 * sentence that matches none of them is shown verbatim, since it names the
 * migration or the variable to change.
 */
export function sanitizeError(error: unknown): string {
  if (typeof error === "string") {
    const msg = error.trim();
    if (!msg) return GENERIC;
    const lower = msg.toLowerCase();
    if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
      return "Connection issue. Please check your internet and try again.";
    }
    if (lower.includes("timeout")) {
      return "The request timed out. Please try again.";
    }
    if (lower.includes("unauthorized") || lower.includes("401")) {
      return "Something went wrong with authentication. Please try signing in again.";
    }
    if (lower.includes("rate limit")) {
      return "Too many requests. Please wait a moment and try again.";
    }
    if (looksLikePayload(msg)) return GENERIC;
    return msg;
  }
  if (error instanceof Error) return sanitizeError(error.message);
  return GENERIC;
}

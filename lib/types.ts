// ── Openmi shared types ────────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";
export type SearchMode = "auto" | "always" | "off";

export interface SearchSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface ImageAttachment {
  /** base64 data URL (image/jpeg after client-side compression) */
  url: string;
  name: string;
  size: number;
}

/** An image produced by the image model, stored locally like any attachment. */
export interface GeneratedImage {
  /** base64 data URL of the generated image */
  url: string;
  /** the prompt that produced it */
  prompt: string;
  mime: string;
  model: string;
  createdAt: number;
}

export interface DocumentAttachment {
  /** Plain text extracted from a supported text/code file. */
  name: string;
  size: number;
  text: string;
  truncated?: boolean;
}

/**
 * One read the agent made while answering, as shown in the thread.
 *
 * Deliberately not the raw tool call: a timeline that says `read
 * src/app/page.tsx` is what a person needs to see, while the JSON arguments
 * and the whole file the tool returned belong in the transcript, not on screen.
 */
export interface AgentStep {
  /** `propose_edits` is a proposal, not a write: the label says what was staged. */
  tool: "list_files" | "read_file" | "search_code" | "propose_edits";
  label: string;
  ok: boolean;
  /**
   * Why a tool refused the call, in the server's own words.
   *
   * A proposal that staged nothing is the one refusal a reader can act on —
   * the edit matched twice, the path was wrong, the file was too large — so
   * the reasons travel with the step instead of living only in the model's
   * transcript. Empty for a successful step.
   */
  detail?: string;
  /**
   * True while the tool is still running. Live-only: a step loaded from the
   * database or the account is always finished, so this is never trusted
   * across a reload.
   */
  running?: boolean;
}

/**
 * One file of a proposed change, as the review screen sees it.
 *
 * Deliberately without the resulting file contents: a reviewer is judging a
 * diff, and shipping the whole new file to the browser would let the screen
 * show something other than what would be committed.
 */
export interface ChangeSetFileView {
  path: string;
  kind: "modified" | "created";
  added: number;
  removed: number;
  /** Unified diff, computed on the server from the base commit's own bytes. */
  diff: string;
}

export interface ChangeSetView {
  id: string;
  repoFullName: string;
  baseSha: string;
  branch: string;
  message: string;
  status: "proposed" | "approved" | "committed" | "stale";
  createdAt: number;
  files: ChangeSetFileView[];
}

/**
 * One thing the pre-flight review wants a reader to know about a proposal.
 *
 * `error` is the review's claim that the change would not work; `warning` is
 * "look at this". The severity is what decides whether the agent repairs its
 * own proposal before the review screen is ever shown.
 */
export interface ReviewFinding {
  path: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * The result of checking a proposal before it is handed over.
 *
 * Two passes feed it: deterministic checks over the exact bytes (`static`) and
 * one model read of the diff. `modelChecked` is false when only the first ran,
 * so a review never implies a second opinion it did not get, and `repaired` is
 * true when the agent was sent back to fix what was found.
 */
export interface ProposalReview {
  verdict: "pass" | "fix";
  summary: string;
  findings: ReviewFinding[];
  modelChecked: boolean;
  repaired: boolean;
  checkedAt: number;
}

/** The answer to a successful commit: branch, sha, and where to review it. */
export interface CommitResult {
  sha: string;
  branch: string;
  prUrl: string | null;
  at: number;
  /** True for a repeat submit that found the first commit already made. */
  alreadyCommitted: boolean;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: Role;
  content: string;
  /** Read-only work the repository agent did for this answer. */
  steps?: AgentStep[];
  /**
   * The change set this answer proposed, if any. The review card is rendered
   * from it, which is why it is stored on the message rather than kept in
   * memory: closing the tab must not orphan a proposal the user can no longer
   * find, review or commit.
   */
  changesetId?: string;
  /**
   * The pre-flight review of that change. Live-only: the change set is the
   * durable record, so a reloaded conversation shows the diff without it.
   */
  review?: ProposalReview;
  images?: ImageAttachment[];
  /** set when the message was produced by the image model rather than chat */
  generatedImages?: GeneratedImage[];
  documents?: DocumentAttachment[];
  model?: string;
  searchQuery?: string;
  sources?: SearchSource[];
  /** tokens billed for this completion, when reported by the API */
  usage?: { prompt: number; completion: number; total: number };
  /**
   * The model stopped because it reached its output limit, so the answer is
   * incomplete. This is not the same as a short answer and must not be shown as
   * one — a truncated file looks exactly like a finished one until you say so.
   */
  truncated?: boolean;
  error?: string;
  /**
   * Earlier versions of this answer, newest previous first.
   *
   * A retry or an edit used to delete the answer it replaced. It now keeps it:
   * the answer being replaced is the one the new answer is judged against, and
   * throwing it away means the comparison can never be made. `content` still
   * holds the live answer — see lib/variants.ts for the whole rule.
   */
  variants?: string[];
  /** Which answer is on screen: absent or 0 is the live one, k is variants[k - 1]. */
  variantIndex?: number;
  createdAt: number;
  updatedAt?: number;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Folder this chat sits under in the sidebar, or nothing for unfiled. */
  folder?: string;
}

/** A user-named folder for chats. It follows the account, like the chats. */
export interface ChatFolder {
  id: string;
  name: string;
  createdAt: number;
  /** When the name last changed, so a rename on another device can win. */
  updatedAt?: number;
}

/**
 * One thing Openmi is told to remember between conversations.
 *
 * Deliberately a flat list of short sentences rather than a document store or
 * a vector index. The whole list is injected into every request, so it is read
 * constantly and must be cheap to reason about — and when an answer comes back
 * wrong, being able to read the entire memory in one glance is what makes the
 * cause findable. A retrieval system would hide the very thing beingdebugged.
 *
 * Capture is manual. Nothing here is written by a model on its own initiative:
 * a fact Openmi decided to remember is a fact nobody reviewed, and a wrong one
 * is worse than none because it is confidently applied forever.
 */
export interface Memory {
  id: string;
  /** One sentence, in the user's own words. */
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** Multimodal content shape sent to a provider's OpenAI-compatible endpoint. */
export type ApiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ApiMessage {
  role: Role;
  content: string | ApiContentPart[];
}

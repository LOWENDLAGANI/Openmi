// ── A proposed change, from the proposal to the one commit that lands it ─────
//
// This module is the middle of Phase 2. `propose_edits` stages a change in
// memory (lib/agent/edits.ts); this turns that into a reviewable change set
// with an id, a branch and a hash; the approve endpoint signs it; the commit
// endpoint is the only code that writes to GitHub.
//
// Three properties make the commit invariant real rather than decorative:
//
//   1. The change set is signed by the server when it is proposed. The row in
//      the database is readable and writable by its owner (the rules have no
//      way to tell the server's own request from the browser's), so the row is
//      not the authority — the signature is. Rewriting the files in the row and
//      asking to commit produces a signature that does not verify.
//   2. The approval is signed over the *hash* of the content, the base commit,
//      the branch and the repository. An approval therefore cannot be moved to
//      another change, cannot survive the files being swapped, and cannot be
//      forged by writing a row.
//   3. The branch is derived here, never chosen by the caller, and must begin
//      with `agent/`. Commit refuses anything else.
//
// Everything below is pure except the small store functions at the end, which
// write through the caller's own token so row-level security remains
// the only place access is decided.

import { createHash } from "node:crypto";
import { clientForToken } from "./supabase";
import { digest, digestMatches, sign, turnKey, verify } from "./github/crypto";
import type { ChangeSetFileView, ChangeSetView, CommitResult } from "./types";
import type { StagedChange } from "./agent/edits";

/** A proposed change set is worth reviewing for half a day, not for ever. */
export const CHANGESET_TTL_MS = 6 * 60 * 60_000;
/** The longest commit message a change set may carry. */
export const MAX_COMMIT_MESSAGE = 160;
/** The most files one change set may contain. Mirrors the staging cap. */
export const MAX_CHANGESET_FILES = 12;

export type ChangeSetStatus = "proposed" | "approved" | "committed" | "stale";

/** One file in a change set: what changed, and the bytes to commit. */
export interface ChangeSetFile extends ChangeSetFileView {
  /** The complete file after the edit. Never shown as a diff; used to commit. */
  after: string;
}

export interface ChangeSet {
  v: 1;
  id: string;
  projectId: string;
  repoFullName: string;
  defaultBranch: string;
  /** The commit the change was computed against. A moved branch refuses. */
  baseSha: string;
  /** sha256 over the paths and their resulting contents. */
  hash: string;
  /** `agent/<slug>`, derived here. */
  branch: string;
  message: string;
  files: ChangeSetFile[];
  createdAt: number;
  /** Past this, the change is refused as stale rather than committed late. */
  exp: number;
  status: ChangeSetStatus;
  /** The server's signature over the fields above. The row's authority. */
  sig: string;
}

/** What the approve endpoint writes. The signature is the record that counts. */
export interface Approval {
  v: 1;
  changeSetId: string;
  repoFullName: string;
  baseSha: string;
  hash: string;
  branch: string;
  message: string;
  at: number;
  sig: string;
}

/** What a successful commit leaves behind, so a double submit reuses it. */
export interface CommitRecord {
  changeSetId: string;
  sha: string;
  branch: string;
  /** Empty when a pull request could not be opened. Never `null` (see below). */
  prUrl: string;
  at: number;
}

// ── Hashing and naming ──────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The hash of a change set's content.
 *
 * Paths are sorted so the same set of files hashes the same way regardless of
 * the order the model proposed them in, and each path covers its own bytes. A
 * file list with one byte changed anywhere produces a different hash, which is
 * what makes an approval unforgeable rather than merely recorded.
 */
export function changeSetHash(files: Array<{ path: string; after: string }>): string {
  const canonical = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\u0000${sha256(file.after)}`)
    .join("\n");
  return sha256(canonical);
}

/** A short, non-guessable id that is also stable for one proposed change. */
export function changeSetId(input: {
  projectId: string;
  baseSha: string;
  hash: string;
  createdAt: number;
}): string {
  return sha256(`${input.projectId}\n${input.baseSha}\n${input.hash}\n${input.createdAt}`).slice(0, 20);
}

/** True when a URL segment could be one of our change set ids. */
export function isChangeSetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{20}$/.test(value);
}

/**
 * The branch a change set is committed to.
 *
 * Derived from the repository and the id, so it is stable for one change, short
 * enough to read, valid as a Git ref, and impossible for a caller to point at
 * `main`. The `agent/` prefix is the policy in §2 of the spec, expressed as code
 * rather than as a convention: `commitChanges` refuses any other prefix.
 */
export function branchFor(repoFullName: string, id: string): string {
  const name = repoFullName.split("/")[1] ?? "repo";
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "repo";
  return `agent/${slug}-${id.slice(0, 6)}`;
}

/** The commit message, derived from the files rather than supplied by a model. */
export function messageFor(files: Array<{ path: string }>): string {
  if (files.length === 0) return "Openmi: no files changed";
  const first = files[0]!.path;
  const base =
    files.length === 1
      ? `Openmi: update ${first}`
      : `Openmi: update ${files.length} files (${first} +${files.length - 1} more)`;
  return base.slice(0, MAX_COMMIT_MESSAGE);
}

// ── Building ────────────────────────────────────────────────────────────────

/** The immutable fields a change set is signed over. Status is not one. */
interface SignedFields {
  v: 1;
  id: string;
  projectId: string;
  repoFullName: string;
  defaultBranch: string;
  baseSha: string;
  hash: string;
  branch: string;
  message: string;
  files: ChangeSetFile[];
  createdAt: number;
  exp: number;
}

/**
 * The exact object the signature covers.
 *
 * One function builds it on the way in and on the way out, because an HMAC over
 * JSON is over a *string*: the same values with the fields in a different order
 * produce a different signature. Building it in two places is how a change set
 * that was signed a moment ago fails to verify a moment later — which is exactly
 * what an earlier version of this file did with `normalizeFile`'s key order.
 */
function signedFields(input: SignedFields): SignedFields {
  return {
    v: 1,
    id: input.id,
    projectId: input.projectId,
    repoFullName: input.repoFullName,
    defaultBranch: input.defaultBranch,
    baseSha: input.baseSha,
    hash: input.hash,
    branch: input.branch,
    message: input.message,
    files: input.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      added: file.added,
      removed: file.removed,
      diff: file.diff,
      after: file.after,
    })),
    createdAt: input.createdAt,
    exp: input.exp,
  };
}

export interface BuildInput {
  project: { id: string; repoFullName: string; defaultBranch: string; baseSha: string };
  proposals: StagedChange[];
  now?: number;
}

/**
 * Turns this step's proposals into a signed change set.
 *
 * Returns null when there is nothing to review. The caller stores the result;
 * a failure to store is not a failure to propose — the review screen simply
 * cannot offer a commit, and says so.
 */
export function buildChangeSet(input: BuildInput): ChangeSet | null {
  const files: ChangeSetFile[] = input.proposals
    .slice(0, MAX_CHANGESET_FILES)
    .map((proposal) => ({
      path: proposal.path,
      kind: proposal.kind,
      added: proposal.added,
      removed: proposal.removed,
      diff: proposal.diff,
      after: proposal.after,
    }))
    // An empty set after filtering is not a review; it is a no-op.
    .filter((file) => file.path && file.after.length > 0 && file.diff.length > 0);
  if (files.length === 0) return null;

  const now = input.now ?? Date.now();
  const hash = changeSetHash(files);
  const id = changeSetId({ projectId: input.project.id, baseSha: input.project.baseSha, hash, createdAt: now });
  const branch = branchFor(input.project.repoFullName, id);
  // The signature covers everything except `status`. Status is the lifecycle
  // label the endpoints move through (proposed → approved → committed), and
  // signing it would make every one of those writes invalidate the change. It
  // is not authority: whether a commit may proceed is decided by the approval
  // signature and the branch head, never by this field alone.
  const signed = signedFields({
    v: 1,
    id,
    projectId: input.project.id,
    repoFullName: input.project.repoFullName,
    defaultBranch: input.project.defaultBranch,
    baseSha: input.project.baseSha,
    hash,
    branch,
    message: messageFor(files),
    files,
    createdAt: now,
    exp: now + CHANGESET_TTL_MS,
  });
  // A digest, not a signed envelope: the payload is the row's own columns, and
  // a signature that repeated the file contents would grow with every change
  // (and, at the reader's size cap, stop verifying — see `normalizeChangeSet`).
  return { ...signed, status: "proposed", sig: digest(signed, turnKey()) };
}

// ── Verifying ───────────────────────────────────────────────────────────────

function isString(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.length <= max;
}

function normalizeFile(raw: unknown): ChangeSetFile | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!isString(value.path, 400) || !value.path) return null;
  if (value.kind !== "modified" && value.kind !== "created") return null;
  if (!isString(value.diff, 200_000) || !value.diff) return null;
  if (!isString(value.after, 400_000)) return null;
  if (typeof value.added !== "number" || typeof value.removed !== "number") return null;
  return {
    path: value.path,
    kind: value.kind,
    diff: value.diff,
    after: value.after,
    added: Math.max(0, Math.floor(value.added)),
    removed: Math.max(0, Math.floor(value.removed)),
  };
}

/**
 * Reads one stored change set and proves it is the server's own.
 *
 * The shape is validated first (a database row is untrusted input like any
 * other), then the signature, then the hash recomputed from the files. All
 * three have to agree: a row whose files were edited after the fact fails the
 * hash even though it still carries a valid signature over different bytes.
 */
export function normalizeChangeSet(raw: unknown): ChangeSet | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1) return null;
  if (!isChangeSetId(value.id)) return null;
  if (!isString(value.projectId, 40) || !value.projectId) return null;
  if (!isString(value.repoFullName, 140) || !value.repoFullName) return null;
  if (!isString(value.defaultBranch, 120) || !value.defaultBranch) return null;
  if (!isString(value.baseSha, 64) || !/^[0-9a-f]{40}$/i.test(value.baseSha)) return null;
  if (!isString(value.hash, 64) || !/^[0-9a-f]{64}$/i.test(value.hash)) return null;
  if (!isString(value.branch, 120) || !/^agent\/[A-Za-z0-9._-]+$/.test(value.branch)) return null;
  if (!isString(value.message, MAX_COMMIT_MESSAGE) || !value.message) return null;
  if (typeof value.createdAt !== "number" || typeof value.exp !== "number") return null;
  if (value.status !== "proposed" && value.status !== "approved" && value.status !== "committed" && value.status !== "stale") {
    return null;
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_CHANGESET_FILES) return null;
  if (!isString(value.sig, 64) || !/^[0-9a-f]{64}$/.test(value.sig)) return null;

  const files = value.files.map(normalizeFile);
  if (files.some((file) => file === null)) return null;
  const typed = files as ChangeSetFile[];

  // The branch is derived, not stored authority: a row that names a different
  // branch than its own id and repository produce is refused.
  if (value.branch !== branchFor(value.repoFullName, value.id)) return null;
  // The hash has to describe these files. This is what stops a rewrite of the
  // row's contents being approved as if the server had proposed it.
  if (value.hash !== changeSetHash(typed)) return null;

  // The digest covers the whole immutable payload, so a copied signature
  // cannot ride on edited fields — a branch renamed, a base commit swapped, an
  // expiry pushed out. It is a fixed 64 characters whatever the files weigh,
  // which is the property the earlier signed-envelope form got wrong: the
  // envelope was as long as the diff, and the reader refused anything over
  // 4,000 characters, so every real file failed to verify.
  const payload = signedFields({
    v: 1,
    id: value.id,
    projectId: value.projectId,
    repoFullName: value.repoFullName,
    defaultBranch: value.defaultBranch,
    baseSha: value.baseSha,
    hash: value.hash,
    branch: value.branch,
    message: value.message,
    files: typed,
    createdAt: value.createdAt,
    exp: value.exp,
  });
  if (!digestMatches(payload, value.sig, turnKey())) return null;

  // Expiry is deliberately *not* checked here. A committed change set is worth
  // reading long after it stopped being committable — that is how a reopened
  // review card still shows the commit — and the decision to refuse a late
  // commit belongs in `commitGate`, where it says why.
  return { ...payload, status: value.status, sig: value.sig as string };
}

/** The signature over an approval. Binds the approval to one exact change. */
function approvalPayload(input: Omit<Approval, "v" | "sig">) {
  return {
    v: 1 as const,
    changeSetId: input.changeSetId,
    repoFullName: input.repoFullName,
    baseSha: input.baseSha,
    hash: input.hash,
    branch: input.branch,
    message: input.message,
    at: input.at,
  };
}

/** Writes the approval the commit endpoint will later require. */
export function signApproval(changeSet: ChangeSet, now = Date.now()): Approval {
  const payload = approvalPayload({
    changeSetId: changeSet.id,
    repoFullName: changeSet.repoFullName,
    baseSha: changeSet.baseSha,
    hash: changeSet.hash,
    branch: changeSet.branch,
    message: changeSet.message,
    at: now,
  });
  return { ...payload, sig: sign(payload, turnKey()) };
}

/** Reads a stored approval and proves the server wrote it. */
export function normalizeApproval(raw: unknown): Approval | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1) return null;
  if (!isChangeSetId(value.changeSetId)) return null;
  if (!isString(value.repoFullName, 140) || !value.repoFullName) return null;
  if (!isString(value.baseSha, 64) || !/^[0-9a-f]{40}$/i.test(value.baseSha)) return null;
  if (!isString(value.hash, 64) || !/^[0-9a-f]{64}$/i.test(value.hash)) return null;
  if (!isString(value.branch, 120) || !/^agent\/[A-Za-z0-9._-]+$/.test(value.branch)) return null;
  if (!isString(value.message, MAX_COMMIT_MESSAGE) || !value.message) return null;
  if (typeof value.at !== "number") return null;
  if (!isString(value.sig, 4000)) return null;

  const payload = approvalPayload({
    changeSetId: value.changeSetId,
    repoFullName: value.repoFullName,
    baseSha: value.baseSha,
    hash: value.hash,
    branch: value.branch,
    message: value.message,
    at: value.at,
  });
  const verified = verify<unknown>(value.sig as string, turnKey());
  if (!verified || JSON.stringify(verified) !== JSON.stringify(payload)) return null;
  return { ...payload, sig: value.sig as string };
}

/** Reads a stored commit record. Shape only: it is not authority, it is cache. */
export function normalizeCommit(raw: unknown): CommitRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!isChangeSetId(value.changeSetId)) return null;
  if (!isString(value.sha, 64) || !/^[0-9a-f]{40}$/i.test(value.sha)) return null;
  if (!isString(value.branch, 120) || !value.branch) return null;
  if (typeof value.at !== "number") return null;
  return {
    changeSetId: value.changeSetId,
    sha: value.sha,
    branch: value.branch,
    // The database does not store nulls, so a missing PR is an empty string.
    prUrl: typeof value.prUrl === "string" ? value.prUrl.slice(0, 300) : "",
    at: value.at,
  };
}

// ── The commit gate ─────────────────────────────────────────────────────────
//
// Everything that can be decided without talking to GitHub lives here, so the
// route stays a sequence of network calls and the rules are testable without a
// fake for the world.

export type GateResult =
  | { ok: true; alreadyCommitted: CommitRecord | null }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * Decides whether a commit may proceed.
 *
 * `changeSet` and `approval` must already have passed their signature checks;
 * a caller that skipped them cannot use this to authorise anything, because
 * both are null when verification failed.
 */
export function commitGate(input: {
  changeSet: ChangeSet | null;
  approval: Approval | null;
  existingCommit: CommitRecord | null;
  now?: number;
}): GateResult {
  const { changeSet, approval, existingCommit } = input;
  const now = input.now ?? Date.now();

  if (!changeSet) {
    return {
      ok: false,
      status: 409,
      error: "This change is no longer valid. Ask the agent to propose it again.",
      detail: "unverified",
    };
  }
  // A repeat submit after a success is answered with the commit that already
  // exists. It is checked before the approval so a retry that lost its approval
  // row still reports the truth instead of refusing a change that landed.
  if (existingCommit && existingCommit.changeSetId === changeSet.id) {
    return { ok: true, alreadyCommitted: existingCommit };
  }
  if (!changeSet.sig) {
    return { ok: false, status: 409, error: "This change is not signed.", detail: "unverified" };
  }
  if (changeSet.exp <= now) {
    return {
      ok: false,
      status: 409,
      error: "This proposal has expired. Ask the agent to propose the change again.",
      detail: "expired",
    };
  }
  if (!changeSet.branch.startsWith("agent/")) {
    return {
      ok: false,
      status: 403,
      error: "Openmi only commits to agent/ branches.",
      detail: "branch",
    };
  }
  if (changeSet.status === "committed") {
    return existingCommit
      ? { ok: true, alreadyCommitted: existingCommit }
      : {
          ok: false,
          status: 409,
          error: "This change set is already committed, but its commit record could not be read.",
          detail: "committed",
        };
  }
  if (changeSet.status !== "approved") {
    return {
      ok: false,
      status: 403,
      error: "Approve this change before committing it.",
      detail: "not-approved",
    };
  }
  if (!approval) {
    return {
      ok: false,
      status: 403,
      error: "There is no approval for this change. Approve it first.",
      detail: "no-approval",
    };
  }
  const mismatched =
    approval.changeSetId !== changeSet.id ||
    approval.hash !== changeSet.hash ||
    approval.baseSha !== changeSet.baseSha ||
    approval.branch !== changeSet.branch ||
    approval.repoFullName !== changeSet.repoFullName;
  if (mismatched) {
    return {
      ok: false,
      status: 409,
      error: "This approval belongs to a different version of the change. Review it again.",
      detail: "approval-mismatch",
    };
  }
  return { ok: true, alreadyCommitted: null };
}

// ── Storage ─────────────────────────────────────────────────────────────────
//
// Every row is in the caller's own name, and every write goes through the
// caller's token, so the row-level security policies decide what may be written.
// The rows are an audit trail and a convenience; the signature is the authority
// — rewriting the `files` column and asking to commit produces a signature that
// does not verify, which is what makes the commit invariant real rather than
// decorative.

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

function ms(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function iso(value: number): string {
  return new Date(value > 0 ? value : Date.now()).toISOString();
}

/** One stored row, in the shape `normalizeChangeSet` validates. */
function changeSetFromRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return {
    v: 1,
    id: value.id,
    projectId: value.project_id,
    repoFullName: value.repo_full_name,
    defaultBranch: value.default_branch,
    baseSha: value.base_sha,
    hash: value.hash,
    branch: value.branch,
    message: value.message,
    files: value.files,
    createdAt: ms(value.created_at),
    exp: ms(value.expires_at),
    status: value.status,
    sig: value.signature,
  };
}

function approvalFromRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return {
    v: 1,
    changeSetId: value.changeset_id,
    repoFullName: value.repo_full_name,
    baseSha: value.base_sha,
    hash: value.hash,
    branch: value.branch,
    message: value.message,
    at: ms(value.created_at),
    sig: value.signature,
  };
}

function commitFromRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return {
    changeSetId: value.changeset_id,
    sha: value.sha,
    branch: value.branch,
    prUrl: value.pr_url,
    at: ms(value.created_at),
  };
}

export async function saveChangeSet(
  authorization: string | null,
  uid: string,
  changeSet: ChangeSet
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    const { error } = await client.from("changesets").upsert(
      {
        owner: uid,
        id: changeSet.id,
        project_id: changeSet.projectId,
        repo_full_name: changeSet.repoFullName,
        default_branch: changeSet.defaultBranch,
        base_sha: changeSet.baseSha,
        hash: changeSet.hash,
        branch: changeSet.branch,
        message: changeSet.message,
        files: changeSet.files,
        status: changeSet.status,
        expires_at: iso(changeSet.exp),
        signature: changeSet.sig,
        created_at: iso(changeSet.createdAt),
      },
      { onConflict: "owner,id" }
    );
    return !error;
  } catch {
    return false;
  }
}

export async function readChangeSet(
  authorization: string | null,
  uid: string,
  id: string
): Promise<ChangeSet | null> {
  if (!isChangeSetId(id)) return null;
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return null;
  try {
    const { data, error } = await client
      .from("changesets")
      .select(
        "id, project_id, repo_full_name, default_branch, base_sha, hash, branch, message, files, status, expires_at, signature, created_at"
      )
      .eq("owner", uid)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return normalizeChangeSet(changeSetFromRow(data));
  } catch {
    return null;
  }
}

/**
 * Rewrites a change set's status.
 *
 * A column update now rather than the read-modify-write the Realtime Database
 * REST API forced on this. The risk was a status write racing a commit, and it
 * was acceptable then for the same reason it is now harmless: the status is a
 * label on a review screen, while whether something *may* be committed is
 * decided by the approval signature and GitHub's own branch head.
 */
export async function setChangeSetStatus(
  authorization: string | null,
  uid: string,
  changeSet: ChangeSet,
  status: ChangeSetStatus
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    // `.select()` so a row the policies filtered reads as a failure rather than
    // as a write that never happened. PostgreSQL does not raise on a refused
    // UPDATE; it simply matches nothing.
    const { data, error } = await client
      .from("changesets")
      .update({ status })
      .eq("owner", uid)
      .eq("id", changeSet.id)
      .select("id");
    if (error) return false;
    return Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

export async function saveApproval(
  authorization: string | null,
  uid: string,
  approval: Approval
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    const { error } = await client.from("approvals").upsert(
      {
        owner: uid,
        changeset_id: approval.changeSetId,
        repo_full_name: approval.repoFullName,
        base_sha: approval.baseSha,
        hash: approval.hash,
        branch: approval.branch,
        message: approval.message,
        signature: approval.sig,
        created_at: iso(approval.at),
      },
      { onConflict: "owner,changeset_id" }
    );
    return !error;
  } catch {
    return false;
  }
}

export async function readApproval(
  authorization: string | null,
  uid: string,
  id: string
): Promise<Approval | null> {
  if (!isChangeSetId(id)) return null;
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return null;
  try {
    const { data, error } = await client
      .from("approvals")
      .select("changeset_id, repo_full_name, base_sha, hash, branch, message, signature, created_at")
      .eq("owner", uid)
      .eq("changeset_id", id)
      .maybeSingle();
    if (error || !data) return null;
    return normalizeApproval(approvalFromRow(data));
  } catch {
    return null;
  }
}

export async function saveCommit(
  authorization: string | null,
  uid: string,
  record: CommitRecord
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    const { error } = await client.from("commits").upsert(
      {
        owner: uid,
        changeset_id: record.changeSetId,
        sha: record.sha,
        branch: record.branch,
        pr_url: record.prUrl,
        created_at: iso(record.at),
      },
      { onConflict: "owner,changeset_id" }
    );
    return !error;
  } catch {
    return false;
  }
}

export async function readCommit(
  authorization: string | null,
  uid: string,
  id: string
): Promise<CommitRecord | null> {
  if (!isChangeSetId(id)) return null;
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return null;
  try {
    const { data, error } = await client
      .from("commits")
      .select("changeset_id, sha, branch, pr_url, created_at")
      .eq("owner", uid)
      .eq("changeset_id", id)
      .maybeSingle();
    if (error || !data) return null;
    return normalizeCommit(commitFromRow(data));
  } catch {
    return null;
  }
}

/** The review screen's view: diffs and counts, never the whole new file. */
export function viewOf(changeSet: ChangeSet): ChangeSetView {
  return {
    id: changeSet.id,
    repoFullName: changeSet.repoFullName,
    baseSha: changeSet.baseSha,
    branch: changeSet.branch,
    message: changeSet.message,
    status: changeSet.status,
    createdAt: changeSet.createdAt,
    files: changeSet.files.map<ChangeSetFileView>((file) => ({
      path: file.path,
      kind: file.kind,
      added: file.added,
      removed: file.removed,
      diff: file.diff,
    })),
  };
}

/** The commit endpoint's answer, in the shape the review screen renders. */
export function commitResult(record: CommitRecord, alreadyCommitted: boolean): CommitResult {
  return {
    sha: record.sha,
    branch: record.branch,
    prUrl: record.prUrl || null,
    at: record.at,
    alreadyCommitted,
  };
}

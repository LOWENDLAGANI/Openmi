// ── Projects ────────────────────────────────────────────────────────────────
//
// A project is a repository pinned at a commit. It is one row per user in the
// `projects` table, written with the caller's own token so the row-level
// security policies decide who may touch it.
//
// The pinned commit is the whole reason this is a record rather than a string in
// local storage: every read, every diff, and (later) every commit is based on it,
// so the version the agent saw is the version the reviewer is shown.

import { createHash } from "node:crypto";
import { clientForToken } from "./supabase";
import { getBranchHead, normalizeRepoFullName } from "./github/client";
import type { CommitPreference } from "./types";

export interface ProjectSummary {
  id: string;
  repoFullName: string;
  defaultBranch: string;
  /** The commit this project is read at. */
  baseSha: string;
  canPush: boolean;
  /** Where this project's commits go — or "ask" every time. */
  commitDestination: CommitPreference;
  addedAt: number;
  updatedAt: number;
}

const COMMIT_PREFERENCES: readonly CommitPreference[] = ["ask", "main", "pr", "branch"];

/** True when a stored value is one of the destinations the product offers. */
export function isCommitPreference(value: unknown): value is CommitPreference {
  return typeof value === "string" && (COMMIT_PREFERENCES as readonly string[]).includes(value);
}

/** A stable id for one repository. Scoped by the user path it is stored under. */
export function projectIdFor(fullName: string): string {
  return createHash("sha256").update(fullName.toLowerCase()).digest("hex").slice(0, 12);
}

/** True when a URL segment could be one of our project ids. */
export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}

/** Coerces one stored record, rejecting anything that is not a project. */
export function normalizeProject(raw: unknown): ProjectSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const fullName = normalizeRepoFullName(value.repoFullName);
  if (!fullName || typeof value.id !== "string" || !isProjectId(value.id)) return null;
  return {
    id: value.id,
    repoFullName: fullName,
    defaultBranch: typeof value.defaultBranch === "string" && value.defaultBranch ? value.defaultBranch : "main",
    baseSha: typeof value.baseSha === "string" ? value.baseSha : "",
    canPush: value.canPush === true,
    // An unknown value falls back to asking rather than guessing a destination:
    // the wrong guess would push to a branch the person did not choose.
    commitDestination: isCommitPreference(value.commitDestination) ? value.commitDestination : "ask",
    addedAt: typeof value.addedAt === "number" ? value.addedAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

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

/** One stored row, in the shape the project normaliser validates. */
function projectFromRow(row: unknown): ProjectSummary | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return normalizeProject({
    id: value.id,
    repoFullName: value.repo_full_name,
    defaultBranch: value.default_branch,
    baseSha: value.base_sha,
    canPush: value.can_push,
    commitDestination: value.commit_destination,
    addedAt: ms(value.added_at),
    updatedAt: ms(value.updated_at),
  });
}

/** Every project this account has attached, newest first. */
export async function listProjects(
  authorization: string | null,
  uid: string
): Promise<ProjectSummary[]> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return [];
  try {
    const { data, error } = await client
      .from("projects")
      .select("id, repo_full_name, default_branch, base_sha, can_push, commit_destination, added_at, updated_at")
      .eq("owner", uid)
      .order("updated_at", { ascending: false });
    if (error || !data) return [];
    return data.map(projectFromRow).filter((project): project is ProjectSummary => project !== null);
  } catch {
    return [];
  }
}

/**
 * One project, or null.
 *
 * Null covers three cases that the route cannot tell apart and does not need
 * to: no such project, not this user's, and the read was refused. All three
 * end in the same place — the project is not available — and none of them
 * leaks whether another account owns that id.
 */
export async function readProject(
  authorization: string | null,
  uid: string,
  id: string
): Promise<ProjectSummary | null> {
  if (!isProjectId(id)) return null;
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return null;
  try {
    const { data, error } = await client
      .from("projects")
      .select("id, repo_full_name, default_branch, base_sha, can_push, commit_destination, added_at, updated_at")
      .eq("owner", uid)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return projectFromRow(data);
  } catch {
    return null;
  }
}

/**
 * Brings a project's pinned commit up to the branch's current head.
 *
 * The pin is what the agent reads and what a proposal is based on. It used to
 * be taken once, when the repository was attached, and never moved: the first
 * push to the default branch — including merging the pull request Openmi itself
 * opened — then left every later proposal based on a commit that was no longer
 * the tip, so the review screen answered "main has moved since this change was
 * proposed" for a change that had just been made, every time, for ever.
 *
 * Refreshing before the agent reads makes a new proposal relative to the branch
 * as it is now. The commit endpoint's own comparison keeps its meaning, because
 * it asks the different question: has the branch moved since *this* proposal,
 * which is exactly the window a person is reviewing in.
 *
 * A head that cannot be read is not a reason to refuse the turn: the project is
 * returned as it was, and the commit endpoint still refuses a stale base.
 */
export async function refreshProjectHead(
  authorization: string | null,
  uid: string,
  project: ProjectSummary,
  token: string
): Promise<ProjectSummary> {
  if (!uid || !token) return project;
  try {
    const head = await getBranchHead(token, project.repoFullName, project.defaultBranch);
    if (!head || head === project.baseSha) return project;
    const updated: ProjectSummary = { ...project, baseSha: head, updatedAt: Date.now() };
    // Best effort: the turn runs against the head either way, and a failed row
    // write costs the next step another read, not a wrong proposal.
    await saveProject(authorization, uid, updated).catch(() => false);
    return updated;
  } catch {
    return project;
  }
}

/** Writes one project. False means the database refused. */
export async function saveProject(
  authorization: string | null,
  uid: string,
  project: ProjectSummary
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    const { error } = await client.from("projects").upsert(
      {
        owner: uid,
        id: project.id,
        repo_full_name: project.repoFullName,
        default_branch: project.defaultBranch,
        base_sha: project.baseSha,
        can_push: project.canPush,
        // `commit_destination` is deliberately not written here. A head refresh
        // saves a project it read a moment ago, and a general upsert would write
        // that stale answer over one the person saved in between. A new row gets
        // the column's default ('ask'); an existing row keeps whatever it has,
        // and only `setProjectCommitDestination` may change it.
        added_at: new Date(project.addedAt > 0 ? project.addedAt : Date.now()).toISOString(),
        updated_at: new Date(project.updatedAt > 0 ? project.updatedAt : Date.now()).toISOString(),
      },
      { onConflict: "owner,id" }
    );
    return !error;
  } catch {
    return false;
  }
}

/**
 * Remembers where this project's commits go — or forgets the answer.
 *
 * Separate from `saveProject` because the preference is the person's, not a
 * property refreshed from GitHub: a head refresh must never overwrite it, and
 * changing it must never need a repository read.
 */
export async function setProjectCommitDestination(
  authorization: string | null,
  uid: string,
  id: string,
  destination: CommitPreference
): Promise<boolean> {
  if (!isProjectId(id) || !isCommitPreference(destination)) return false;
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    // `.select()` so a row the policies filtered reads as a failure rather than
    // as a write that never happened.
    const { data, error } = await client
      .from("projects")
      .update({ commit_destination: destination, updated_at: new Date().toISOString() })
      .eq("owner", uid)
      .eq("id", id)
      .select("id");
    if (error) return false;
    return Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

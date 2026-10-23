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
import { normalizeRepoFullName } from "./github/client";

export interface ProjectSummary {
  id: string;
  repoFullName: string;
  defaultBranch: string;
  /** The commit this project is read at. */
  baseSha: string;
  canPush: boolean;
  addedAt: number;
  updatedAt: number;
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
      .select("id, repo_full_name, default_branch, base_sha, can_push, added_at, updated_at")
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
      .select("id, repo_full_name, default_branch, base_sha, can_push, added_at, updated_at")
      .eq("owner", uid)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return projectFromRow(data);
  } catch {
    return null;
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

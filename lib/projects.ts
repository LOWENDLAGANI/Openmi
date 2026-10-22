// ── Projects ────────────────────────────────────────────────────────────────
//
// A project is a repository pinned at a commit. It is stored per user, under
// `projects/{uid}/{id}`, written with the caller's own Firebase token so the
// database rules decide who may touch it.
//
// The pinned commit is the whole reason this is a record rather than a string in
// local storage: every read, every diff, and (later) every commit is based on it,
// so the version the agent saw is the version the reviewer is shown.

import { createHash } from "node:crypto";
import { readAsCaller } from "./rtdb";
import { writeAsCaller } from "./serverControl";
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

/** Every project this account has attached, newest first. */
export async function listProjects(
  authorization: string | null,
  uid: string
): Promise<ProjectSummary[]> {
  const stored = await readAsCaller<Record<string, unknown>>(authorization, `projects/${uid}`);
  return Object.values(stored ?? {})
    .map(normalizeProject)
    .filter((project): project is ProjectSummary => project !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
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
  const stored = await readAsCaller<unknown>(authorization, `projects/${uid}/${id}`);
  return normalizeProject(stored);
}

/** Writes one project. False means the database refused. */
export async function saveProject(
  authorization: string | null,
  uid: string,
  project: ProjectSummary
): Promise<boolean> {
  return writeAsCaller(authorization, `projects/${uid}/${project.id}`, project);
}

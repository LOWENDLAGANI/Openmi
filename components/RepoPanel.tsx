"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authHeader } from "@/lib/firebaseHistory";
import { linkGithubAccount } from "@/lib/githubLink";
import type { ProjectSummary } from "@/lib/projects";

// ── The repository workspace ────────────────────────────────────────────────
//
// Three states in one panel, in the order a new user meets them:
//
//   1. GitHub is not connected  → one button and a sentence about what it grants.
//   2. Connected, no project    → the repos this connection can see.
//   3. A project is attached    → the file tree the agent reads, and a viewer.
//
// The tree and the viewer are not a filesystem browser for its own sake: they
// show exactly the files the agent may read. When a file is not here, the agent
// cannot see it either, which makes the pane an honest picture of its knowledge.

interface RepoPanelProps {
  open: boolean;
  onClose: () => void;
  project: ProjectSummary | null;
  onSelectProject: (project: ProjectSummary | null) => void;
}

interface GithubStatus {
  configured: boolean;
  connected: boolean;
  login: string | null;
}

interface RepoItem {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
}

interface TreeFile {
  path: string;
  size: number;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await authHeader()),
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed (HTTP ${response.status})`);
  }
  return payload as T;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RepoPanel({ open, onClose, project, onSelectProject }: RepoPanelProps) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [tree, setTree] = useState<TreeFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api<GithubStatus>("/api/github/status");
      setStatus(next);
      return next;
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : "Could not check the GitHub connection.");
      return null;
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const data = await api<{ projects: ProjectSummary[] }>("/api/projects");
      setProjects(data.projects ?? []);
      return data.projects ?? [];
    } catch {
      // Not signed in yet, or no database: the picker still works from scratch.
      return [];
    }
  }, []);

  const loadRepos = useCallback(async () => {
    try {
      const data = await api<{ repos: RepoItem[] }>("/api/github/repos");
      setRepos(data.repos ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not list repositories.");
    }
  }, []);

  const loadTree = useCallback(async (projectId: string) => {
    setTree(null);
    setTruncated(false);
    try {
      const data = await api<{ files: TreeFile[]; truncated: boolean }>(`/api/projects/${projectId}/tree`);
      setTree(data.files ?? []);
      setTruncated(Boolean(data.truncated));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the repository tree.");
      setTree([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    void (async () => {
      const next = await loadStatus();
      const attached = await loadProjects();
      if (next?.connected) void loadRepos();
      // Select the most recent project if nothing is selected, so the panel
      // opens on the workspace rather than on a list of one item.
      if (!project && attached.length > 0) onSelectProject(attached[0]);
    })();
    // `project` is deliberately not a dependency: this effect is the "panel
    // opened" moment, and re-running it on every selection would refetch the
    // world each time a repo is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadStatus, loadProjects, loadRepos, onSelectProject]);

  useEffect(() => {
    if (!open || !project) return;
    void loadTree(project.id);
  }, [open, project, loadTree]);

  const filteredRepos = useMemo(() => {
    const needle = repoFilter.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((repo) => repo.fullName.toLowerCase().includes(needle));
  }, [repos, repoFilter]);

  const filteredFiles = useMemo(() => {
    if (!tree) return [];
    const needle = fileFilter.trim().toLowerCase();
    const list = needle ? tree.filter((file) => file.path.toLowerCase().includes(needle)) : tree;
    return list.slice(0, 400);
  }, [tree, fileFilter]);

  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setError(null);
    const outcome = await linkGithubAccount();
    setBusy(null);
    if (outcome.status === "dismissed") return;
    if (outcome.status === "error") {
      setError(outcome.message);
      return;
    }
    setNotice(`Connected as @${outcome.login || "GitHub"}. Choose a repository.`);
    await loadStatus();
    await loadRepos();
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy("disconnect");
    setError(null);
    try {
      await api("/api/github/unlink", { method: "POST" });
      setStatus((current) => (current ? { ...current, connected: false, login: null } : current));
      setRepos([]);
      setNotice("GitHub disconnected. Your projects stay in the list.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect GitHub.");
    } finally {
      setBusy(null);
    }
  };

  const attach = async (repo: RepoItem) => {
    if (busy) return;
    setBusy(repo.fullName);
    setError(null);
    try {
      const data = await api<{ project: ProjectSummary }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ repoFullName: repo.fullName }),
      });
      setProjects((current) => [data.project, ...current.filter((item) => item.id !== data.project.id)]);
      onSelectProject(data.project);
      setNotice(`Attached ${repo.fullName}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach the repository.");
    } finally {
      setBusy(null);
    }
  };

  const openFile = async (path: string) => {
    if (!project) return;
    setOpenPath(path);
    setFileText(null);
    setError(null);
    try {
      const data = await api<{ text: string }>(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`);
      setFileText(data.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that file.");
      setFileText(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[130] flex justify-end" role="dialog" aria-modal="true" aria-label="Repository workspace">
      <button
        type="button"
        aria-label="Close repository panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <section className="animate-rise relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-[#0b1310]/[0.99] shadow-2xl shadow-black/70">
        <header className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#2f6b48]/20 text-[#a9d8bb]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 3v12a3 3 0 0 0 3 3h6" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="6" r="3" />
              <path d="M18 9v3a3 3 0 0 1-3 3h-3" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-semibold text-white">Repository</h2>
            <p className="truncate text-[11px] text-white/40">
              {project ? `${project.repoFullName} · ${project.defaultBranch} @ ${project.baseSha.slice(0, 7)}` : "Read-only access for the agent"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-white/40 transition-colors hover:bg-white/[0.07] hover:text-white"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error && (
            <div role="alert" className="mb-3 rounded-xl border border-red-400/20 bg-red-500/[0.07] px-3 py-2 text-[12px] leading-relaxed text-red-200/85">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="mb-3 rounded-xl border border-[#a9d8bb]/20 bg-[#a9d8bb]/[0.06] px-3 py-2 text-[12px] leading-relaxed text-[#c9e6d4]/90">
              {notice}
            </div>
          )}

          {!status ? (
            <p className="text-[12px] text-white/40">Checking the connection…</p>
          ) : !status.configured ? (
            <div className="rounded-xl border border-amber-300/20 bg-amber-400/[0.05] p-3 text-[12px] leading-relaxed text-amber-100/85">
              This deployment cannot store a GitHub connection yet. The owner needs to set
              <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 text-[11px]">GITHUB_TOKEN_KEY</code>
              to a 32-byte hex value and redeploy.
            </div>
          ) : !status.connected ? (
            <div className="space-y-3">
              <p className="text-[13px] leading-relaxed text-white/60">
                Connect GitHub to let the agent read a repository. Google stays your account — GitHub is added to it, so
                your chats and Dew do not move.
              </p>
              <button
                type="button"
                onClick={() => void connect()}
                disabled={busy === "connect"}
                className="w-full rounded-xl px-4 py-2.5 text-[13px] font-semibold text-[#0a100d] transition-opacity disabled:opacity-50"
                style={{ background: "linear-gradient(180deg, #a9d8bb 0%, #1f4a33 100%)" }}
              >
                {busy === "connect" ? "Waiting for GitHub…" : "Connect GitHub"}
              </button>
              <p className="text-[11px] leading-relaxed text-white/35">
                The agent gets read access to the repositories you choose. It cannot change anything; there is no commit
                path in this version.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2">
                <span className="truncate text-[12px] text-white/70">
                  Connected as <span className="font-semibold text-white">@{status.login ?? "GitHub"}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={busy === "disconnect"}
                  className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
                >
                  Disconnect
                </button>
              </div>

              {project && (
                <div className="rounded-xl border border-[#a9d8bb]/15 bg-[#a9d8bb]/[0.035]">
                  <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
                    <span className="truncate text-[12px] font-semibold text-white/85">{project.repoFullName}</span>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProject(null);
                        setTree(null);
                        setOpenPath(null);
                        setFileText(null);
                      }}
                      className="shrink-0 rounded-lg px-2 py-1 text-[10px] text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                      Change
                    </button>
                  </div>

                  {openPath ? (
                    <div className="p-2">
                      <div className="mb-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenPath(null);
                            setFileText(null);
                          }}
                          className="rounded-lg px-2 py-1 text-[10px] text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white"
                        >
                          ← Files
                        </button>
                        <span className="truncate font-mono text-[10px] text-white/40">{openPath}</span>
                      </div>
                      <pre className="max-h-[55vh] overflow-auto rounded-lg bg-black/40 p-2 text-[10.5px] leading-relaxed text-white/75">
                        {fileText ?? (error ? "" : "Loading…")}
                      </pre>
                    </div>
                  ) : (
                    <div className="p-2">
                      <input
                        value={fileFilter}
                        onChange={(event) => setFileFilter(event.target.value)}
                        placeholder="Filter files…"
                        className="mb-2 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                      />
                      {tree === null ? (
                        <p className="px-1 py-2 text-[11px] text-white/35">Reading the tree…</p>
                      ) : filteredFiles.length === 0 ? (
                        <p className="px-1 py-2 text-[11px] text-white/35">No files match.</p>
                      ) : (
                        <div className="max-h-[45vh] space-y-0.5 overflow-y-auto">
                          {filteredFiles.map((file) => (
                            <button
                              key={file.path}
                              type="button"
                              onClick={() => void openFile(file.path)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-white/[0.05]"
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-white/60">{file.path}</span>
                              <span className="shrink-0 text-[9px] text-white/20">{formatSize(file.size)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="mt-2 px-1 text-[9.5px] leading-relaxed text-white/25">
                        {truncated ? "This list is capped; the agent sees the same capped list. " : ""}
                        Dependencies, build output and lockfiles are excluded.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {projects.length > 0 && (
                <div>
                  <h3 className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/30">Your projects</h3>
                  <div className="space-y-1">
                    {projects.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectProject(item)}
                          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-white/65 hover:text-white"
                        >
                          {item.repoFullName}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (project?.id === item.id) onSelectProject(null);
                            setProjects((current) => current.filter((entry) => entry.id !== item.id));
                            void api(`/api/projects/${item.id}`, { method: "DELETE" }).catch(() => undefined);
                          }}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-white/25 transition-colors hover:bg-white/[0.07] hover:text-red-300"
                          aria-label={`Remove ${item.repoFullName}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/30">Your repositories</h3>
                <input
                  value={repoFilter}
                  onChange={(event) => setRepoFilter(event.target.value)}
                  placeholder="Filter repositories…"
                  className="mb-2 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                />
                {filteredRepos.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-white/35">No repositories to show. If this is unexpected, reconnect GitHub.</p>
                ) : (
                  <div className="space-y-1">
                    {filteredRepos.slice(0, 100).map((repo) => (
                      <button
                        key={repo.fullName}
                        type="button"
                        onClick={() => void attach(repo)}
                        disabled={busy === repo.fullName}
                        className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.04] disabled:opacity-50"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/70">{repo.fullName}</span>
                        {repo.private && (
                          <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.5 text-[8px] uppercase tracking-wide text-white/35">private</span>
                        )}
                        <span className="shrink-0 text-[9px] text-white/25">{busy === repo.fullName ? "…" : repo.defaultBranch}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

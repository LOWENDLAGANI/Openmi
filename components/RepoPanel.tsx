"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bindGoogleAccount } from "@/lib/account";
import { describeLinkError } from "@/lib/accountState";
import { authHeader, firebaseConfigured } from "@/lib/firebaseHistory";
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
//
// ── Why the panel no longer says "Checking the connection…" forever ─────────
// The check used to be a bare `fetch` with no deadline, whose failure left the
// status as `null`. A request that never answered therefore rendered the same
// sentence forever, with no button to press and nothing to read. Every request
// here now has a deadline, and a failure becomes one of three named states —
// signed out, unreachable, or a deployment that cannot store a connection —
// each with the action that resolves it. A button that cannot work is never the
// only thing on screen.
//
// ── Two ways to connect GitHub ──────────────────────────────────────────────
// A deployment with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` uses GitHub's
// own OAuth App: the server mints a signed state, the browser round-trips to
// github.com, and the sealed token comes back in an httpOnly cookie. Without
// those values the Firebase-hosted GitHub credential is still tried, which is
// what existing deployments already have. When neither is available the panel
// says which two environment values are missing instead of offering a button
// that fails after the click.

interface RepoPanelProps {
  open: boolean;
  onClose: () => void;
  project: ProjectSummary | null;
  onSelectProject: (project: ProjectSummary | null) => void;
}

interface GithubConnectionItem {
  id: string;
  login: string;
  scopes: string;
  kind: "pat" | "oauth";
  label: string;
  linkedAt: number;
  canReadRepos: boolean;
}

interface GithubStatus {
  configured: boolean;
  connected: boolean;
  login: string | null;
  /** True when this deployment has a GitHub OAuth App configured. */
  oauth?: boolean;
  /** True when a personal access token can be pasted. */
  pat?: boolean;
  /** Every connection this account holds. Never a token. */
  connections?: GithubConnectionItem[];
  /** The connection new repository reads use. */
  defaultId?: string | null;
}

type StatusState =
  | { phase: "checking" }
  | { phase: "ready"; status: GithubStatus }
  /** The server answered 401: it has no verified account for this browser. */
  | { phase: "signed-out"; message: string }
  /** The check itself failed — network, timeout, or a broken deployment. */
  | { phase: "error"; message: string };

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

/** A failed request, with the status the interface needs to branch on. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * One JSON request with a deadline.
 *
 * The deadline is the whole point: without it a held-open connection to the
 * app's own API looks exactly like a slow one, and the panel keeps saying it is
 * checking something it will never finish checking. Fifteen seconds is long
 * enough for a cold start and a Firebase token check, short enough that nobody
 * waits on a dead request without knowing it.
 */
const REQUEST_TIMEOUT_MS = 15_000;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(await authHeader()),
        ...(init?.headers ?? {}),
      },
    });
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: string; detail?: string })
      | null;
    if (!response.ok) {
      throw new ApiError(
        payload?.error ?? `Request failed (HTTP ${response.status})`,
        response.status,
        payload?.detail
      );
    }
    return payload as T;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    if ((cause as { name?: string })?.name === "AbortError") {
      throw new ApiError("The server took too long to answer. Check the connection and try again.", 0, "timeout");
    }
    throw new ApiError(
      cause instanceof Error ? cause.message : "The request could not be completed.",
      0,
      "network"
    );
  } finally {
    clearTimeout(timer);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The sentence behind a `?github=error&reason=…` return from the callback. */
function reasonMessage(reason: string | null): string {
  switch (reason) {
    case "state":
      return "The GitHub connection expired or was started in another browser. Press Connect GitHub again.";
    case "config":
      return "This deployment cannot finish a GitHub connection. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_TOKEN_KEY`, then redeploy.";
    case "viewer":
      return "GitHub authorised the app but would not say which account it belongs to. Try connecting again.";
    case "origin":
      return "This deployment does not know its own public address. Set `NEXT_PUBLIC_SITE_URL`, then redeploy.";
    default:
      return "GitHub could not be connected. Try again, or check the GitHub OAuth App settings.";
  }
}

export default function RepoPanel({ open, onClose, project, onSelectProject }: RepoPanelProps) {
  const [statusState, setStatusState] = useState<StatusState>({ phase: "checking" });
  const [repos, setRepos] = useState<RepoItem[]>([]);
  // The empty-list sentence must not appear while the list is still on its way:
  // "No repositories to show. Reconnect GitHub." sent people to disconnect a
  // connection that was working perfectly well.
  const [reposLoading, setReposLoading] = useState(false);
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
  const [patToken, setPatToken] = useState("");
  const [patLabel, setPatLabel] = useState("");
  /** The scope warning a token connect returned, held until the next action. */
  const [patWarning, setPatWarning] = useState<string | null>(null);

  const status = statusState.phase === "ready" ? statusState.status : null;

  // Read inside `refresh` without making it a dependency: the panel-opened
  // effect must not re-run every time a repository is selected, or the notice
  // it just set would be cleared by its own refresh.
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const loadStatus = useCallback(async (): Promise<GithubStatus | null> => {
    setStatusState({ phase: "checking" });
    try {
      const next = await api<GithubStatus>("/api/github/status");
      setStatusState({ phase: "ready", status: next });
      return next;
    } catch (cause) {
      const failure = cause instanceof ApiError ? cause : null;
      if (failure?.status === 401) {
        setStatusState({
          phase: "signed-out",
          message: failure.message || "This browser has no account the server can verify.",
        });
        return null;
      }
      setStatusState({
        phase: "error",
        message:
          failure?.message ??
          (cause instanceof Error ? cause.message : "Could not check the GitHub connection."),
      });
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
    setReposLoading(true);
    try {
      const data = await api<{ repos: RepoItem[] }>("/api/github/repos");
      setRepos(data.repos ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not list repositories.");
    } finally {
      setReposLoading(false);
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

  const refresh = useCallback(async () => {
    setError(null);
    const next = await loadStatus();
    const attached = await loadProjects();
    if (next?.connected) await loadRepos();
    if (!projectRef.current && attached.length > 0) onSelectProject(attached[0]);
  }, [loadStatus, loadProjects, loadRepos, onSelectProject]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);

    // A round trip to github.com comes back here with `?github=connected`,
    // `?github=cancelled` or `?github=error&reason=…`. The query is consumed
    // once and removed from the address bar, so a reload does not repeat the
    // message and a shared URL cannot carry it.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const returned = params.get("github");
      if (returned) {
        const reason = params.get("reason");
        if (returned === "connected") setNotice("GitHub connected. Choose a repository.");
        else if (returned === "cancelled") setNotice("GitHub was not connected. Nothing changed.");
        else setError(reasonMessage(reason));
        params.delete("github");
        params.delete("reason");
        const query = params.toString();
        window.history.replaceState(
          {},
          "",
          `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
        );
      }
    }

    // This is the "panel opened" moment. `refresh` is stable: it reads the
    // selected project through a ref, so choosing a repository does not re-run
    // this effect and wipe the notice it just set.
    void refresh();
  }, [open, refresh]);

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

  /**
   * Starts a connection.
   *
   * The native OAuth App is preferred because it needs no Firebase console
   * change; the Firebase-hosted credential remains the fallback for a
   * deployment that has not added the client id and secret.
   */
  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setError(null);
    setNotice(null);
    try {
      if (status?.oauth) {
        const data = await api<{ url: string }>("/api/github/oauth/start", {
          method: "POST",
          body: JSON.stringify({ next: "/" }),
        });
        // A full-page navigation, not a popup: popups are blocked often enough
        // that a connect button which depends on one reads as broken.
        window.location.assign(data.url);
        return;
      }

      const outcome = await linkGithubAccount();
      if (outcome.status === "dismissed") return;
      if (outcome.status === "error") {
        setError(outcome.message);
        return;
      }
      setNotice(`Connected as @${outcome.login || "GitHub"}. Choose a repository.`);
      const next = await loadStatus();
      if (next?.connected) await loadRepos();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the GitHub connection.");
    } finally {
      setBusy(null);
    }
  };

  /** The Google door, offered where it is needed rather than only in Settings. */
  const signIn = async () => {
    if (busy) return;
    setBusy("google");
    setError(null);
    setNotice(null);
    try {
      const result = await bindGoogleAccount();
      if (result.outcome === "dismissed") return;
      setNotice("Signed in. Checking the GitHub connection…");
      const next = await loadStatus();
      if (next?.connected) await loadRepos();
      else if (next && !next.connected) setNotice("Signed in. Connect GitHub to give the agent a repository.");
    } catch (cause) {
      setError(describeLinkError(cause));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Adds a connection from a token pasted in by the person.
   *
   * This is the door that does not depend on an OAuth App, a callback URL or a
   * provider switched on in a console: one POST, one `GET /user` behind it. A
   * warning about scope is shown rather than treated as a failure, because the
   * token is alive and only its reach is in question.
   */
  const connectWithToken = async () => {
    if (busy) return;
    const token = patToken.trim();
    if (!token) {
      setError("Paste a GitHub token first.");
      return;
    }
    setBusy("pat");
    setError(null);
    setNotice(null);
    setPatWarning(null);
    try {
      const data = await api<{
        login: string;
        label: string;
        canReadRepos: boolean;
        warning: string | null;
      }>("/api/github/connections", {
        method: "POST",
        body: JSON.stringify({ token, label: patLabel.trim() || undefined }),
      });
      setPatToken("");
      setPatLabel("");
      if (data.warning) {
        setPatWarning(data.warning);
        setNotice(`Saved as @${data.login}.`);
      } else {
        setNotice(`Connected as @${data.login}. Choose a repository.`);
      }
      const next = await loadStatus();
      if (next?.connected) await loadRepos();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That token could not be connected.");
    } finally {
      setBusy(null);
    }
  };

  const removeConnection = async (id: string) => {
    if (busy) return;
    setBusy(`remove:${id}`);
    setError(null);
    try {
      await api(`/api/github/connections/${id}`, { method: "DELETE" });
      const next = await loadStatus();
      if (next?.connected) await loadRepos();
      else setRepos([]);
      setNotice("Connection removed. Your projects stay in the list.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That connection could not be removed.");
    } finally {
      setBusy(null);
    }
  };

  const promoteConnection = async (id: string) => {
    if (busy) return;
    setBusy(`default:${id}`);
    setError(null);
    try {
      await api(`/api/github/connections/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ makeDefault: true }),
      });
      await loadStatus();
      setNotice("That connection is now used for repository reads.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The default could not be changed.");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy("disconnect");
    setError(null);
    try {
      // Every stored connection goes, not just the pointer: leaving one behind
      // would make "Disconnect" a button that visibly does nothing, because a
      // repository read would still find a token.
      const stored = statusState.phase === "ready" ? statusState.status.connections ?? [] : [];
      for (const item of stored) {
        await api(`/api/github/connections/${item.id}`, { method: "DELETE" }).catch(() => undefined);
      }
      await api("/api/github/unlink", { method: "POST" });
      setStatusState({ phase: "ready", status: { configured: true, connected: false, login: null } });
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

  /**
   * The token door, rendered wherever a connection can be added.
   *
   * Defined once and used in two places — before anything is connected, and
   * again beside the list so a second account can be added without removing the
   * first. Keeping it in one expression rather than two copies is what stops the
   * two from drifting apart.
   */
  const tokenForm = (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <p className="text-[12px] font-medium text-white/85">Connect with a personal access token</p>
      <p className="mt-1 text-[11px] leading-relaxed text-white/40">
        Create one at github.com/settings/tokens with the <code className="rounded bg-black/40 px-1 py-0.5 text-[10px]">repo</code> scope
        (or Contents: read on a fine-grained token), then paste it here. It is sealed on the server and never sent back to
        this browser.
      </p>
      <input
        type="password"
        value={patToken}
        onChange={(event) => setPatToken(event.target.value)}
        placeholder="ghp_… or github_pat_…"
        autoComplete="off"
        spellCheck={false}
        className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
      />
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={patLabel}
          onChange={(event) => setPatLabel(event.target.value)}
          placeholder="Label (optional)"
          maxLength={40}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
        />
        <button
          type="button"
          onClick={() => void connectWithToken()}
          disabled={busy === "pat" || !patToken.trim()}
          className="shrink-0 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-[#0a100d] transition-opacity disabled:opacity-50"
          style={{ background: "linear-gradient(180deg, #a9d8bb 0%, #1f4a33 100%)" }}
        >
          {busy === "pat" ? "Checking…" : "Connect"}
        </button>
      </div>
      {patWarning && (
        <p className="mt-2 rounded-lg border border-amber-300/20 bg-amber-400/[0.05] px-2 py-1.5 text-[10.5px] leading-relaxed text-amber-100/85">
          {patWarning}
        </p>
      )}
    </div>
  );

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
              {statusState.phase === "error" && (
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="mt-2 block rounded-lg border border-red-200/25 px-2 py-1 text-[11px] font-medium text-red-100/90 transition-colors hover:bg-red-200/10"
                >
                  Try again
                </button>
              )}
            </div>
          )}
          {notice && (
            <div role="status" className="mb-3 rounded-xl border border-[#a9d8bb]/20 bg-[#a9d8bb]/[0.06] px-3 py-2 text-[12px] leading-relaxed text-[#c9e6d4]/90">
              {notice}
            </div>
          )}

          {statusState.phase === "checking" ? (
            <p className="text-[12px] text-white/40">Checking the connection…</p>
          ) : statusState.phase === "signed-out" ? (
            <div className="space-y-3">
              <p className="text-[13px] leading-relaxed text-white/60">
                Openmi could not identify this browser, so GitHub cannot be attached to an account yet.
              </p>
              <p className="text-[11px] leading-relaxed text-white/35">{statusState.message}</p>
              {/* Hidden: Google login is not used — own approach handles sign-in. */}
              {false && firebaseConfigured ? (
                <button
                  type="button"
                  onClick={() => void signIn()}
                  disabled={busy === "google"}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/[0.08] px-4 py-2.5 text-[13px] font-medium text-white transition hover:bg-white/[0.12] disabled:opacity-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#EA4335"
                      d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1a6.2 6.2 0 0 1 0-12.4c1.76 0 2.94.75 3.62 1.4l2.57-2.47A9.9 9.9 0 0 0 12 2.5a9.5 9.5 0 1 0 0 19c5.5 0 9.13-3.86 9.13-9.3 0-.62-.07-1.1-.15-1.6z"
                    />
                  </svg>
                  {busy === "google" ? "Opening Google…" : "Continue with Google"}
                </button>
              ) : (
                <div className="rounded-xl border border-amber-300/20 bg-amber-400/[0.05] p-3 text-[12px] leading-relaxed text-amber-100/85">
                  This deployment has no Firebase project configured, so there is no account to attach GitHub to. Set the
                  <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 text-[11px]">NEXT_PUBLIC_FIREBASE_*</code>
                  values and redeploy.
                </div>
              )}
              <button
                type="button"
                onClick={() => void refresh()}
                className="w-full rounded-xl border border-white/[0.09] px-4 py-2 text-[12px] font-medium text-white/70 transition hover:bg-white/[0.06]"
              >
                Check again
              </button>
            </div>
          ) : statusState.phase === "error" ? (
            <div className="space-y-3">
              <p className="text-[13px] leading-relaxed text-white/60">
                The connection could not be checked.
              </p>
              <p className="text-[11px] leading-relaxed text-white/35">{statusState.message}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="w-full rounded-xl px-4 py-2.5 text-[13px] font-semibold text-[#0a100d] transition-opacity"
                style={{ background: "linear-gradient(180deg, #a9d8bb 0%, #1f4a33 100%)" }}
              >
                Try again
              </button>
            </div>
          ) : !statusState.status.configured ? (
            <div className="rounded-xl border border-amber-300/20 bg-amber-400/[0.05] p-3 text-[12px] leading-relaxed text-amber-100/85">
              This deployment cannot store a GitHub connection yet. The owner needs to set
              <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 text-[11px]">GITHUB_TOKEN_KEY</code>
              to a 32-byte hex value and redeploy.
            </div>
          ) : !statusState.status.connected ? (
            <div className="space-y-3">
              <p className="text-[13px] leading-relaxed text-white/60">
                Connect GitHub to let the agent read a repository. Your Openmi account stays the account — GitHub is
                attached to it, so your chats and Dew do not move.
              </p>
              {tokenForm}
              {/* Hidden: GitHub login is not used — own approach handles repo access. */}
              {false && (
                <>
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={busy === "connect"}
                  className="w-full rounded-xl px-4 py-2.5 text-[13px] font-semibold text-[#0a100d] transition-opacity disabled:opacity-50"
                  style={{ background: "linear-gradient(180deg, #a9d8bb 0%, #1f4a33 100%)" }}
                >
                  {busy === "connect" ? "Waiting for GitHub…" : "Connect GitHub"}
                </button>
                {status?.oauth ? (
                  <p className="text-[11px] leading-relaxed text-white/35">
                    You will be sent to GitHub to approve read access, then brought straight back here.
                  </p>
                ) : (
                  <p className="text-[11px] leading-relaxed text-white/35">
                    The agent gets read access to the repositories you choose. It cannot change anything without your
                    approval.
                  </p>
                )}
                {firebaseConfigured && (
                  <button
                    type="button"
                    onClick={() => void signIn()}
                    disabled={busy === "google"}
                    className="w-full rounded-xl border border-white/[0.09] px-4 py-2 text-[12px] font-medium text-white/60 transition hover:bg-white/[0.06] disabled:opacity-50"
                  >
                    {busy === "google" ? "Opening Google…" : "Sign in with Google first"}
                  </button>
                )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2">
                <span className="truncate text-[12px] text-white/70">
                  Connected as <span className="font-semibold text-white">@{statusState.status.login ?? "GitHub"}</span>
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

              {(statusState.status.connections?.length ?? 0) > 0 && (
                <div>
                  <h3 className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/30">
                    GitHub connections
                  </h3>
                  <div className="space-y-1">
                    {(statusState.status.connections ?? []).map((item) => {
                      const isDefault = statusState.status.defaultId === item.id;
                      const detail = item.scopes
                        ? item.scopes.slice(0, 40)
                        : item.canReadRepos
                          ? "fine-grained token"
                          : "no repository access";
                      return (
                        <div
                          key={item.id}
                          className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
                        >
                          <button
                            type="button"
                            onClick={() => void promoteConnection(item.id)}
                            disabled={busy === `default:${item.id}` || isDefault}
                            title={isDefault ? "Used for repository reads" : "Use this connection for repository reads"}
                            className="min-w-0 flex-1 text-left disabled:cursor-default"
                          >
                            <span className="block truncate text-[11px] text-white/75">
                              @{item.login}
                              {item.label && item.label !== item.login ? ` · ${item.label}` : ""}
                            </span>
                            <span className="block truncate text-[9.5px] text-white/30">{detail}</span>
                          </button>
                          {isDefault ? (
                            <span className="shrink-0 rounded bg-[#a9d8bb]/15 px-1 py-0.5 text-[8px] uppercase tracking-wide text-[#a9d8bb]/80">
                              default
                            </span>
                          ) : (
                            <span className="shrink-0 text-[9px] text-white/20">
                              {busy === `default:${item.id}` ? "…" : item.kind}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void removeConnection(item.id)}
                            disabled={busy === `remove:${item.id}`}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-white/25 transition-colors hover:bg-white/[0.07] hover:text-red-300 disabled:opacity-50"
                            aria-label={`Remove the @${item.login} connection`}
                          >
                            {busy === `remove:${item.id}` ? "…" : "Remove"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {tokenForm}

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
                {reposLoading && filteredRepos.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-white/35">Reading your repositories…</p>
                ) : filteredRepos.length === 0 ? (
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeader, supabaseConfigured } from "@/lib/supabase";
import { linkGithubAccount } from "@/lib/githubLink";
import { parseScopes, recoveryFor, type PatRecovery } from "@/lib/github/pat";
import type { ProjectSummary } from "@/lib/projects";
import Spinner from "@/components/Spinner";

// ── The repository workspace ────────────────────────────────────────────────
//
// The panel has one job, and it is the first thing on screen: pick the
// repository the agent works on. Everything else is either the result of that
// choice (the file browser) or account housekeeping, folded behind "Manage".
//
// It used to present every part at once — connections, a token form, the current
// project, a list of projects, a list of repositories — in 10px type, so a new
// person had to read three headings to find the list that mattered. Now there is
// one list: attached projects come first and are marked "Using", the account's
// other repositories follow and add themselves when picked. One search box
// covers both. Choosing a row is the whole interaction.
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
// those values only the pasted-token door is offered. When neither is available
// the panel says which two environment values are missing instead of offering a
// button that fails after the click.

interface RepoPanelProps {
  open: boolean;
  onClose: () => void;
  project: ProjectSummary | null;
  onSelectProject: (project: ProjectSummary | null) => void;
  /**
   * The repository a live hour is bound to. While it is set, another repository
   * cannot be chosen here: the hour was bought for this one, and the panel says
   * so instead of letting the selection drift away from what was paid for.
   */
  lockedProject?: { id: string; repoFullName: string } | null;
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
 * enough for a cold start and a token check, short enough that nobody
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

/** A repository row in the picker: an attached project, or one to add. */
interface PickerRow {
  fullName: string;
  branch: string;
  project: ProjectSummary | null;
  repo: RepoItem | null;
}

/** The mark used for a repository, at two sizes. */
function RepoMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3v12a3 3 0 0 0 3 3h6" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v3a3 3 0 0 1-3 3h-3" />
    </svg>
  );
}

export default function RepoPanel({ open, onClose, project, onSelectProject, lockedProject = null }: RepoPanelProps) {
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
  const [query, setQuery] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [tree, setTree] = useState<TreeFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [patToken, setPatToken] = useState("");
  // Whether the token form is open when there is an OAuth App. Without one the
  // form is always shown — pasting a token is then the only door — and with one
  // it stays folded behind a link, so the easier door is the one people see.
  const [patOpen, setPatOpen] = useState(false);
  const [patLabel, setPatLabel] = useState("");
  /** The connection a new paste would replace, when one was picked to fix. */
  const [replaceFor, setReplaceFor] = useState<GithubConnectionItem | null>(null);
  const patInputRef = useRef<HTMLInputElement | null>(null);
  // Which face of the workspace is showing. "pick" is the list of repositories;
  // "browse" is the chosen repository's files. A choice moves to "browse", and
  // "Change" comes back — so selecting a directory is never something to scroll
  // around looking for.
  const [view, setView] = useState<"pick" | "browse">("pick");
  const [accountOpen, setAccountOpen] = useState(false);

  const status = statusState.phase === "ready" ? statusState.status : null;

  // ── The one list ──────────────────────────────────────────────────────────
  // Attached projects first, so the current one is always at the top and never
  // hides below a long list of repositories. A repository already attached under
  // a different case is not offered twice.
  const rows = useMemo<PickerRow[]>(() => {
    const attached = new Set(projects.map((item) => item.repoFullName.toLowerCase()));
    return [
      ...projects.map((item) => ({
        fullName: item.repoFullName,
        branch: item.defaultBranch,
        project: item,
        repo: null,
      })),
      ...repos
        .filter((repo) => !attached.has(repo.fullName.toLowerCase()))
        .map((repo) => ({
          fullName: repo.fullName,
          branch: repo.defaultBranch,
          project: null,
          repo,
        })),
    ];
  }, [projects, repos]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.fullName.toLowerCase().includes(needle));
  }, [rows, query]);

  const filteredFiles = useMemo(() => {
    if (!tree) return [];
    const needle = fileFilter.trim().toLowerCase();
    const list = needle ? tree.filter((file) => file.path.toLowerCase().includes(needle)) : tree;
    return list.slice(0, 400);
  }, [tree, fileFilter]);

  // Escape closes the panel, the same way it closes Settings. The panel covers
  // the page, so a keyboard user who opened it by accident needs one key to get
  // back to the chat rather than a trip to the close button.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Opening the panel shows whichever face is useful: the files of a chosen
  // project, or the list when there is nothing chosen yet.
  useEffect(() => {
    if (!open) return;
    setView(project ? "browse" : "pick");
  }, [open, project]);

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
    await loadProjects();
    if (next?.connected) await loadRepos();
    // Nothing is selected on the panel's behalf. Picking the first project for
    // the reader made "Switch" look broken: clearing the selection and
    // reopening the panel put the same project straight back, with nothing on
    // screen to say why. A project is now chosen only by choosing it.
  }, [loadStatus, loadProjects, loadRepos]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setQuery("");
    setAccountOpen(false);

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

  /**
   * Starts a connection.
   *
   * Starts the OAuth round trip. Offered only when the deployment has a GitHub
   * OAuth App configured, because this button without one is a 404 with a button
   * on it. The client id and secret are all it needs, and the callback stores
   * the token in a sealed cookie rather than handing it to the page.
   */
  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setError(null);
    setNotice(null);
    try {
      const outcome = await linkGithubAccount();
      if (outcome.status === "dismissed" || outcome.status === "redirected") return;
      if (outcome.status === "error") {
        setError(outcome.message);
        return;
      }
      const next = await loadStatus();
      if (next?.connected) await loadRepos();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the GitHub connection.");
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
      setReplaceFor(null);
      // The card below says what is wrong and which scope fixes it, so the
      // notice only has to say what just happened.
      setNotice(
        data.warning
          ? `Saved as @${data.login}. It needs attention — see the note above.`
          : `Connected as @${data.login}. Choose a repository.`
      );
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
    if (lockedProject) {
      setError(
        `Your hour is for ${lockedProject.repoFullName}. End the hour session before attaching another repository.`
      );
      return;
    }
    setBusy(repo.fullName);
    setError(null);
    try {
      const data = await api<{ project: ProjectSummary }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ repoFullName: repo.fullName }),
      });
      setProjects((current) => [data.project, ...current.filter((item) => item.id !== data.project.id)]);
      onSelectProject(data.project);
      setOpenPath(null);
      setFileText(null);
      setView("browse");
      void loadTree(data.project.id);
      setNotice(`Attached ${repo.fullName}. It is now the project this chat uses.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach the repository.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Selecting a project is the whole interaction, so it answers immediately:
   * the row marks itself, the notice says which project the chat now uses, and
   * the panel moves to that repository's files.
   */
  const chooseProject = (item: ProjectSummary) => {
    setError(null);
    if (project?.id === item.id) {
      setView("browse");
      return;
    }
    if (lockedProject && lockedProject.id !== item.id) {
      setError(
        `Your hour is for ${lockedProject.repoFullName}, so another repository cannot use it. Continue with ${lockedProject.repoFullName}, or end the hour session and start a new one here.`
      );
      return;
    }
    onSelectProject(item);
    setOpenPath(null);
    setFileText(null);
    setFileFilter("");
    setView("browse");
    void loadTree(item.id);
    setNotice(`Now using ${item.repoFullName} for this chat and the agent.`);
  };

  /** Removing the selected project clears it, rather than leaving a dead pointer. */
  const removeProject = (item: ProjectSummary) => {
    if (project?.id === item.id) {
      onSelectProject(null);
      setView("pick");
    }
    setProjects((current) => current.filter((entry) => entry.id !== item.id));
    setNotice(`Removed ${item.repoFullName} from your projects.`);
    void api(`/api/projects/${item.id}`, { method: "DELETE" }).catch(() => undefined);
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
   * Connections that cannot do their job, each with the fix attached.
   *
   * Derived from the stored list rather than from the last response, so the note
   * survives a reload: a token that was connected yesterday and still cannot
   * read anything must not look healthy today just because nothing was clicked.
   */
  const attention = (statusState.phase === "ready" ? statusState.status.connections ?? [] : [])
    .map((connection) => ({
      connection,
      recovery: recoveryFor({
        scopes: parseScopes(connection.scopes),
        canReadRepos: connection.canReadRepos,
      }),
    }))
    .filter(
      (entry): entry is { connection: GithubConnectionItem; recovery: PatRecovery } =>
        entry.recovery !== null
    );

  /** Starts a replacement for one connection, putting the cursor where it helps. */
  const startReplacement = (connection: GithubConnectionItem) => {
    setReplaceFor(connection);
    setPatLabel(connection.label);
    // The form is below the list; focusing the field is what brings it into
    // view, so the person does not have to find it again.
    patInputRef.current?.focus();
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
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
      <p className="text-[13px] font-medium text-white/85">
        {replaceFor ? `Replace the @${replaceFor.login} token` : "Personal access token"}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-white/40">
        Create one at github.com/settings/tokens with the <code className="rounded bg-black/40 px-1 py-0.5 text-[11px]">repo</code> scope
        (or Contents: Read plus Metadata: Read on a fine-grained token).
      </p>
      <input
        ref={patInputRef}
        type="password"
        value={patToken}
        onChange={(event) => setPatToken(event.target.value)}
        placeholder="ghp_… or github_pat_…"
        autoComplete="off"
        spellCheck={false}
        className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-[12.5px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
      />
      <div className="mt-2 flex gap-2">
        <input
          value={patLabel}
          onChange={(event) => setPatLabel(event.target.value)}
          placeholder="Label (optional)"
          maxLength={40}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[12.5px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
        />
        <button
          type="button"
          onClick={() => void connectWithToken()}
          disabled={busy === "pat" || !patToken.trim()}
          className="shrink-0 rounded-xl px-4 py-2 text-[12.5px] font-semibold text-[#0a100d] transition-opacity disabled:opacity-50"
          style={{ background: "linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 58%, #000) 100%)" }}
        >
          {busy === "pat" ? "Checking…" : replaceFor ? "Replace" : "Connect"}
        </button>
      </div>
      {replaceFor && (
        <p className="mt-2 flex items-center gap-2 text-[11px] leading-relaxed text-white/35">
          Saving replaces the token for @{replaceFor.login}.
          <button
            type="button"
            onClick={() => {
              setReplaceFor(null);
              setPatLabel("");
            }}
            className="shrink-0 text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
          >
            Cancel
          </button>
        </p>
      )}
    </div>
  );

  if (!open) return null;

  const connected = status?.connected === true;
  const projectId = project?.id ?? null;
  const showBrowser = connected && project !== null && view === "browse";

  return (
    <div className="fixed inset-0 z-[130] flex justify-end" role="dialog" aria-modal="true" aria-label="Repository workspace">
      <button
        type="button"
        aria-label="Close repository panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <section className="animate-rise relative flex h-full w-full max-w-2xl flex-col border-l border-white/10 bg-[#0b1310]/[0.99] shadow-2xl shadow-black/70">
        <header className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3 sm:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#2f6b48]/20 text-[#a9d8bb]">
            <RepoMark size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-white">
              {showBrowser && project ? project.repoFullName : "Repository"}
            </h2>
            <p className="truncate text-[12px] text-white/40">
              {showBrowser && project
                ? `${project.defaultBranch} @ ${project.baseSha.slice(0, 7)}`
                : connected
                  ? `${rows.length} ${rows.length === 1 ? "repository" : "repositories"}`
                  : "Not connected"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2.5 text-white/40 transition-colors hover:bg-white/[0.07] hover:text-white"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {error && (
            <div role="alert" className="mb-3 rounded-2xl border border-red-400/20 bg-red-500/[0.07] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-red-200/85">
              {error}
              {statusState.phase === "error" && (
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="mt-2 block rounded-lg border border-red-200/25 px-2.5 py-1 text-[11.5px] font-medium text-red-100/90 transition-colors hover:bg-red-200/10"
                >
                  Try again
                </button>
              )}
            </div>
          )}
          {notice && (
            <div role="status" className="mb-3 rounded-2xl border border-[#a9d8bb]/20 bg-[#a9d8bb]/[0.06] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[#c9e6d4]/90">
              {notice}
            </div>
          )}

          {statusState.phase === "checking" ? (
            <div className="space-y-2.5" aria-busy="true">
              <div className="h-12 animate-pulse rounded-2xl bg-white/[0.04]" />
              <div className="h-12 animate-pulse rounded-2xl bg-white/[0.03]" />
              <div className="h-12 animate-pulse rounded-2xl bg-white/[0.02]" />
              <p className="flex items-center gap-2 pt-1 text-[12px] text-white/35">
                <Spinner size={14} className="text-[#a9d8bb]" />
                Checking the connection…
              </p>
            </div>
          ) : statusState.phase === "signed-out" ? (
            <div className="space-y-3">
              <p className="text-[13.5px] leading-relaxed text-white/65">
                Openmi could not identify this browser, so GitHub cannot be attached to an account yet.
              </p>
              <p className="text-[12px] leading-relaxed text-white/35">{statusState.message}</p>
              {!supabaseConfigured && (
                <div className="rounded-2xl border border-amber-300/20 bg-amber-400/[0.05] p-3.5 text-[12.5px] leading-relaxed text-amber-100/85">
                  This deployment has no Supabase project configured, so there is no account to attach GitHub to. Set the
                  <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 text-[11.5px]">NEXT_PUBLIC_SUPABASE_*</code>
                  values and redeploy.
                </div>
              )}
              <button
                type="button"
                onClick={() => void refresh()}
                className="w-full rounded-2xl border border-white/[0.09] px-4 py-3 text-[13px] font-medium text-white/70 transition hover:bg-white/[0.06]"
              >
                Check again
              </button>
            </div>
          ) : statusState.phase === "error" ? (
            <div className="space-y-3">
              <p className="text-[13.5px] leading-relaxed text-white/65">
                The connection could not be checked.
              </p>
              <p className="text-[12px] leading-relaxed text-white/35">{statusState.message}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="w-full rounded-2xl px-4 py-3 text-[13.5px] font-semibold text-[#0a100d] transition-opacity"
                style={{ background: "linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 58%, #000) 100%)" }}
              >
                Try again
              </button>
            </div>
          ) : !statusState.status.configured ? (
            <div className="rounded-2xl border border-amber-300/20 bg-amber-400/[0.05] p-3.5 text-[12.5px] leading-relaxed text-amber-100/85">
              This deployment cannot store a GitHub connection yet. The owner needs to set
              <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 text-[11.5px]">GITHUB_TOKEN_KEY</code>
              to a 32-byte hex value and redeploy.
            </div>
          ) : !connected ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-5">
                <p className="text-[15px] font-semibold text-white">Connect GitHub</p>
                <p className="mt-1 text-[12.5px] text-white/40">Read the repository the agent works on.</p>
                {status?.oauth ? (
                  <button
                    type="button"
                    onClick={() => void connect()}
                    disabled={busy === "connect"}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-semibold text-[#0a100d] transition-opacity disabled:opacity-50"
                    style={{ background: "linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 58%, #000) 100%)" }}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 2.2A9.8 9.8 0 0 0 2.2 12c0 4.3 2.8 8 6.7 9.3.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.3-3.3-1.3-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.7.3-1.1.6-1.4-2.2-.3-4.4-1.1-4.4-4.8 0-1.1.4-1.9 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.5 1 2.6 0 3.7-2.2 4.5-4.4 4.8.3.3.6.9.6 1.9v2.8c0 .3.2.6.7.5a9.8 9.8 0 0 0 6.7-9.3A9.8 9.8 0 0 0 12 2.2Z" />
                    </svg>
                    {busy === "connect" ? "Waiting for GitHub…" : "Continue with GitHub"}
                  </button>
                ) : (
                  <div className="mt-4">{tokenForm}</div>
                )}
              </div>
              {status?.oauth &&
                (patOpen ? (
                  tokenForm
                ) : (
                  <button
                    type="button"
                    onClick={() => setPatOpen(true)}
                    className="w-full rounded-2xl border border-white/[0.08] px-4 py-3 text-[13px] font-medium text-white/55 transition-colors hover:border-white/15 hover:text-white/85"
                  >
                    Use a personal access token
                  </button>
                ))}
            </div>
          ) : showBrowser && project ? (
            // ── The chosen repository ───────────────────────────────────────
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-2xl border border-[#a9d8bb]/20 bg-[#a9d8bb]/[0.05] p-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#a9d8bb]/15 text-[#b9e3c8]">
                  <RepoMark size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[13.5px] font-semibold text-white">{project.repoFullName}</p>
                  <p className="mt-0.5 truncate text-[11.5px] text-white/40">
                    {project.defaultBranch} @ {project.baseSha.slice(0, 7)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setView("pick")}
                  className="shrink-0 rounded-full bg-white px-3.5 py-2 text-[12px] font-semibold text-black transition-transform hover:scale-[1.02]"
                >
                  Change
                </button>
              </div>

              {openPath ? (
                <div className="rounded-2xl border border-white/[0.07] bg-black/20">
                  <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenPath(null);
                        setFileText(null);
                      }}
                      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m15 18-6-6 6-6" />
                      </svg>
                      Files
                    </button>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-white/40">{openPath}</span>
                  </div>
                  <pre className="max-h-[58vh] overflow-auto p-3 text-[12px] leading-relaxed text-white/75">
                    {fileText ?? (error ? "" : "Loading…")}
                  </pre>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30"
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-3.6-3.6" />
                    </svg>
                    <input
                      value={fileFilter}
                      onChange={(event) => setFileFilter(event.target.value)}
                      placeholder="Search files"
                      className="w-full rounded-2xl border border-white/10 bg-black/30 py-2.5 pl-9 pr-3 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                    />
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
                    {tree === null ? (
                      <p className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-white/35">
                        <Spinner size={14} className="text-[#a9d8bb]" />
                        Reading files…
                      </p>
                    ) : filteredFiles.length === 0 ? (
                      <p className="px-3 py-3 text-[12.5px] text-white/35">No files match.</p>
                    ) : (
                      <div className="max-h-[52vh] divide-y divide-white/[0.04] overflow-y-auto">
                        {filteredFiles.map((file) => (
                          <button
                            key={file.path}
                            type="button"
                            onClick={() => void openFile(file.path)}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="shrink-0 text-white/25"
                              aria-hidden="true"
                            >
                              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
                              <path d="M14 3v5h5" />
                            </svg>
                            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-white/70">{file.path}</span>
                            <span className="shrink-0 text-[10.5px] text-white/20">{formatSize(file.size)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {truncated && (
                    <p className="px-1 text-[11px] text-white/30">
                      This list is capped; the agent sees the same capped list.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
            // ── Choose a repository ────────────────────────────────────────
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-1.5 pl-3">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="shrink-0 text-white/35"
                  aria-hidden="true"
                >
                  <path d="M12 2.2A9.8 9.8 0 0 0 2.2 12c0 4.3 2.8 8 6.7 9.3.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.3-3.3-1.3-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.7.3-1.1.6-1.4-2.2-.3-4.4-1.1-4.4-4.8 0-1.1.4-1.9 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.5 1 2.6 0 3.7-2.2 4.5-4.4 4.8.3.3.6.9.6 1.9v2.8c0 .3.2.6.7.5a9.8 9.8 0 0 0 6.7-9.3A9.8 9.8 0 0 0 12 2.2Z" />
                </svg>
                <span className="min-w-0 flex-1 truncate text-[13px] text-white/70">
                  <span className="font-semibold text-white">@{statusState.status.login ?? "GitHub"}</span>
                  {attention.length > 0 && (
                    <span className="ml-2 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-100/90">
                      {attention.length} to fix
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setAccountOpen((value) => !value)}
                  className="shrink-0 rounded-xl px-3 py-1.5 text-[12px] font-medium text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white"
                  aria-expanded={accountOpen}
                >
                  {accountOpen ? "Done" : "Manage"}
                </button>
              </div>

              {accountOpen && (
                <div className="space-y-3 rounded-2xl border border-white/[0.07] bg-black/20 p-3">
                  {attention.length > 0 && (
                    <div className="space-y-2">
                      {attention.map(({ connection, recovery }) => {
                        const blocked = recovery.level === "blocked";
                        return (
                          <div
                            key={connection.id}
                            className={`rounded-xl border p-2.5 ${
                              blocked
                                ? "border-red-400/25 bg-red-500/[0.06]"
                                : "border-amber-300/20 bg-amber-400/[0.05]"
                            }`}
                          >
                            <p className={`text-[12px] font-semibold ${blocked ? "text-red-100/90" : "text-amber-100/90"}`}>
                              {recovery.headline}
                            </p>
                            <p className={`mt-0.5 text-[11px] leading-relaxed ${blocked ? "text-red-100/60" : "text-amber-100/60"}`}>
                              <span className="font-mono text-white/70">@{connection.login}</span> — {recovery.body}
                            </p>

                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              <span className="text-[9px] uppercase tracking-[0.1em] text-white/30">Scope</span>
                              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-[#a9d8bb]">
                                {recovery.classicScope}
                              </code>
                              <span className="text-[9px] text-white/25">or</span>
                              {recovery.fineGrained.map((scope) => (
                                <code key={scope} className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-[#a9d8bb]">
                                  {scope}
                                </code>
                              ))}
                            </div>

                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <a
                                href={recovery.tokenUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded-md border border-white/[0.14] px-2 py-1 text-[11px] font-medium text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white"
                              >
                                Open GitHub tokens ↗
                              </a>
                              <a
                                href={recovery.fineGrainedUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-1 py-1 text-[11px] text-white/40 underline-offset-2 transition-colors hover:text-white/70 hover:underline"
                              >
                                New fine-grained token
                              </a>
                              <button
                                type="button"
                                onClick={() => startReplacement(connection)}
                                className="rounded-md border border-white/[0.14] px-2 py-1 text-[11px] font-medium text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white"
                              >
                                Replace token
                              </button>
                              <button
                                type="button"
                                onClick={() => void removeConnection(connection.id)}
                                disabled={busy === `remove:${connection.id}`}
                                className="px-1 py-1 text-[11px] text-white/40 transition-colors hover:text-red-300 disabled:opacity-50"
                              >
                                {busy === `remove:${connection.id}` ? "Removing…" : "Remove"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(statusState.status.connections?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      {(statusState.status.connections ?? []).map((item) => {
                        const isDefault = statusState.status.defaultId === item.id;
                        const detail = item.scopes
                          ? item.scopes.slice(0, 40)
                          : item.canReadRepos
                            ? "fine-grained token"
                            : "no repository access";
                        return (
                          <div key={item.id} className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                            <button
                              type="button"
                              onClick={() => void promoteConnection(item.id)}
                              disabled={busy === `default:${item.id}` || isDefault}
                              title={isDefault ? "Used for repository reads" : "Use this connection for repository reads"}
                              className="min-w-0 flex-1 text-left disabled:cursor-default"
                            >
                              <span className="block truncate text-[12px] text-white/75">
                                @{item.login}
                                {item.label && item.label !== item.login ? ` · ${item.label}` : ""}
                              </span>
                              <span className="block truncate text-[10.5px] text-white/30">{detail}</span>
                            </button>
                            {isDefault ? (
                              <span className="shrink-0 rounded-full bg-[#a9d8bb]/15 px-2 py-0.5 text-[9px] uppercase tracking-wide text-[#a9d8bb]/80">
                                default
                              </span>
                            ) : (
                              <span className="shrink-0 text-[10px] text-white/20">{busy === `default:${item.id}` ? "…" : item.kind}</span>
                            )}
                            <button
                              type="button"
                              onClick={() => void removeConnection(item.id)}
                              disabled={busy === `remove:${item.id}`}
                              className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-white/25 transition-colors hover:bg-white/[0.07] hover:text-red-300 disabled:opacity-50"
                              aria-label={`Remove the @${item.login} connection`}
                            >
                              {busy === `remove:${item.id}` ? "…" : "Remove"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {tokenForm}

                  <button
                    type="button"
                    onClick={() => void disconnect()}
                    disabled={busy === "disconnect"}
                    className="w-full rounded-xl border border-red-400/15 px-3 py-2 text-[12px] font-medium text-red-200/70 transition-colors hover:bg-red-500/[0.08] hover:text-red-200 disabled:opacity-50"
                  >
                    {busy === "disconnect" ? "Disconnecting…" : "Disconnect GitHub"}
                  </button>
                </div>
              )}

              <div className="relative">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.6-3.6" />
                </svg>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search repositories"
                  className="w-full rounded-2xl border border-white/10 bg-black/30 py-3 pl-9 pr-3 text-[13.5px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                />
              </div>

              {filteredRows.length === 0 ? (
                <div className="flex items-center gap-2.5 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-4 text-[13px] text-white/35">
                  {reposLoading && rows.length === 0 && <Spinner size={15} className="text-[#a9d8bb]" />}
                  {reposLoading && rows.length === 0
                    ? "Reading your repositories…"
                    : query.trim()
                      ? "No repositories match."
                      : "No repositories to show."}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filteredRows.slice(0, 100).map((row) => {
                    const selected = row.project !== null && row.project.id === projectId;
                    const locked =
                      lockedProject !== null &&
                      row.project !== null &&
                      row.project.id !== lockedProject.id;
                    const working = busy === row.fullName;
                    return (
                      <div
                        key={row.project?.id ?? row.fullName}
                        className={`flex items-center gap-1 rounded-2xl border px-1.5 py-1 transition-colors ${
                          selected
                            ? "border-[#a9d8bb]/35 bg-[#a9d8bb]/[0.08]"
                            : "border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.045]"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (row.project) chooseProject(row.project);
                            else if (row.repo) void attach(row.repo);
                          }}
                          disabled={working || locked}
                          className="flex min-w-0 flex-1 items-center gap-3 px-1.5 py-2 text-left disabled:cursor-not-allowed"
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                              selected ? "bg-[#a9d8bb]/15 text-[#b9e3c8]" : "bg-white/[0.05] text-white/40"
                            }`}
                          >
                            <RepoMark size={17} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate font-mono text-[13px] ${selected ? "text-white" : "text-white/80"}`}>
                              {row.fullName}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-white/35">
                              {row.project && <span className="text-[#a9d8bb]/80">Project</span>}
                              {row.repo?.private && <span>Private</span>}
                              <span className="truncate">{row.branch}</span>
                            </span>
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                              selected
                                ? "bg-[#a9d8bb]/15 text-[#b9e3c8]"
                                : "bg-white/[0.06] text-white/55"
                            }`}
                          >
                            {selected ? "Using" : working ? "Adding…" : row.project ? "Use" : "Add"}
                          </span>
                        </button>
                        {row.project && (
                          <button
                            type="button"
                            onClick={() => {
                              if (row.project) removeProject(row.project);
                            }}
                            className="shrink-0 rounded-xl p-2 text-white/20 transition-colors hover:bg-white/[0.06] hover:text-red-300"
                            aria-label={`Remove ${row.fullName}`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

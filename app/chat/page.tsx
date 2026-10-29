"use client";

// ── The product, at /chat ───────────────────────────────────────────────────
// The marketing page is the root route; this is the app behind the account
// gate, so the first thing drawn here is either the sign-in screen or the chat
// shell — never a landing page.

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Sidebar from "@/components/Sidebar";
import ChatThread from "@/components/ChatThread";
import ChatInput from "@/components/ChatInput";
import PricingDialog from "@/components/PricingDialog";
import AdBanner from "@/components/AdBanner";
import AdPopunder from "@/components/AdPopunder";
import ModeSelector from "@/components/ModelSelector";
import OpenmiMark from "@/components/OpenmiMark";
import FocusHome from "@/components/FocusHome";
import SettingsPanel from "@/components/SettingsPanel";
import RepoPanel from "@/components/RepoPanel";
import Spinner from "@/components/Spinner";
import type { ProjectSummary } from "@/lib/projects";
import AuthScreen from "@/components/AuthScreen";
import MaintenanceScreen from "@/components/MaintenanceScreen";
import { loadDisplayName, saveDisplayName, saveAvatar } from "@/lib/visitorName";
import {
  loadChatsFromAccount,
  syncVisitorProfile,
  flushTrashDecisions,
  loadFoldersFromAccount,
  loadTrashFromAccount,
  syncCloudHistory,
  syncFoldersToAccount,
  syncLocalTrash,
} from "@/lib/cloudHistory";
import { consumeOAuthError, loadAccountName, saveAccountName, watchAccount } from "@/lib/account";
import { adoptDeviceAccount } from "@/lib/deviceAccount";
import { describeLinkError, normalizeName, type AccountView } from "@/lib/accountState";
import {
  DEFAULT_PREFERENCES,
  loadLocalPreferences,
  saveLocalPreferences,
  type UserPreferences,
} from "@/lib/preferences";
import {
  db,
  createChat,
  addMessage,
  maybeAutoTitle,
  saveSelectedMode,
} from "@/lib/db";
import { DEFAULT_MODE_ID, getMode, modeCapabilities, type ModeId } from "@/lib/models";
import { readAgentStream } from "@/lib/agentStream";
import { refreshDew, useDew } from "@/lib/useDew";
import { DEW_PER_HOUR } from "@/lib/dew";
// getMode is used for the assistant message engine label below.
import type {
  ApiContentPart,
  ApiMessage,
  AgentStep,
  ChatMessage,
  DocumentAttachment,
  ImageAttachment,
  SearchMode,
  SearchSource,
  ProposalReview,
  Chat,
} from "@/lib/types";
import {
  DEFAULT_APPEARANCE,
  DEFAULT_HOME_LAYOUT,
  saveAppearance,
  saveHomeLayout,
  type Appearance,
  type HomeLayout,
  type ReasoningEffort,
  type ResponseLength,
} from "@/lib/settings";
import { authHeader } from "@/lib/supabase";
import { subscribeAppConfig, type AppConfig } from "@/lib/appConfig";
import { displayedContent, retireCurrentAnswer } from "@/lib/variants";
import { purgeTrash } from "@/lib/trash";
import { parseRetrySeconds } from "@/lib/rateLimit";
import { uid } from "@/lib/db";
import {
  saveAgentRun,
  clearAgentRun,
  nextResumableAgentRun,
  type AgentRunRecord,
} from "@/lib/db";

/**
 * The run shape this page polls.
 *
 * Declared here rather than imported from `lib/agentRuns`: that module holds the
 * service-role client, and pulling it into a client component would carry the
 * privileged key into the bundle.
 */
interface AgentRunPayload {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  content: string;
  steps: AgentStep[];
  changesetId: string | null;
  review: ProposalReview | null;
  truncated: boolean;
  error: string | null;
  usage: { prompt: number; completion: number };
}

/** A wait that a closed tab interrupts, so polling never outlives the page. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}


/** The chat id used for in-memory draft messages that are not kept locally.
    It exists only so the send path has one variable to address either kind of
    chat by, and it can never collide with a real id, which is a uuid. */
const DRAFT_CHAT_ID = "draft";

/** A message being composed but not yet stored. It is kept in memory only so
    the compose path has somewhere to put a user message before the assistant
    row exists. */
const draftRef = { message: null as ChatMessage | null };

function draftMessage(input: {
  chatId: string;
  role: "user";
  content?: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
}): ChatMessage {
  const now = Math.max(Date.now(), (draftRef.message?.createdAt ?? 0) + 1);
  const message: ChatMessage = {
    ...input,
    id: uid(),
    createdAt: now,
    updatedAt: now,
    content: input.content ?? "",
  };
  draftRef.message = message;
  return message;
}

function clearDraft(): void {
  draftRef.message = null;
}

/** The most the account-resolution gate will wait on one remote answer — 3 s
    is comfortably longer than a healthy single read. A held-open socket is a
    question the network may never answer, and waiting forever on it is what
    left returning visitors staring at a pulsing logo. */
const ACCOUNT_NAME_TIMEOUT_MS = 3_000;

import { useMaintenance } from "@/lib/useMaintenance";

// ── Openmi — main client orchestration: modes, streaming, chats ────────────────

interface SessionUsage {
  prompt: number;
  completion: number;
  total: number;
}

interface SendOptions {
  editMessageId?: string;
  regenerateAssistantId?: string;
  /** The chat this send belongs to, when the caller has already created it
      (the pricing dialog does, so an hour can be started for it first). */
  chatId?: string;
}

// ── The hour session, from the browser's side ────────────────────────────────
// The server owns whether an hour may start and what it covers; these two calls
// only ask. A live hour is bound to one model and, when it was started in a
// repository, to that repository. A 409 that names a different one is a refusal
// with two honest answers — keep using the active one, or end the hour — and a
// 402 carries the shortfall so the dialog can point at the wallet. Neither
// response is trusted for pricing: the price is the server's.

/** The live hour as the server describes it. */
interface HourView {
  expiresAt: number;
  model: ModeId;
  /** The repository the hour is bound to, or null for ordinary chat. */
  projectId: string | null;
  repoFullName: string | null;
}

interface HourStartOk {
  ok: true;
  session: HourView;
}

interface HourStartFail {
  ok: false;
  code?: string;
  /** The live hour the refusal is about, when there is one. */
  session?: HourView | null;
  error?: string;
}

/** One stored or returned hour, in the shape the rest of the page expects. */
function hourViewFrom(raw: unknown): HourView | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.expiresAt !== "number") return null;
  return {
    expiresAt: value.expiresAt,
    model: value.model === "code" || value.model === "flash" ? value.model : "auto",
    projectId: typeof value.projectId === "string" && value.projectId ? value.projectId : null,
    repoFullName: typeof value.repoFullName === "string" && value.repoFullName ? value.repoFullName : null,
  };
}

/**
 * Why a live hour does not cover the send in front of the user, in one sentence.
 *
 * The same rule the server enforces, said before the request is made so the
 * refusal appears where the user is looking rather than as a failed answer.
 */
function hourConflictLabel(
  hour: HourView,
  requiredModel: ModeId,
  project: ProjectSummary | null
): string | null {
  if (hour.model !== requiredModel) {
    return `Your hour is for ${getMode(hour.model).display}, not ${getMode(requiredModel).display}.`;
  }
  if (project && hour.projectId !== project.id) {
    return hour.repoFullName
      ? `Your hour is for ${hour.repoFullName}, not ${project.repoFullName}.`
      : `Your hour was started without a repository, so it cannot cover ${project.repoFullName}.`;
  }
  return null;
}

async function requestHourSession(
  model: ModeId,
  projectId: string | null
): Promise<HourStartOk | HourStartFail> {
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ action: "start", model, projectId }),
    });
    const data = (await response.json().catch(() => null)) as {
      session?: unknown;
      code?: unknown;
      error?: unknown;
    } | null;

    const session = hourViewFrom(data?.session);
    if (response.ok && session) {
      return { ok: true, session };
    }
    return {
      ok: false,
      code: typeof data?.code === "string" ? data.code : undefined,
      session,
      error:
        typeof data?.error === "string"
          ? data.error
          : "The hour session could not be started. Try again in a moment.",
    };
  } catch {
    return { ok: false, error: "Could not reach the session service. Check your connection and try again." };
  }
}

async function requestEndHourSession(): Promise<void> {
  try {
    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ action: "end" }),
    });
  } catch {
    // Ending is best effort here; the row expires on its own either way.
  }
}

export default function HomePage() {
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<ModeId>(DEFAULT_MODE_ID);
  const [available, setAvailable] = useState<ModeId[]>([DEFAULT_MODE_ID, "code"]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  // The repository the agent is working on. Null means ordinary chat: nothing
  // about the agent is active until a project is chosen.
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [hydrated, setHydrated] = useState(false);
  // Null while the first identity read is still in flight. `signedIn: false`
  // after that is a real answer: the sign-in screen is the interface.
  const [account, setAccount] = useState<AccountView | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // The account whose history this browser is holding. Null until the handover
  // has run, which is what keeps the previous account's chats off the screen.
  const [deviceAccount, setDeviceAccount] = useState<string | null>(null);
  const preferencesRef = useRef<UserPreferences>(DEFAULT_PREFERENCES);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  // What the repository agent is doing at this instant, for the line under the
  // thread. Set while a tool is announced or the model is thinking, cleared the
  // moment text starts arriving, so it never competes with the answer itself.
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [searchAvailable, setSearchAvailable] = useState(false);
  const [responseLength, setResponseLength] = useState<ResponseLength>("balanced");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("low");
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [homeLayout, setHomeLayout] = useState<HomeLayout>(DEFAULT_HOME_LAYOUT);
  const [loggingError, setLoggingError] = useState(false);
  // Epoch ms until the server has asked the composer to hold off, set from the
  // wait the server itself names in a 429 — never guessed locally.
  const [rateLimitUntil, setRateLimitUntil] = useState<number | null>(null);
  // The per-request token budget the server enforces, read from GET /api/chat.
  // Null until it answers, which the ring reads as "use the product default".
  const [contextBudget, setContextBudget] = useState<number | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const maintenance = useMaintenance();
  const abortRef = useRef<AbortController | null>(null);
  // ── Temporary chat ─────────────────────────────────────────────────────────
  // A conversation that is never written down: not to IndexedDB, and therefore
  // not to the account either, since everything uploaded to the account starts as
  // a local row. The thread lives in this component and in this ref — nothing
  // else is allowed to keep a copy.
  const [draftId, setDraftId] = useState<string | null>(null);
  // The account's live hour session, if any, and the first-message price
  // dialog. The dialog holds the composed message until a price is chosen, and
  // knows which model and repository that hour has to be bought for.
  const [hourSession, setHourSession] = useState<HourView | null>(null);
  const [pricingPrompt, setPricingPrompt] = useState<{
    text: string;
    images: ImageAttachment[];
    documents: DocumentAttachment[];
    /** True when the message goes to the repository agent once the hour exists. */
    agent: boolean;
    /** The model the hour must be bought for. */
    model: ModeId;
    /** The repository it must be bought for, or null for ordinary chat. */
    projectId: string | null;
    repoFullName: string | null;
    /** A live hour that does not cover this send, when there is one. */
    conflict: string | null;
  } | null>(null);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [pricingNotice, setPricingNotice] = useState<string | null>(null);
  const dew = useDew();

  /** Kept for the send path only while a draft message is live; otherwise unused. */
  const publishTemp = useCallback(() => {}, []);

  const endDraft = useCallback(() => {
    clearDraft();
    setDraftId(null);
    setActiveChatId(null);
    setModelNotice(null);
    setSidebarOpen(false);
  }, []);

  const startDraft = useCallback(() => {
    abortRef.current?.abort();
    setStreamingId(null);
    clearDraft();
    setDraftId(DRAFT_CHAT_ID);
    setActiveChatId(null);
    setModelNotice(null);
    setSidebarOpen(false);
  }, []);

  const toggleDraft = useCallback(() => {
    if (draftId) endDraft();
    else startDraft();
  }, [endDraft, startDraft, draftId]);
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = useLiveQuery(
    async () => {
      if (!activeChatId) return [] as ChatMessage[];
      return db.messages.where("chatId").equals(activeChatId).sortBy("createdAt");
    },
    [activeChatId],
    [] as ChatMessage[]
  );

  const sidebarChats = useLiveQuery(
    () => db.chats.orderBy("updatedAt").reverse().toArray(),
    [],
    [] as Chat[]
  );

  // A GitHub connection made through GitHub's own OAuth App returns as a
  // full-page navigation to this app with `?github=…`. Open the repository
  // panel so the result — connected, cancelled, or failed — is visible instead
  // of landing silently on the chat. The panel consumes and removes the query.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("github")) setRepoOpen(true);
  }, []);

  // Restore the most recently attached project. A failure here is not worth a
  // banner — not being signed in, or having no database, simply means the
  // workspace starts without a repository.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/projects", { headers: await authHeader() });
        if (!response.ok) return;
        const data = (await response.json()) as { projects?: ProjectSummary[] };
        const first = data.projects?.[0];
        if (!cancelled && first) setProject((current) => current ?? first);
      } catch {
        // Offline or unconfigured: the chat still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  // ── Local preferences first ─────────────────────────────────────────────
  // The browser's copy is what the first paint reads. It is instant and it
  // works offline; the account's copy is adopted right after the session is
  // known, below.
  useEffect(() => {
    const local = loadLocalPreferences();
    preferencesRef.current = local;
    setSelectedMode(local.model ?? DEFAULT_MODE_ID);
    setResponseLength(local.responseLength);
    setReasoningEffort(local.reasoningEffort);
    setAppearance(local.appearance);
    setHomeLayout(local.homeLayout);
    saveHomeLayout(local.homeLayout);
    saveAppearance(local.appearance, local.homeLayout);
    setSearchMode(local.searchMode);
    setDisplayName(local.displayName ?? "");
    setAvatarUrl(local.avatarUrl ?? "");
    setHydrated(true);
  }, []);

  // ── The account ─────────────────────────────────────────────────────────
  // This is the gate. Until a session exists the sign-in screen is the whole
  // interface, so `account` starts null ("still asking") and then means exactly
  // what Supabase answered.
  useEffect(() => watchAccount(setAccount), []);

  // A provider that refused the round trip puts its reason in the URL. Read it
  // once and show it on the sign-in screen; the parser removes the parameters.
  useEffect(() => {
    const failure = consumeOAuthError();
    if (failure) setAuthError(describeLinkError({ message: failure }));
  }, []);

  // Signing out clears this device's copy of the name/avatar. The next account on this
  // browser must not inherit the previous person's greeting; the account keeps
  // its own name in `profiles` and `user_preferences`.
  //
  // The screen's own state goes with it: an open temporary thread is content
  // that must not survive the session, a selected chat id points at rows that
  // belong to the previous account, and the repository chip named their
  // repository. The stored history is handled by the device handover, which
  // runs when the next account signs in.
  useEffect(() => {
    if (account?.signedIn !== false) return;
    saveDisplayName("");
    setDisplayName("");
    saveAvatar("");
    setAvatarUrl("");      endDraft();
    setActiveChatId(null);
    setProject(null);
  }, [account?.signedIn, endDraft]);

  // ── Whose history this browser holds ────────────────────────────────────
  // IndexedDB is one database per browser, not one per account. Before the
  // product renders for this account the cache is handed over: kept when it is
  // this account's, cleared when the last person on this browser was somebody
  // else. Without this the second account's sidebar showed the first account's
  // conversations, and the push uploaded them into the second account.
  useEffect(() => {
    if (!account?.signedIn || !account.id) {
      setDeviceAccount(null);
      return;
    }
    const uid = account.id;
    let cancelled = false;
    void adoptDeviceAccount(uid)
      .then(() => {
        if (!cancelled) setDeviceAccount(uid);
      })
      .catch((error: unknown) => {
        // The stale rows are still stored, so this account's history must not be
        // shown as if it were the device's: the splash stays and a reload tries
        // again. The push guard in `syncCloudHistory` already keeps the previous
        // account's rows out of this account in the meantime.
        console.error("[Openmi] Could not clear the previous account's history", error);
      });
    return () => {
      cancelled = true;
    };
  }, [account?.signedIn, account?.id]);

  // ── Once a session exists ───────────────────────────────────────────────
  // Resolve the name, adopt the account's preferences, and pull the account's
  // chat history. The history pull is unawaited: a long backfill must not hold
  // the first paint, and the live Dexie query already watching `chats` puts the
  // conversations on screen the moment they land.
  useEffect(() => {
    if (!hydrated || !account?.signedIn || !account.id) return;
    const uid = account.id;
    let cancelled = false;

    void (async () => {
      // Awaited before anything is read or written: a pull that ran first would
      // merge this account's history into the previous person's list, and the
      // push would write that list into this account.
      await adoptDeviceAccount(uid);
      if (cancelled) return;
      const localName = normalizeName(loadDisplayName());
      let chosen = localName;
      if (!chosen) {
        const accountName = await Promise.race([
          loadAccountName(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), ACCOUNT_NAME_TIMEOUT_MS)),
        ]);
        chosen = normalizeName(accountName) || normalizeName(account.name) || "Openmi user";
      }
      if (cancelled) return;
      setDisplayName(saveDisplayName(chosen));
      void saveAccountName(chosen);

      const merged: UserPreferences = { ...preferencesRef.current, displayName: chosen };
      preferencesRef.current = merged;
      setAppearance(merged.appearance);
      setHomeLayout(merged.homeLayout);
      setResponseLength(merged.responseLength);
      setReasoningEffort(merged.reasoningEffort);
      setSearchMode(merged.searchMode);
      setSelectedMode(merged.model ?? DEFAULT_MODE_ID);
      setAvatarUrl(merged.avatarUrl ?? "");
      saveLocalPreferences(merged);

      // The sidebar is part of the account too. Decisions taken while offline
      // are delivered first (otherwise the pull would undo them), then folders
      // so a chat's folder resolves, then the trash before the live list so a
      // chat parked on another device is not re-added here. Only then is this
      // device's own state pushed up, because a pull may have removed a folder
      // or purged a trashed chat and those decisions must not be undone by an
      // upload.
      void (async () => {
        await flushTrashDecisions().catch(() => undefined);
        await loadFoldersFromAccount().catch(() => null);
        await loadTrashFromAccount().catch(() => null);
        await loadChatsFromAccount().catch(() => null);
        await syncFoldersToAccount().catch(() => undefined);
        await syncLocalTrash().catch(() => undefined);
      })();
      void syncVisitorProfile(chosen).catch((error: unknown) => {
        console.error("[Openmi] Could not log the visitor name", error);
      });
    })().catch((error: unknown) => {
      console.error("[Openmi] Could not load the account", error);
    });

    return () => {
      cancelled = true;
    };
  }, [hydrated, account?.signedIn, account?.id, account?.email, account?.name]);

  useEffect(() => {
    if (!hydrated || !account?.signedIn) return;
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = setTimeout(() => {
      void syncCloudHistory()
        .then((result) => {
          if (result.synced) setLoggingError(false);
        })
        .catch((error: unknown) => {
          console.error("[Openmi] Cloud history logging failed", error);
          setLoggingError(true);
        });
    }, 900);
    return () => {
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    };
  }, [hydrated, account?.signedIn]);

  // The administrator's announcement, read live from the same public node the
  // server enforces. A visitor who blocks the read simply never sees it.
  useEffect(() => subscribeAppConfig(setAppConfig), []);

  useEffect(() => {
    if (!loggingError) return;
    const timeout = setTimeout(() => setLoggingError(false), 4000);
    return () => clearTimeout(timeout);
  }, [loggingError]);

  /** Saves the display name everywhere it is read: this browser, the profile, and the account's preferences. */
  const handleSaveName = useCallback((name: string) => {
    const saved = saveDisplayName(name);
    setDisplayName(saved);
    const next = { ...preferencesRef.current, displayName: saved };
    preferencesRef.current = next;
    saveLocalPreferences(next);
    void saveAccountName(saved);
    void syncVisitorProfile(saved).catch((error: unknown) => {
      console.error("[Openmi] Could not log the visitor name", error);
    });
  }, []);

  const handleSaveAvatar = useCallback((avatar: string) => {
    saveAvatar(avatar);
    setAvatarUrl(avatar);
    const next = { ...preferencesRef.current, avatarUrl: avatar || null };
    preferencesRef.current = next;
    saveLocalPreferences(next);
  }, []);

  /**
   * Writes one preference to this browser and to the account.
   *
   * The local write happens first and always; the cloud write is best effort.
   * A failure leaves the local value standing and is repaired by the next
   * change, which is the right weight for a setting.
   */
  const persistPreferences = useCallback((patch: Partial<UserPreferences>) => {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    saveLocalPreferences(next);
  }, []);

  // Probe which modes have keys configured server-side (may be empty).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        available?: ModeId[];
        searchAvailable?: boolean;
        contextBudget?: number;
      };
      if (Array.isArray(detail.available)) setAvailable(detail.available);
      if (typeof detail.searchAvailable === "boolean") setSearchAvailable(detail.searchAvailable);
      if (typeof detail.contextBudget === "number" && detail.contextBudget > 0) {
        setContextBudget(detail.contextBudget);
      }
    };
    window.addEventListener("openmi:availability", handler);
    return () => window.removeEventListener("openmi:availability", handler);
  }, []);

  // A stored preference can outlive the availability that made it valid: a mode
  // whose model this deployment never configured must not leave the composer
  // sitting on a mode it can no longer send, with every message refused. Auto is
  // always open, so there is always somewhere to land.
  //
  // Nothing here is about payment any more. Every mode is priced by the Dew it
  // costs rather than by a plan, so the same gate covers a mode nobody has
  // configured and a balance somebody has spent — and it is the routes, not
  // this effect, that decide whether a request may start.
  useEffect(() => {
    if (available.includes(selectedMode)) return;
    const open = available[0] ?? DEFAULT_MODE_ID;
    if (open !== selectedMode) {
      setSelectedMode(open);
      saveSelectedMode(open);
    }
  }, [available, selectedMode]);

  // Switching modes is not a mid-conversation toggle. Code mode is pinned to
  // Groq for code-generation accuracy, and continuing a chat
  // written by one model under another would blend two different answers into
  // one thread. So picking a mode that declares `separateSession` starts a fresh
  // session instead of reinterpreting the current one.
  const handleModeChange = (mode: ModeId) => {
    // A mode this deployment cannot serve must not be selectable. Before this
    // guard, picking one was silently clamped back to the first available mode
    // by the availability effect below — which read as a broken dropdown
    // ("it snaps to Code") with no hint why. Now the user is told exactly what
    // is missing so the site owner can add the key.
    if (!available.includes(mode)) {
      const name = getMode(mode).display;
      // Each mode is served by its own key. Telling somebody who picked Code
      // to add an OpenRouter key sends them after the wrong value entirely.
      const key =
        mode === "code"
          ? "GROQ_API_KEY"
          : mode === "flash"
            ? "DEEPSEEK_API_KEY"
            : "OPENROUTER_API_KEY";
      const needs =
        mode === "code"
          ? "a Groq API key"
          : mode === "flash"
            ? "a DeepSeek API key"
            : "an OpenRouter API key";
      setModelNotice(
        `${name} needs ${needs} (${key}). Add your own in Settings → API keys, or ask the site owner to configure it — the mode becomes selectable as soon as a key is available.`
      );
      return;
    }
    // A live hour is bought for one model. Switching the picker would not switch
    // the hour, so the switch is refused here with the two choices that exist:
    // keep using the active model, or end the hour and buy another.
    if (hourSession && hourSession.model !== mode) {
      setModelNotice(
        `Your hour is for ${getMode(hourSession.model).display}. Continue with it, or end the hour session above the composer to switch to ${getMode(mode).display}.`
      );
      return;
    }
    setSelectedMode(mode);
    setModelNotice(null);
    saveSelectedMode(mode);
    persistPreferences({ model: mode });

    if (mode === selectedMode) return;
    if (!getMode(mode).separateSession) return;

    abortRef.current?.abort();
    setStreamingId(null);
    setActiveChatId(null);
    setSidebarOpen(false);
  };

  const handleResponseLengthChange = (value: ResponseLength) => {
    setResponseLength(value);
    persistPreferences({ responseLength: value });
  };

  const handleReasoningEffortChange = (value: ReasoningEffort) => {
    setReasoningEffort(value);
    persistPreferences({ reasoningEffort: value });
  };

  const handleAppearanceChange = (value: Appearance) => {
    setAppearance(value);
    saveAppearance(value, homeLayout);
    persistPreferences({ appearance: value });
  };

  const handleHomeLayoutChange = (value: HomeLayout) => {
    setHomeLayout(value);
    saveHomeLayout(value);
    persistPreferences({ homeLayout: value });
  };

  const handleSearchModeChange = (value: SearchMode) => {
    setSearchMode(value);
    persistPreferences({ searchMode: value });
  };

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    setStreamingId(null);
    setActiveChatId(null);
    setSidebarOpen(false);
    setModelNotice(null);
    // A new chat is a chat you meant to keep, so any unsent draft is dropped
    // here rather than turned into one that is written down.
    if (draftId) endDraft();
  }, [endDraft]);

  const handleSelectChat = useCallback((chatId: string) => {
    abortRef.current?.abort();
    setStreamingId(null);
    setActiveChatId(chatId);
    setSidebarOpen(false);
    setModelNotice(null);
    if (draftId) endDraft();
  }, [endDraft]);

  // The session is account-wide, so it is read once per sign-in rather than per
  // chat. Every change the page makes updates the state directly as well.
  useEffect(() => {
    if (!account?.signedIn) {
      setHourSession(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/session", { headers: await authHeader(), cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { session?: unknown };
        const session = hourViewFrom(data.session);
        if (cancelled) return;
        setHourSession(session);
        // The hour was bought for one model, so that is the model on screen
        // until it ends. Leaving the picker on a stored preference would mean
        // every message is refused for a reason the user cannot see.
        if (session) {
          setSelectedMode(session.model);
          saveSelectedMode(session.model);
        }
      } catch {
        // A session that cannot be read is simply not shown; the route still
        // enforces it when a message is sent.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account?.signedIn]);

  // The banner follows the row's own expiry; a timer at that moment clears it
  // rather than a one-second countdown re-rendering the page for an hour.
  useEffect(() => {
    if (!hourSession) return;
    const remaining = hourSession.expiresAt - Date.now();
    if (remaining <= 0) {
      setHourSession(null);
      return;
    }
    const timer = window.setTimeout(() => setHourSession(null), remaining + 1_000);
    return () => window.clearTimeout(timer);
  }, [hourSession]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Turning the server's own refusal into a countdown the composer can show.
  // `retryAfterSeconds` from the body is authoritative when it is there; the
  // sentence is the fallback for an older server, a proxy that rewrote the
  // body, or a provider's own "wait 20s". Anything without a named wait is a
  // plain error and changes nothing.
  const noteRateLimit = useCallback((message: string, retryAfterSeconds?: number) => {
    const named = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, 600) : null;
    const seconds = named ?? parseRetrySeconds(message);
    if (seconds) setRateLimitUntil(Date.now() + seconds * 1000);
  }, []);

  // The countdown ends by clearing itself, so the composer's one-second tick
  // stops with it instead of running for the rest of the session.
  useEffect(() => {
    if (!rateLimitUntil) return;
    if (rateLimitUntil <= Date.now()) {
      setRateLimitUntil(null);
      return;
    }
    const timer = setTimeout(() => setRateLimitUntil(null), rateLimitUntil - Date.now() + 300);
    return () => clearTimeout(timer);
  }, [rateLimitUntil]);

  // Expired trash is dropped on arrival, so thirty-day-old conversations do
  // not sit in the Trash overlay waiting to be noticed.
  useEffect(() => {
    void purgeTrash().catch(() => undefined);
  }, []);

  // Settings → Your data wiped everything while this page was open; the view
  // follows the data back to an empty thread.
  useEffect(() => {
    const onWiped = () => handleNewChat();
    window.addEventListener("openmi:data-wiped", onWiped);
    return () => window.removeEventListener("openmi:data-wiped", onWiped);
  }, [handleNewChat]);

  // ── Where a message is written ─────────────────────────────────────────────
  // One set of calls for both kinds of chat, so the send path below has no
  // draft branching in it. A real message goes to Dexie, and the account sync
  // picks it up there exactly as it always has.
  const appendUserMessage = useCallback(
    async (input: {
      chatId: string;
      role: "user";
      content?: string;
      images?: ImageAttachment[];
      documents?: DocumentAttachment[];
    }): Promise<ChatMessage> => addMessage({ ...input, content: input.content ?? "" }),
    []
  );

  const appendAssistantMessage = useCallback(
    async (input: {
      chatId: string;
      role: "assistant";
      content?: string;
      model?: string;
    }): Promise<ChatMessage> => addMessage({ ...input, content: input.content ?? "" }),
    []
  );

  const patchMessage = useCallback(
    async (id: string, changes: Partial<ChatMessage>): Promise<void> => {
      await db.messages.update(id, changes);
    },
    []
  );

  const writeContent = useCallback(
    async (id: string, content: string): Promise<void> => patchMessage(id, { content }),
    [patchMessage]
  );
  const sanitizeError = useCallback((error: unknown): string => {
    if (typeof error === "string") {
      const msg = error.trim();
      if (!msg) return "Something went wrong. Please try again.";
      // Make technical errors more user-friendly
      if (msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("networkerror")) {
        return "Connection issue. Please check your internet and try again.";
      }
      if (msg.toLowerCase().includes("timeout")) {
        return "The request timed out. Please try again.";
      }
      if (msg.toLowerCase().includes("unauthorized") || msg.toLowerCase().includes("401")) {
        return "Something went wrong with authentication. Please try signing in again.";
      }
      if (msg.toLowerCase().includes("rate limit")) {
        return "Too many requests. Please wait a moment and try again.";
      }
      // If it's very technical/long, make it simpler
      if (msg.length > 200 || msg.includes("{\"")) {
        return "Something went wrong. Please try again.";
      }
      return msg;
    }
    if (error instanceof Error) {
      return sanitizeError(error.message);
    }
    return "Something went wrong. Please try again.";
  }, []);

  const markError = useCallback(
    async (id: string, error: string | unknown): Promise<void> => patchMessage(id, { error: sanitizeError(error) }),
    [patchMessage, sanitizeError]
  );
  const writeUsage = useCallback(
    async (
      id: string,
      usage: { prompt: number; completion: number; total: number }
    ): Promise<void> => patchMessage(id, { usage }),
    [patchMessage]
  );

  const readMessage = useCallback(
    async (id: string): Promise<ChatMessage | undefined> => db.messages.get(id),
    []
  );

  /** Throws away the turns after the one being edited or regenerated, which is
      what both of those actions mean. */
  const dropFromMessage = useCallback(
    async (
      chatId: string,
      id: string,
      createdAt: number,
      inclusive: boolean
    ): Promise<void> => {
      await db.messages
        .where("chatId")
        .equals(chatId)
        .filter((message) => (inclusive ? message.createdAt >= createdAt : message.createdAt > createdAt))
        .delete();
    },
    []
  );

  /** The conversation so far, in the order the model must read it.

      The chat to read is passed in rather than taken from `activeChatId`: the
      first message of a new chat is sent before React has re-rendered, so that
      state still holds the previous value — or nothing at all — and reading it
      here would hand the server an empty transcript. */
  const threadHistory = useCallback(
    async (chatId: string): Promise<ChatMessage[]> => {
      return db.messages.where("chatId").equals(chatId).sortBy("createdAt");
    },
    []
  );

  /**
   * Turns the current answer into a variant and empties the row for the next
   * one — which is what retry and edit now mean. The old answer stays readable
   * (see lib/variants.ts) instead of being deleted with the row, because it is
   * the answer the new one is being judged against.
   *
   * Only the text moves across. Sources, usage, truncation and any error belong
   * to the answer being replaced; carrying them over would show the new
   * answer's controls above the old answer's evidence.
   *
   * Returns false for a row with nothing in it — an answer that never started
   * is not a branch, it is a row to cut.
   */
  const branchAnswer = useCallback(
    async (message: ChatMessage): Promise<boolean> => {
      if (!message.content) return false;
      await patchMessage(message.id, {
        content: "",
        variants: retireCurrentAnswer(message),
        variantIndex: undefined,
        error: undefined,
        truncated: undefined,
        sources: undefined,
        searchQuery: undefined,
        usage: undefined,
        model: getMode(selectedMode).display,
      });
      return true;
    },
    [patchMessage, selectedMode]
  );

  // ── Streaming send ─────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (text: string, images: ImageAttachment[], documents: DocumentAttachment[] = [], options?: SendOptions) => {
      if (streamingId) return;
      if (!text && images.length === 0 && documents.length === 0 && !options) return;

      let chatId: string | null = options?.chatId ?? (draftId ?? (activeChatId ?? DRAFT_CHAT_ID));
      // The row the new answer streams into. Normally a fresh message; when a
      // retry or an edit turns the old reply into a branch point, it is that
      // reply — emptied above, with the previous answer kept beside it.
      let reuseId: string | null = null;
      if (options?.editMessageId) {
        const original = await readMessage(options.editMessageId);
        if (!original) return;
        chatId = original.chatId;
        await patchMessage(original.id, { content: text, images: images.length ? images : undefined, documents: documents.length ? documents : undefined });
        // The reply to the wording being replaced is what an edit is compared
        // against, so it is found before the cut, turned into a variant, and
        // reused as the home of the new answer. The two then sit on one row
        // behind one stepper rather than as two answers that read as one.
        const previousReply = (await threadHistory(chatId)).find(
          (message) => message.createdAt > original.createdAt && message.role === "assistant"
        );
        if (previousReply && (await branchAnswer(previousReply))) {
          await dropFromMessage(chatId, previousReply.id, previousReply.createdAt, false);
          reuseId = previousReply.id;
        } else {
          await dropFromMessage(chatId, original.id, original.createdAt, false);
        }
      } else if (options?.regenerateAssistantId) {
        const original = await readMessage(options.regenerateAssistantId);
        if (!original) return;
        chatId = original.chatId;
        // An answer worth keeping becomes a variant; an empty one has nothing
        // to keep and is cut the way it always was.
        const branched = await branchAnswer(original);
        await dropFromMessage(chatId, original.id, original.createdAt, !branched);
        if (branched) reuseId = original.id;
      } else {
        if (!chatId) {
          const chat = await createChat();
          chatId = chat.id;
          setActiveChatId(chatId);
        } else if (chatId === DRAFT_CHAT_ID) {
          // A message sent before a real chat exists gets its own row now.
          const chat = await createChat();
          chatId = chat.id;
          setActiveChatId(chatId);
        }
        await appendUserMessage({
          chatId,
          role: "user",
          content: text,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
        });
        await maybeAutoTitle(chatId, text || "Attachment conversation");
      }
      if (!chatId) return;
      if (!draftId) setActiveChatId(chatId);

      const history = await threadHistory(chatId);
      const apiMessages: ApiMessage[] = history.flatMap((message): ApiMessage[] => {
        if (message.error || (message.role !== "user" && message.role !== "assistant")) return [];
        // What the reader is looking at is what the model continues from: if
        // somebody stepped back to an earlier answer and then writes, the next
        // reply has to follow that one, not a version only the database knows.
        const text = displayedContent(message);
        if (message.role === "user" && (message.images?.length || message.documents?.length)) {
          const parts: ApiContentPart[] = [];
          const documentText = message.documents?.map((document) => `Attachment ${document.name}:\n${document.text}`).join("\n\n");
          const textContent = [text, documentText].filter(Boolean).join("\n\n");
          if (textContent) parts.push({ type: "text", text: textContent });
          for (const image of message.images ?? []) parts.push({ type: "image_url", image_url: { url: image.url } });
          return [{ role: "user", content: parts }];
        }
        if (!text.trim()) return [];
        return [{ role: message.role, content: text }];
      });

      // The attachment belongs to this turn, not to the stored history, so it is
      // appended after the transcript is built and never persisted into a
      // previous user message.
      setModelNotice(null);
      // The Openmi name is stored rather than a provider id, so nothing vendor-
      // specific ends up in the local database or in an exported backup.
      const assistantMsg: ChatMessage =
        (reuseId ? await readMessage(reuseId) : undefined) ??
        (await appendAssistantMessage({ chatId, role: "assistant", content: "", model: getMode(selectedMode).display }));
      setStreamingId(assistantMsg.id);

      const controller = new AbortController();
      abortRef.current = controller;
      let sawError = false;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeader()) },
          body: JSON.stringify({
            messages: apiMessages,
            mode: selectedMode,
            // The chat is what matches a live hour session on the server. The
            // message is free only when this id owns that session.
            chatId,
            searchMode,
            responseLength,
            reasoningEffort,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            error?: string;
            retryAfterSeconds?: number;
          } | null;
          const message = payload?.error || `Openmi request failed (HTTP ${res.status})`;
          noteRateLimit(message, payload?.retryAfterSeconds);
          throw new Error(message);
        }
        // The server answered, so whatever wait it asked for last time is over.
        // Clearing here rather than on a timer means a reopened tab never sits
        // on a countdown the server has already forgotten.
        setRateLimitUntil((current) => (current ? null : current));
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response stream");
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        const flushLine = async (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") return;
          try {
            const evt = JSON.parse(data) as { content?: string; error?: string; retryAfterSeconds?: number; model?: string; truncated?: boolean; usage?: SessionUsage; search?: { used: boolean; query?: string; sources?: SearchSource[] } };
            if (evt.model) {
              await patchMessage(assistantMsg.id, { model: evt.model });
            }
            if (evt.error) {
              // The server refuses inside the stream as well as before it, so
              // the countdown is read from both places. The event's own field
              // is the exact wait the bucket computed.
              noteRateLimit(evt.error, evt.retryAfterSeconds);
              sawError = true;
              await markError(assistantMsg.id, evt.error);
              return;
            }
            if (evt.truncated) {
              // Recorded on the message so it survives a reload. Without it the
              // only trace that an answer was cut short is gone once the tab is
              // closed, and the half-file still looks finished.
              await patchMessage(assistantMsg.id, { truncated: true });
            }
            if (evt.content) {
              full += evt.content;
              await writeContent(assistantMsg.id, full);
            }
            if (evt.usage) await writeUsage(assistantMsg.id, evt.usage);
            if (evt.search) {
              await patchMessage(assistantMsg.id, { searchQuery: evt.search.query, sources: evt.search.sources ?? [] });
              if (!evt.search.used && searchMode !== "off") setModelNotice("Openmi checked the web but could not find a usable source.");
            }
          } catch (err) {
            if (err instanceof Error && err.message !== "Stream interrupted") throw err;
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) await flushLine(line);
        }
        if (buffer.trim()) await flushLine(buffer);
        if (!full.trim() && !sawError) await markError(assistantMsg.id, "Openmi returned an empty response. Try again.");

      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        if (!aborted) await markError(assistantMsg.id, err instanceof Error ? err.message : "Something went wrong");
        if (aborted) {
          // A cancelled answer that never wrote a word leaves an empty bubble
          // behind, so it is taken out of whichever store holds it.
          const msg = await readMessage(assistantMsg.id);
          if (msg && !msg.content) {
        await db.messages.delete(assistantMsg.id);
          }
        }
      } finally {
        setStreamingId(null);
        abortRef.current = null;
        // The charge for this answer has been written to the account by the
        // time the stream ends, so this is the moment the balance on screen
        // becomes wrong — and every chip in the app re-reads at once.
        void refreshDew();
      }
    },
    [activeChatId, appendUserMessage, appendAssistantMessage, branchAnswer, dropFromMessage, markError, noteRateLimit, patchMessage, readMessage, reasoningEffort, responseLength, searchMode, selectedMode, streamingId, threadHistory, writeContent, writeUsage]
  );

  // ── The repository agent ───────────────────────────────────────────────────
  //
  // One turn is one paid request: the first step charges the flat Code price and
  // returns a signed token that lets the rest of the turn continue without a
  // second charge. The client drives the loop so Stop cancels the request in
  // flight, and each read is written into the message as it happens.
  const sendAgentMessage = useCallback(
    async (
      text: string,
      options?: {
        regenerateAssistantId?: string;
        editMessageId?: string;
        documents?: DocumentAttachment[];
        /** A turn this browser was already running when the tab went away. */
        resume?: AgentRunRecord;
      }
    ) => {
      if (!project || streamingId) return;
      let chatId: string | null = draftId ?? (activeChatId ?? DRAFT_CHAT_ID);
      let assistantId: string;

      // Editing a question with a repository attached has to go through the
      // agent. Sending it to ordinary chat would answer the same wording with no
      // repository access at all — and look exactly like a normal answer, which
      // is the worst way for the two to differ.
      if (options?.resume) {
        // Picking a turn back up. The question, the answer row and the chat all
        // already exist, so nothing is appended — the loop simply continues into
        // the answer that was already being written.
        chatId = options.resume.chatId;
        assistantId = options.resume.id;
        setActiveChatId(chatId);
      } else if (options?.editMessageId) {
        const original = await readMessage(options.editMessageId);
        if (!original || original.role !== "user") return;
        chatId = original.chatId;
        await patchMessage(original.id, { content: text, error: undefined });
        // Everything after the edited question belonged to the answer it is
        // replacing, so it goes with it.
        await dropFromMessage(chatId, original.id, original.createdAt, false);
        const assistant = await appendAssistantMessage({
          chatId,
          role: "assistant",
          content: "",
          model: getMode("code").display,
        });
        assistantId = assistant.id;          if (!draftId) setActiveChatId(chatId);
      } else {
        if (!chatId) {
          const chat = await createChat();
          chatId = chat.id;
          setActiveChatId(chatId);
        }
        if (!chatId) return;

        // Regenerating re-runs the existing answer row instead of appending a new
        // question: the old text is retired into its variants first, so the answer
        // being judged is still readable behind the switch control.
        assistantId = "";
        if (options?.regenerateAssistantId) {
          const previous = await readMessage(options.regenerateAssistantId);
          if (!previous) return;

          assistantId = previous.id;
          await branchAnswer(previous);
          // A regenerated answer proposes a new change, so the review card of the
          // previous answer must go with the text it described.
          await patchMessage(assistantId, { content: "", steps: undefined, error: undefined, changesetId: undefined });
        } else {
          await addMessage({ chatId, role: "user", content: text });
          await maybeAutoTitle(chatId, text);
          const assistant = await appendAssistantMessage({
            chatId,
            role: "assistant",
            content: "",
            model: getMode("code").display,
          });
          assistantId = assistant.id;
        }
      }

      setStreamingId(assistantId);
      setModelNotice(null);
      setAgentActivity(null);

      const history = (await threadHistory(chatId))
        .filter((entry) => entry.role !== "system" && entry.content.trim().length > 0)
        .map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.content }));

      const controller = new AbortController();
      abortRef.current = controller;
      let transcript: unknown[] = options?.resume?.transcript ?? [];
      let turnToken: string | undefined = options?.resume?.turnToken;
      let content = options?.resume?.content ?? "";
      let answerModel = getMode("code").display;
      // Steps are placed by the index the server gives them, counted from the
      // start of the steps this request produced. A tool is announced before it
      // runs and its result arrives at the same index, so the timeline fills in
      // while the work is happening instead of appearing all at once at the end.
      const steps: AgentStep[] = options?.resume?.steps ? [...options.resume.steps] : [];

      // Attached files become this turn's context. Sent on every step because the
      // server keeps it out of the transcript: it is context for the question,
      // not something the person said in an earlier turn. A resumed turn carries
      // its own copy, because the composer no longer holds the file.
      const attachContext = (options?.documents ?? [])
        .map((document) => `Attachment ${document.name}:\n${document.text}`)
        .join("\n\n")
        .slice(0, 12_000);
      const turnContext = attachContext || options?.resume?.context || "";

      // ── Live writes ────────────────────────────────────────────────────────
      // A delta can arrive many times a second. Writing every one of them to
      // IndexedDB — and from there to the account — would cost more than the
      // answer is worth, so patches are coalesced into roughly one every 120ms
      // and flushed before anything that has to see the final text.
      let lastPatch = 0;
      let patchTimer: ReturnType<typeof setTimeout> | null = null;
      let patchChain: Promise<unknown> = Promise.resolve();
      const writeNow = () => {
        lastPatch = Date.now();
        const snapshot = { content, steps: steps.filter(Boolean).map((step) => ({ ...step })), model: answerModel };
        patchChain = patchChain.then(() => patchMessage(assistantId, snapshot)).catch(() => undefined);
      };
      const schedulePatch = () => {
        if (patchTimer) return;
        patchTimer = setTimeout(() => {
          patchTimer = null;
          writeNow();
        }, Math.max(0, 120 - (Date.now() - lastPatch)));
      };
      const flushPatches = async () => {
        if (patchTimer) {
          clearTimeout(patchTimer);
          patchTimer = null;
        }
        writeNow();
        await patchChain;
      };

      try {
        // ── Start the run ────────────────────────────────────────────────────
        // From here the turn belongs to the server. This tab renders it; closing
        // the tab no longer stops it, which is the whole point of the change.
        let runId = options?.resume?.runId ?? "";
        if (!runId) {
          const started = await fetch("/api/agent/runs", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await authHeader()) },
            body: JSON.stringify({ projectId: project.id, history, context: turnContext }),
            signal: controller.signal,
          });
          const start = (await started.json().catch(() => null)) as
            | { run?: { id?: string }; error?: string; retryAfterSeconds?: number; detail?: string }
            | null;
          runId = start?.run?.id ?? "";
          // A deployment with no service key cannot advance a turn unattended.
          // That is a supported state, not a failure: the same turn runs here,
          // one step at a time, and stops when this tab does.
          const inTab = started.status === 503 && start?.detail === "runs-unconfigured";
          if (!inTab && (!started.ok || !runId)) {
            const message = start?.error ?? `The agent request failed (HTTP ${started.status}).`;
            noteRateLimit(message, start?.retryAfterSeconds);
            await markError(assistantId, message);
            return;
          }
          // A pointer, not the state: the run itself lives on the server. Kept so
          // a reload can attach to this message instead of starting a second run.
          if (chatId) {
            await saveAgentRun({
              id: assistantId,
              chatId,
              projectId: project.id,
              transcript: [],
              turnToken: "",
              context: turnContext,
              content: "",
              steps: [],
              runId,
            });
          }
        }

        // ── No run: step in this tab ─────────────────────────────────────────
        // The same turn the tick would have run, driven by the page instead. It
        // is the whole of the old behaviour, kept because a deployment without
        // the key is still a working deployment.
        if (!runId) {
          for (let attempt = 0; attempt < 10; attempt += 1) {
            const stepOffset = steps.filter(Boolean).length;
            const response = await fetch("/api/agent/step", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(await authHeader()) },
              body: JSON.stringify({
                projectId: project.id,
                history,
                transcript,
                turnToken,
                ...(turnContext ? { context: turnContext } : {}),
              }),
              signal: controller.signal,
            });

            if (!response.ok) {
              const payload = (await response.json().catch(() => null)) as {
                error?: string;
                retryAfterSeconds?: number;
              } | null;
              const message = payload?.error ?? `The agent request failed (HTTP ${response.status}).`;
              noteRateLimit(message, payload?.retryAfterSeconds);
              await markError(assistantId, message);
              return;
            }
            if (!response.body) {
              await markError(assistantId, "The agent returned an empty stream. Try again.");
              return;
            }

            // Mutated from the stream callback, so it lives in an object: a plain
            // `let` would be read as its initial value after the await.
            const state = {
              failure: null as string | null,
              finished: false,
              changesetId: undefined as string | undefined,
              review: undefined as ProposalReview | undefined,
            };
            let stepText = "";

            const { sawDone } = await readAgentStream(response.body, (event) => {
              if (event.type === "thinking") {
                setAgentActivity("Thinking about your repository…");
                return;
              }
              if (event.type === "delta") {
                // One step's prose can follow another's; a paragraph break keeps
                // two rounds of writing from running together.
                if (!stepText && content.trim()) content += "\n\n";
                content += event.text;
                stepText += event.text;
                setAgentActivity(null);
                schedulePatch();
                return;
              }
              if (event.type === "step") {
                steps[stepOffset + event.index] = event.step;
                setAgentActivity(event.pending ? event.step.label : null);
                schedulePatch();
                return;
              }
              if (event.type === "error") {
                state.failure = event.error;
                return;
              }

              // The prose already arrived as deltas; only what the server added on
              // top of it (the turn-budget note) is still missing here.
              if (event.content && event.content.startsWith(stepText)) {
                const rest = event.content.slice(stepText.length).replace(/^\s+/, "");
                if (rest) content = content ? `${content}\n\n${rest}` : rest;
              } else if (!stepText && event.content) {
                content = content ? `${content}\n\n${event.content}` : event.content;
              }
              for (const [index, step] of event.steps.entries()) steps[stepOffset + index] = step;
              if (event.transcript.length > 0) transcript = event.transcript;
              if (event.turnToken) turnToken = event.turnToken;
              if (event.model) answerModel = event.model;
              if (event.changesetId) state.changesetId = event.changesetId;
              if (event.review) state.review = event.review;
              // The id follows the answer, so the review card survives a reload and
              // still points at the change the server signed.
              if (event.changesetWarning) setModelNotice(event.changesetWarning);
              if (event.usage.prompt || event.usage.completion) {
                void writeUsage(assistantId, {
                  prompt: event.usage.prompt,
                  completion: event.usage.completion,
                  total: event.usage.prompt + event.usage.completion,
                });
              }
              state.finished = event.done;
            });

            await flushPatches();
            // Step N+1 can be asked for by a different tab than the one that ran
            // step N, as long as what this loop has reached is on disk. Only once a
            // turn token exists: a run without one would start a fresh turn rather
            // than continue this one.
            if (!state.finished && turnToken && chatId) {
              await saveAgentRun({
                id: assistantId,
                chatId,
                projectId: project.id,
                transcript,
                turnToken,
                context: turnContext,
                content,
                steps: steps.filter(Boolean).map((step) => ({ tool: step.tool, label: step.label, ok: step.ok })),
              });
            }
            if (state.changesetId) {
              await patchMessage(assistantId, {
                changesetId: state.changesetId,
                ...(state.review ? { review: state.review } : {}),
              });
            }

            if (state.failure) {
              noteRateLimit(state.failure);
              await markError(assistantId, state.failure);
              return;
            }
            if (!state.finished && !sawDone) {
              await markError(assistantId, "The agent connection dropped before it finished. Try again.");
              return;
            }
            if (state.finished) break;
          }

          if (!content.trim() && steps.filter(Boolean).length === 0 && !controller.signal.aborted) {
            await markError(assistantId, "The agent did not return an answer. Try asking again.");
          }
          return;
        }

        // ── Follow it ────────────────────────────────────────────────────────
        // Polling rather than streaming, because the answer is being written by
        // the server either way: this loop only renders it.
        while (!controller.signal.aborted) {
          const poll = await fetch(`/api/agent/runs/${runId}`, {
            headers: { ...(await authHeader()) },
            cache: "no-store",
            signal: controller.signal,
          });

          if (poll.status === 404) {
            await markError(assistantId, "This run is no longer available. Ask again.");
            return;
          }

          if (poll.ok) {
            const { run } = (await poll.json().catch(() => ({}))) as { run?: AgentRunPayload };
            if (run) {
              if (run.content && run.content !== content) {
                content = run.content;
                steps.splice(0, steps.length, ...run.steps);
                writeNow();
              }
              if (run.changesetId) {
                await patchMessage(assistantId, {
                  changesetId: run.changesetId,
                  ...(run.review ? { review: run.review } : {}),
                });
              }
              if (run.status !== "running") {
                await flushPatches();
                if (run.error) {
                  await markError(assistantId, run.error);
                  return;
                }
                if (run.usage.prompt || run.usage.completion) {
                  await writeUsage(assistantId, {
                    prompt: run.usage.prompt,
                    completion: run.usage.completion,
                    total: run.usage.prompt + run.usage.completion,
                  });
                }
                if (run.truncated) await patchMessage(assistantId, { truncated: true });
                if (!content.trim() && steps.length === 0) {
                  await markError(assistantId, "The agent did not return an answer. Try asking again.");
                }
                return;
              }
            }
          }

          // A failed poll is not a failed run: it is still going, on the server.
          await pause(1200, controller.signal);
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (!aborted) {
          await markError(assistantId, error instanceof Error ? error.message : "The agent request failed.");
        }
        if (aborted) {
          const row = await readMessage(assistantId);
          if (row && !row.content) {
            await db.messages.delete(assistantId);
          }
        }
      } finally {
        // A tool that was still running when the turn stopped must not be left
        // looking live on the next load: the stored copy is what a reload reads,
        // and nothing is going to finish that step now.
        if (steps.some((step) => step?.running)) {
          await patchMessage(assistantId, {
            steps: steps.filter(Boolean).map((step) => ({ tool: step.tool, label: step.label, ok: step.ok })),
          });
        }
        // The turn is over, however it ended: a finished answer, an error or a
        // deliberate stop must not be resumed later. A tab that is simply closed
        // never reaches this — and that is exactly the case worth resuming.
        await clearAgentRun(assistantId);
        setAgentActivity(null);
        setStreamingId(null);
        abortRef.current = null;
        void refreshDew();
      }
    },
    [activeChatId, appendUserMessage, appendAssistantMessage, branchAnswer, dropFromMessage, markError, noteRateLimit, patchMessage, project, readMessage, streamingId, threadHistory, writeUsage]
  );

  // ── A turn that outlived its tab ───────────────────────────────────────────
  //
  // The loop is client-driven, so closing the tab ends it — but only in the
  // sense that nobody asks for the next step. Everything it reached is on disk,
  // so this picks it up once the repository is known, instead of leaving a
  // half-finished answer behind with no way to continue it.
  const resumeCheckedRef = useRef(false);
  useEffect(() => {
    if (!project || streamingId || resumeCheckedRef.current) return;
    resumeCheckedRef.current = true;
    let cancelled = false;
    void (async () => {
      const run = await nextResumableAgentRun(project.id);
      if (!run || cancelled) return;
      const row = await readMessage(run.id);
      // A record with no run id predates server-side runs: its state is gone, so
      // it is dropped rather than replayed into a message that has moved on.
      if (!run.runId || !row || row.error) {
        await clearAgentRun(run.id);
        return;
      }
      setModelNotice("Picking up the repository turn that was running when this tab closed.");
      void sendAgentMessage("", { resume: run });
    })();
    return () => {
      cancelled = true;
    };
  }, [project, streamingId, sendAgentMessage, readMessage]);

  /**
   * Starts an hour for the composed message and sends it.
   *
   * The hour is bought for exactly what the message needs: the model it would run
   * on and, for the agent, the repository in front of the user. `endFirst` is the
   * "end it and start a new hour here" answer to the server's lock refusal — the
   * live hour is never replaced silently.
   */
  const runHourStart = useCallback(
    async (payload: NonNullable<typeof pricingPrompt>, endFirst: boolean) => {
      if (pricingBusy) return;
      setPricingBusy(true);
      setPricingNotice(null);
      try {
        if (endFirst) {
          await requestEndHourSession();
          setHourSession(null);
        }
        const started = await requestHourSession(payload.model, payload.projectId);
        if (started.ok) {
          setHourSession(started.session);
          setPricingPrompt(null);
          void refreshDew();
          if (payload.agent) void sendAgentMessage(payload.text, { documents: payload.documents });
          else void sendMessage(payload.text, payload.images, payload.documents);
          return;
        }
        if (started.code === "session-active" && started.session) {
          // The hour already running is this account's own and covers this
          // request, so there is nothing to choose between: use it.
          setHourSession(started.session);
          setPricingPrompt(null);
          void refreshDew();
          if (payload.agent) void sendAgentMessage(payload.text, { documents: payload.documents });
          else void sendMessage(payload.text, payload.images, payload.documents);
          return;
        }
        if (started.code === "session-model-locked" || started.code === "session-repo-locked") {
          // The live hour is for something else. It stays until the buyer ends it
          // deliberately, so the dialog says so and offers that second step.
          setPricingNotice(started.error ?? "The hour that is running is for another model or repository.");
          if (started.session) setHourSession(started.session);
          return;
        }
        if (started.code === "insufficient-dew") {
          setPricingNotice(
            "Your free Dew and wallet together cannot cover the hour. Top up in the Dew wallet and try again."
          );
          void refreshDew();
          return;
        }
        setPricingNotice(started.error ?? "The hour session could not be started.");
      } finally {
        setPricingBusy(false);
      }
    },
    [pricingBusy, sendAgentMessage, sendMessage]
  );

  const resolvePricing = useCallback(() => {
    const payload = pricingPrompt;
    if (!payload || pricingBusy) return;
    void runHourStart(payload, false);
  }, [pricingBusy, pricingPrompt, runHourStart]);

  /** The buyer's answer to a live hour for something else: end it, then buy this. */
  const resolveReplace = useCallback(() => {
    const payload = pricingPrompt;
    if (!payload || pricingBusy) return;
    void runHourStart(payload, true);
  }, [pricingBusy, pricingPrompt, runHourStart]);

  const handleEndHour = useCallback(async () => {
    await requestEndHourSession();
    setHourSession(null);
    void refreshDew();
    setModelNotice("Hour session ended. Start a new hour to keep chatting.");
  }, []);

  const handleSend = useCallback(
    (text: string, images: ImageAttachment[], documents?: DocumentAttachment[]) => {
      // With a repository attached, a plain question goes to the agent — and so
      // does one carrying text files, whose contents now travel with the turn as
      // its context. Images still fall back to ordinary chat, because the Code
      // model has no vision; the composer refuses one before it can get here.
      const agentTurn = Boolean(project) && images.length === 0;
      // The hour decides which model and repository may answer, so the send is
      // matched against what was actually bought: Code and this repository for
      // the agent, the selected mode for chat. A live hour for something else is
      // never spent here; the dialog names it and offers to end it first.
      const requiredModel: ModeId = agentTurn ? "code" : selectedMode;
      const agentProject = agentTurn ? project : null;
      const covered =
        hourSession !== null &&
        hourSession.model === requiredModel &&
        (!agentProject || hourSession.projectId === agentProject.id);
      if (!draftId && !covered) {
        setPricingNotice(null);
        setPricingPrompt({
          text,
          images,
          documents: documents ?? [],
          agent: agentTurn,
          model: requiredModel,
          projectId: agentProject?.id ?? null,
          repoFullName: agentProject?.repoFullName ?? null,
          conflict: hourSession ? hourConflictLabel(hourSession, requiredModel, agentProject) : null,
        });
        return;
      }
      if (agentTurn) void sendAgentMessage(text, { documents });
      else void sendMessage(text, images, documents);
    },
    [hourSession, project, selectedMode, sendAgentMessage, sendMessage, draftId]
  );

  // With a repository attached, an answer was produced by the agent and has to
  // be regenerated by it. Sending it back through plain chat would answer the
  // same question with no repository access and no way to tell the difference.
  const handleRegenerate = useCallback(
    (assistantId: string) => {
      if (project) {
        void sendAgentMessage("", { regenerateAssistantId: assistantId });
        return;
      }
      void sendMessage("", [], [], { regenerateAssistantId: assistantId });
    },
    [project, sendAgentMessage, sendMessage]
  );

  // A read-only answer that describes a change is not a proposal. This asks the
  // agent to stage one as a new Code turn — the flat request price is charged
  // once, and nothing reaches GitHub until the diff is approved.
  const handlePropose = useCallback(
    (_assistantId: string) => {
      if (!project || streamingId) return;
      void sendAgentMessage(
        "Stage the change you just described as a proposal for me to review. Read every file you plan to edit first, then call propose_edits once with the smallest set of edits. Do not commit anything; I will review the diff."
      );
    },
    [project, sendAgentMessage, streamingId]
  );

  const handleEditMessage = useCallback(
    (messageId: string, content: string) => {
      // Same rule as regenerating: with a repository attached, the answer has to
      // come from the agent, because only it can actually read the files the
      // question is about.
      if (project) {
        void sendAgentMessage(content, { editMessageId: messageId });
        return;
      }
      void sendMessage(content, [], [], { editMessageId: messageId });
    },
    [project, sendAgentMessage, sendMessage]
  );

  /** Which answer is on screen for a message that has more than one. */
  const handleSwitchVariant = useCallback(
    (messageId: string, index: number | null) => {
      // A pointer change and nothing else — the stored answer is untouched, so
      // browsing back through previous answers cannot rewrite the transcript.
      // `undefined` rather than `null` because that is what removes the field
      // from the row, and "no index" is the live answer.
      void patchMessage(messageId, { variantIndex: index ?? undefined });
    },
    [patchMessage]
  );

  const threadMessages = messages;

  const handleCopyConversation = useCallback(async () => {
    const text = threadMessages.map((message) => `${message.role === "user" ? "You" : "Openmi"}: ${message.content}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setModelNotice("Conversation copied to your clipboard");
    } catch {
      setModelNotice("Clipboard access is unavailable in this browser");
    }
  }, [threadMessages]);

  // The Focus home is the empty screen only. A conversation keeps the thread
  // and the thread's composer; the layout still owns the palette.
  const focusHome = homeLayout === "focus" && messages.length === 0;

  const isStreaming = streamingId !== null;
  // The message being drawn has no content yet, so it is kept explicitly to
  // show the drawing placeholder.
  const temporary = false;
  // A question made only of an attachment has no text at all; images were
  // already admitted, and documents have to be too, or a file-only question
  // disappears from the thread the moment it is sent.
  const visibleMessages = threadMessages.filter(
    (m) => m.content || m.images || m.documents?.length || m.error || (m.steps && m.steps.length > 0)
  );

  // The composer's context ring reads the last completed request's real prompt
  // count — the number the server actually sent and metered. Scanning backwards
  // rather than looking only at the final message keeps the last known number
  // on screen while the next turn is being written, instead of blanking it.
  let contextUsed = 0;
  for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
    const usage = visibleMessages[i]?.usage;
    if (usage?.prompt) {
      contextUsed = usage.prompt;
      break;
    }
  }

  // Nothing is rendered until localStorage has been read, so a returning
  // visitor never sees the chat flash before their name is known.        if (!hydrated) return null;

  // Maintenance replaces the page outright rather than covering it, so
  // nothing behind the notice is mounted and there is nothing to navigate to.
  if (!maintenance.resolved) return null;
  if (maintenance.active) {
    return (
      <>
        <MaintenanceScreen message={maintenance.message} />
      </>
    );
  }

  // The first identity read is in flight. A blank screen with the mark is the
  // honest thing here: either the sign-in screen or the product follows, and
  // guessing which would flash the wrong one.
  if (!account) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-canvas text-text-body">
        <Spinner variant="dew" size={30} label="Loading Openmi" className="text-[#a9d8bb]" />
      </div>
    );
  }

  // Openmi requires an account. There is no guest path and no skip: this route
  // is the product, so a visitor without a session meets the sign-in screen,
  // with a way back to the marketing page behind it.
  if (!account.signedIn) {
    return (
      <>
        <AuthScreen
          backHref="/"
          initialError={authError}
          unavailable={
            account.status === "unconfigured"
              ? "unconfigured"
              : account.status === "unreachable"
                ? "unreachable"
                : null
          }
        />
      </>
    );
  }

  // The local history has to belong to this account before any of it is shown:
  // the sidebar reads IndexedDB, and until the handover has run that database
  // still holds whoever was signed in here before.
  if (deviceAccount !== account.id) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-canvas text-text-body">
        <Spinner variant="dew" size={30} label="Loading Openmi" className="text-[#a9d8bb]" />
      </div>
    );
  }

  // Signed in, and the name is being written to this browser from the account.
  // This is a single bounded read, not a gate on the product.
  if (!displayName) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-canvas text-text-body">
        <Spinner variant="dew" size={30} label="Loading Openmi" className="text-[#a9d8bb]" />
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-canvas text-text-body">
      <Sidebar
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        draftId={draftId}
        onToggleDraft={toggleDraft}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setSidebarOpen(false);
        }}
        displayName={displayName}
        avatarUrl={avatarUrl}
        onOpenRepo={() => {
          setRepoOpen(true);
          setSidebarOpen(false);
        }}
      />

      <main className="app-surface relative flex min-w-0 flex-1 flex-col overflow-hidden animate-view-in">
        <div className="surface-glow pointer-events-none absolute inset-0" aria-hidden />

        <header
          className={`safe-top relative z-20 flex h-16 shrink-0 items-center gap-3 px-4 md:px-6 ${
            focusHome ? "border-0 bg-transparent" : "border-b border-line bg-card"
          }`}
        >
          {focusHome ? (
            <>
              <button
                onClick={() => setSidebarOpen(true)}
                className="lift flex h-9 w-9 items-center justify-center rounded-lg text-text-body transition-colors hover:bg-white/[0.06] hover:text-white md:hidden"
                aria-label="Open sidebar"
              >
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4.5" width="18" height="15" rx="3.5" />
                  <path d="M9.5 4.5v15" />
                </svg>
              </button>
              <h1 className="min-w-0 flex-1 truncate text-[20px] font-normal tracking-[-0.01em] text-white">
                New chat
              </h1>
              {/* The phone keeps the design's two icons; from `md` up there is
                  room for the mode selector, so Focus does not hide the only
                  way to switch between Auto and Code. */}
              <div className="hidden shrink-0 md:flex">
                <ModeSelector
                  selected={selectedMode}
                  onChange={handleModeChange}
                  available={available}
                />
              </div>
              <button
                onClick={handleNewChat}
                className="lift flex h-9 w-9 items-center justify-center rounded-lg text-text-body transition-colors hover:bg-white/[0.06] hover:text-white"
                aria-label="Start a new chat"
                title="New chat"
              >
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V12" />
                  <path d="M18.4 2.6a1.9 1.9 0 0 1 2.7 2.7l-8.6 8.6a2.5 2.5 0 0 1-1.1.6l-2.6.7.7-2.6a2.5 2.5 0 0 1 .6-1.1Z" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setSidebarOpen(true)}
                className="lift flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-body transition-colors hover:bg-white/[0.06] hover:text-white md:hidden"
                aria-label="Open menu"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              </button>

              <button
                onClick={handleNewChat}
                className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-2 text-left transition-opacity hover:opacity-80 active:opacity-60"
                aria-label="Start a new Openmi chat"
                title="Openmi"
              >
                <OpenmiMark className="h-7 w-7" />
                <span className="hidden truncate text-[17px] font-medium tracking-[-0.02em] text-white sm:block">
                  {temporary ? "Temporary chat" : "Openmi"}
                </span>
              </button>

              {temporary && (
                <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.045] px-2.5 py-1 text-[11px] text-white/55 sm:inline-flex">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  Not saved
                </span>
              )}

              <div className="flex-1" />
              {/* The repository door, on the header rather than only in the
                  drawer: it is the only screen that shows what the agent can
                  read, and burying it two taps deep made the agent look absent
                  until a project was already attached. The dot says one is. */}
              <button
                type="button"
                onClick={() => setRepoOpen(true)}
                className="lift flex h-9 shrink-0 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-[12px] font-medium text-white/65 transition-colors hover:border-white/15 hover:bg-white/[0.06] hover:text-white"
                aria-label={project ? `Repository: ${project.repoFullName}` : "Choose a repository"}
                title={project ? project.repoFullName : "Repository"}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3v12a3 3 0 0 0 3 3h6" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <path d="M18 9v3a3 3 0 0 1-3 3h-3" />
                </svg>
                <span className="max-w-[110px] truncate sm:max-w-[160px]">
                  {project ? project.repoFullName : "Repository"}
                </span>
                {project && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#7fd1a1]" aria-hidden="true" />
                )}
              </button>
              <ModeSelector
                selected={selectedMode}
                onChange={handleModeChange}
                available={available}
              />
            </>
          )}
        </header>

        {appConfig?.announcement && (
          <div
            role="status"
            className="animate-rise relative z-10 mx-4 mt-1 flex shrink-0 items-center justify-center self-center rounded-full border border-[#a9d8bb]/15 bg-[#a9d8bb]/[0.06] px-3.5 py-2 text-center text-[11px] leading-relaxed text-white/70 backdrop-blur-md md:max-w-xl"
          >
            {appConfig.announcement}
          </div>
        )}

        {modelNotice && (
          <div
            role="status"
            className="relative z-10 mx-4 mt-1 flex shrink-0 items-center justify-center gap-2 self-center rounded-full border border-white/[0.07] bg-white/[0.045] px-3.5 py-2 text-center text-[11px] leading-relaxed text-white/55 backdrop-blur-md md:max-w-xl"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#a9d8bb]" />
            <span>{modelNotice}</span>
          </div>
        )}

        {loggingError && (
          <div role="alert" className="relative z-10 mx-4 mt-1 flex shrink-0 items-center justify-center self-center rounded-full border border-red-400/20 bg-red-500/[0.08] px-3.5 py-2 text-center text-[11px] font-medium tracking-[0.08em] text-red-200/90 backdrop-blur-md animate-rise">
            LG FAILED
          </div>
        )}

        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {focusHome ? (
              <FocusHome project={project} onOpenRepo={() => setRepoOpen(true)} />
            ) : (
              <ChatThread
                messages={visibleMessages}
                streamingId={streamingId}
                isEmpty={visibleMessages.length === 0}
                onRegenerate={handleRegenerate}
                onEditMessage={handleEditMessage}
                onCopyConversation={handleCopyConversation}
                onSwitchVariant={handleSwitchVariant}
                activity={agentActivity}
                onPropose={handlePropose}
                agentRepo={project?.repoFullName ?? null}
              />
            )}
            {project && !focusHome && (
              <div className="mx-auto mb-1 flex w-full max-w-4xl items-center gap-2 px-4 md:px-7">
                <button
                  type="button"
                  onClick={() => setRepoOpen(true)}
                  className="flex min-w-0 items-center gap-2 rounded-full border border-[#a9d8bb]/15 bg-[#a9d8bb]/[0.05] px-3 py-1 text-[10.5px] text-white/60 transition-colors hover:border-[#a9d8bb]/30 hover:text-white/85"
                  title="Open the repository workspace"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#7fd1a1]" />
                  <span className="min-w-0 truncate font-mono">{project.repoFullName}</span>
                  <span className="shrink-0 text-white/25">@{project.baseSha.slice(0, 7)}</span>
                </button>
                {/* The word here used to be "read-only", which described the
                    file viewer but read as a statement about the agent. The
                    agent reads and proposes; only an approval commits. */}
                <span
                  className="shrink-0 cursor-help text-[10px] text-[#a9d8bb]/55"
                  title="The file viewer is read-only. The agent can read this repository and propose a diff; nothing is committed until you approve it."
                >
                  reads · proposes
                </span>
                <button
                  type="button"
                  onClick={() => setProject(null)}
                  className="ml-auto shrink-0 rounded-full px-2 py-1 text-[10px] text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/70"
                >
                  Leave repo
                </button>
              </div>
            )}
            {/* The mandatory unit, directly above the composer and inside its
                own reserved height. Not in a temporary chat (nothing there is
                written down or kept), not on Focus home (the screen exists to
                have no furniture), and not when the administrator's kill
                switch is off. The id/slot gate lives in the component. */}
            {hourSession && (
              <div
                role="status"
                className="mx-4 mb-1 flex items-center gap-2 rounded-full border border-[#a9d8bb]/15 bg-[#a9d8bb]/[0.06] px-3.5 py-2 text-[11px] leading-relaxed text-white/65 backdrop-blur-md"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#a9d8bb]" />
                <span className="min-w-0 truncate">
                  Hour · {getMode(hourSession.model).display}
                  {hourSession.repoFullName ? ` · ${hourSession.repoFullName}` : ""} · ends{" "}
                  {new Date(hourSession.expiresAt).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => void handleEndHour()}
                  className="ml-auto shrink-0 rounded-full px-2 py-0.5 font-medium text-[#a9d8bb] transition-colors hover:bg-[#a9d8bb]/10"
                >
                  End
                </button>
              </div>
            )}
            {!focusHome && (
              <>
                <AdBanner enabled={appConfig?.adsEnabled !== false} />
                {/* Same screens and the same switch as the banner: a popunder
                    in a temporary chat would break the one promise that
                    screen makes. */}
                <AdPopunder enabled={appConfig?.adsEnabled !== false} showTrigger />
              </>
            )}
            <ChatInput
              onSend={handleSend}
              disabled={isStreaming}
              onStop={stopStreaming}
              rateLimitUntil={rateLimitUntil}
              contextUsed={contextUsed}
              contextBudget={contextBudget ?? undefined}
              capabilities={modeCapabilities(selectedMode)}
              streaming={isStreaming}
              onNewChat={handleNewChat}
              focusMode={
                focusHome
                  ? { responseLength, onChange: handleResponseLengthChange }
                  : null
              }
            />
          </div>

        </div>
      </main>

      {pricingPrompt && (
        <PricingDialog
          modeLabel={getMode(pricingPrompt.model).display}
          repoLabel={pricingPrompt.repoFullName}
          priceDew={DEW_PER_HOUR}
          balance={dew.balance}
          dailyRemaining={dew.dailyRemaining}
          paid={dew.paid}
          busy={pricingBusy}
          notice={pricingNotice}
          conflict={pricingPrompt.conflict}
          onStart={resolvePricing}
          onReplace={resolveReplace}
          onClose={() => {
            if (!pricingBusy) {
              setPricingPrompt(null);
              setPricingNotice(null);
            }
          }}
        />
      )}

      <RepoPanel
        open={repoOpen}
        onClose={() => setRepoOpen(false)}
        project={project}
        onSelectProject={setProject}
        lockedProject={
          hourSession?.projectId
            ? { id: hourSession.projectId, repoFullName: hourSession.repoFullName ?? "the active repository" }
            : null
        }
      />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        displayName={displayName}
        onDisplayNameChange={handleSaveName}
        avatarUrl={avatarUrl}
        onAvatarChange={handleSaveAvatar}
        searchMode={searchMode}
        onSearchModeChange={handleSearchModeChange}
        searchAvailable={searchAvailable}
        responseLength={responseLength}
        onResponseLengthChange={handleResponseLengthChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={handleReasoningEffortChange}
        appearance={appearance}
        onAppearanceChange={handleAppearanceChange}
        homeLayout={homeLayout}
        onHomeLayoutChange={handleHomeLayoutChange}
      />


    </div>
  );
}

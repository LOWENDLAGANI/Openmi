"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Sidebar from "@/components/Sidebar";
import ChatThread from "@/components/ChatThread";
import ChatInput from "@/components/ChatInput";
import ModeSelector from "@/components/ModelSelector";
import OpenmiMark from "@/components/OpenmiMark";
import OpenmiTutorial from "@/components/OpenmiTutorial";
import SettingsPanel from "@/components/SettingsPanel";
import RepoPanel from "@/components/RepoPanel";
import type { ProjectSummary } from "@/lib/projects";
import AuthScreen from "@/components/AuthScreen";
import MaintenanceScreen from "@/components/MaintenanceScreen";
import { loadDisplayName, saveDisplayName } from "@/lib/visitorName";
import {
  flushTrashDecisions,
  loadChatsFromAccount,
  loadFoldersFromAccount,
  loadTrashFromAccount,
  syncCloudHistory,
  syncFoldersToAccount,
  syncLocalTrash,
  syncVisitorProfile,
} from "@/lib/cloudHistory";
import { consumeOAuthError, loadAccountName, saveAccountName, watchAccount } from "@/lib/account";
import { describeLinkError, normalizeName, type AccountView } from "@/lib/accountState";
import {
  DEFAULT_PREFERENCES,
  loadCloudPreferences,
  loadLocalPreferences,
  saveCloudPreferences,
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
import { DEFAULT_MODE_ID, getMode, type ModeId } from "@/lib/models";
import { refreshDew } from "@/lib/useDew";
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
} from "@/lib/types";
import {
  DEFAULT_APPEARANCE,
  saveAppearance,
  type Appearance,
  type ReasoningEffort,
  type ResponseLength,
} from "@/lib/settings";
import { authHeader } from "@/lib/supabase";
import { subscribeAppConfig, type AppConfig } from "@/lib/appConfig";
import { displayedContent, retireCurrentAnswer } from "@/lib/variants";
import { TempThread, type MessageInput } from "@/lib/tempChat";
import { purgeTrash } from "@/lib/trash";
import { parseRetrySeconds } from "@/lib/rateLimit";

/** The chat id a temporary thread uses. It is never a row in the database — it
    exists only so the send path has one variable to address either kind of
    chat by, and it can never collide with a real id, which is a uuid. */
const TEMP_CHAT_ID = "temporary";

/** The most the account-resolution gate will wait on one remote answer — 3 s
    is comfortably longer than a healthy single read. A held-open socket is a
    question the network may never answer, and waiting forever on it is what
    left returning visitors staring at a pulsing logo. */
const ACCOUNT_NAME_TIMEOUT_MS = 3_000;

import { useMaintenance } from "@/lib/useMaintenance";
import SplashScreen from "@/components/SplashScreen";
import InstallPrompt from "@/components/InstallPrompt";

// ── Openmi — main client orchestration: modes, streaming, chats ────────────────

interface SessionUsage {
  prompt: number;
  completion: number;
  total: number;
}

interface SendOptions {
  editMessageId?: string;
  regenerateAssistantId?: string;
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
  const [hydrated, setHydrated] = useState(false);
  // Null while the first identity read is still in flight. `signedIn: false`
  // after that is a real answer: the sign-in screen is the interface.
  const [account, setAccount] = useState<AccountView | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const preferencesRef = useRef<UserPreferences>(DEFAULT_PREFERENCES);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [searchAvailable, setSearchAvailable] = useState(false);
  const [tutorialFinished, setTutorialFinished] = useState(false);
  const [responseLength, setResponseLength] = useState<ResponseLength>("balanced");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("low");
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [loggingError, setLoggingError] = useState(false);
  // Epoch ms until the server has asked the composer to hold off, set from the
  // wait the server itself names in a 429 — never guessed locally.
  const [rateLimitUntil, setRateLimitUntil] = useState<number | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const maintenance = useMaintenance();
  const abortRef = useRef<AbortController | null>(null);
  // ── Temporary chat ─────────────────────────────────────────────────────────
  // A conversation that is never written down: not to IndexedDB, and therefore
  // not to the account either, since everything uploaded to the account starts as
  // a local row. The thread lives in this component and in this ref — nothing
  // else is allowed to keep a copy.
  const [temporary, setTemporary] = useState(false);
  const tempThreadRef = useRef(new TempThread());
  const [tempMessages, setTempMessages] = useState<ChatMessage[]>([]);

  /** Publishes the thread to React after any change, so the screen follows a
      message being written exactly as it follows one read from the database. */
  const publishTemp = useCallback(() => {
    setTempMessages(tempThreadRef.current.list());
  }, []);

  const endTemporary = useCallback(() => {
    tempThreadRef.current.clear();
    setTempMessages([]);
    setTemporary(false);
  }, []);

  const startTemporary = useCallback(() => {
    abortRef.current?.abort();
    setStreamingId(null);
    tempThreadRef.current.clear();
    setTempMessages([]);
    setActiveChatId(null);
    setModelNotice(null);
    setTemporary(true);
    setSidebarOpen(false);
  }, []);

  const toggleTemporary = useCallback(() => {
    if (temporary) endTemporary();
    else startTemporary();
  }, [endTemporary, startTemporary, temporary]);
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = useLiveQuery(
    async () => {
      if (!activeChatId) return [] as ChatMessage[];
      return db.messages.where("chatId").equals(activeChatId).sortBy("createdAt");
    },
    [activeChatId],
    [] as ChatMessage[]
  );

  const chats = useLiveQuery(() => db.chats.orderBy("updatedAt").reverse().toArray(), [], []);

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
    saveAppearance(local.appearance);
    setSearchMode(local.searchMode);
    setTutorialFinished(local.tutorialFinished);
    setDisplayName(local.displayName ?? "");
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

  // Signing out clears this device's copy of the name. The next account on this
  // browser must not inherit the previous person's greeting; the account keeps
  // its own name in `profiles` and `user_preferences`.
  useEffect(() => {
    if (account?.signedIn !== false) return;
    saveDisplayName("");
    setDisplayName("");
  }, [account?.signedIn]);

  // ── Once a session exists ───────────────────────────────────────────────
  // Resolve the name, adopt the account's preferences, and pull the account's
  // chat history. The history pull is unawaited: a long backfill must not hold
  // the first paint, and the live Dexie query already watching `chats` puts the
  // conversations on screen the moment they land.
  useEffect(() => {
    if (!hydrated || !account?.signedIn) return;
    let cancelled = false;

    void (async () => {
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

      const cloud = await loadCloudPreferences();
      if (cancelled) return;
      const current = preferencesRef.current;
      const merged: UserPreferences = cloud
        ? {
            ...cloud,
            displayName: chosen || cloud.displayName,
            // Seeing the tour once is enough on any browser. The other choices
            // follow the account exactly.
            tutorialFinished: cloud.tutorialFinished || current.tutorialFinished,
          }
        : { ...current, displayName: chosen };
      preferencesRef.current = merged;
      setAppearance(merged.appearance);
      setResponseLength(merged.responseLength);
      setReasoningEffort(merged.reasoningEffort);
      setSearchMode(merged.searchMode);
      setTutorialFinished(merged.tutorialFinished);
      setSelectedMode(merged.model ?? current.model ?? DEFAULT_MODE_ID);
      saveLocalPreferences(merged);
      if (!cloud || !cloud.displayName) void saveCloudPreferences(merged);

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
  }, [hydrated, account?.signedIn, chats, messages]);

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
    void saveCloudPreferences(next);
    void saveAccountName(saved);
    void syncVisitorProfile(saved).catch((error: unknown) => {
      console.error("[Openmi] Could not log the visitor name", error);
    });
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
    void saveCloudPreferences(next);
  }, []);

  // Probe which modes have keys configured server-side (may be empty).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        available?: ModeId[];
        searchAvailable?: boolean;
      };
      if (Array.isArray(detail.available)) setAvailable(detail.available);
      if (typeof detail.searchAvailable === "boolean") setSearchAvailable(detail.searchAvailable);
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

  // Switching modes is not a mid-conversation toggle. Code mode is pinned to the
  // Openmi V3/V2/V1 family for code-generation accuracy, and continuing a chat
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
      const key = mode === "code" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY";
      const needs = mode === "code" ? "a Gemini API key" : "an OpenRouter API key";
      setModelNotice(
        `${name} isn't available on this deployment yet. It needs ${needs} (${key}) configured by the site owner. Once added, it becomes selectable automatically.`
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
    persistPreferences({ appearance: value });
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
    // A new chat is a chat you meant to keep, so a temporary thread ends here
    // rather than silently turning into one that is written down.
    if (temporary) endTemporary();
  }, [endTemporary, temporary]);

  const handleSelectChat = useCallback((chatId: string) => {
    abortRef.current?.abort();
    setStreamingId(null);
    setActiveChatId(chatId);
    setSidebarOpen(false);
    setModelNotice(null);
    if (temporary) endTemporary();
  }, [endTemporary, temporary]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Turning the server's own refusal into a countdown the composer can show.
  // Anything without a named wait in it is a plain error and changes nothing.
  const noteRateLimit = useCallback((message: string) => {
    const seconds = parseRetrySeconds(message);
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

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const finishTutorial = useCallback(() => {
    setTutorialFinished(true);
    persistPreferences({ tutorialFinished: true });
  }, [persistPreferences]);

  // ── Where a message is written ─────────────────────────────────────────────
  // One set of calls for both kinds of chat, so the send path below has no
  // `if (temporary)` in it. A temporary message goes to the in-memory thread and
  // nowhere else; a real one goes to Dexie, and the account sync picks it up
  // there exactly as it always has.
  const appendMessage = useCallback(
    async (input: MessageInput): Promise<ChatMessage> => {
      if (!temporary) return addMessage(input);
      const message = tempThreadRef.current.append(input);
      publishTemp();
      return message;
    },
    [publishTemp, temporary]
  );

  const patchMessage = useCallback(
    async (id: string, changes: Partial<ChatMessage>): Promise<void> => {
      if (!temporary) {
        await db.messages.update(id, changes);
        return;
      }
      tempThreadRef.current.patch(id, changes);
      publishTemp();
    },
    [publishTemp, temporary]
  );

  const writeContent = useCallback(
    async (id: string, content: string): Promise<void> => patchMessage(id, { content }),
    [patchMessage]
  );
  const markError = useCallback(
    async (id: string, error: string): Promise<void> => patchMessage(id, { error }),
    [patchMessage]
  );
  const writeUsage = useCallback(
    async (
      id: string,
      usage: { prompt: number; completion: number; total: number }
    ): Promise<void> => patchMessage(id, { usage }),
    [patchMessage]
  );

  const readMessage = useCallback(
    async (id: string): Promise<ChatMessage | undefined> =>
      temporary ? tempThreadRef.current.get(id) : db.messages.get(id),
    [temporary]
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
      if (!temporary) {
        await db.messages
          .where("chatId")
          .equals(chatId)
          .filter((message) => (inclusive ? message.createdAt >= createdAt : message.createdAt > createdAt))
          .delete();
        return;
      }
      tempThreadRef.current.dropFrom(id, inclusive);
      publishTemp();
    },
    [publishTemp, temporary]
  );

  /** The conversation so far, in the order the model must read it.

      The chat to read is passed in rather than taken from `activeChatId`: the
      first message of a new chat is sent before React has re-rendered, so that
      state still holds the previous value — or nothing at all — and reading it
      here would hand the server an empty transcript. */
  const threadHistory = useCallback(
    async (chatId: string): Promise<ChatMessage[]> => {
      if (temporary) return tempThreadRef.current.list();
      return db.messages.where("chatId").equals(chatId).sortBy("createdAt");
    },
    [temporary]
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

      let chatId: string | null = temporary ? TEMP_CHAT_ID : activeChatId;
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
        }
        await appendMessage({
          chatId,
          role: "user",
          content: text,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
        });
        // A temporary thread has no row to carry a title, so there is nothing
        // to name.
        if (!temporary) await maybeAutoTitle(chatId, text || "Attachment conversation");
      }
      if (!chatId) return;
      if (!temporary) setActiveChatId(chatId);

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
        (await appendMessage({ chatId, role: "assistant", content: "", model: getMode(selectedMode).display }));
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
            searchMode,
            responseLength,
            reasoningEffort,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          const message = payload?.error || `Openmi request failed (HTTP ${res.status})`;
          noteRateLimit(message);
          throw new Error(message);
        }
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
            const evt = JSON.parse(data) as { content?: string; error?: string; model?: string; truncated?: boolean; usage?: SessionUsage; search?: { used: boolean; query?: string; sources?: SearchSource[] } };
            if (evt.model) {
              await patchMessage(assistantMsg.id, { model: evt.model });
              if (evt.model !== getMode(selectedMode).display) setModelNotice("The model was changed automatically because the current model is experiencing a problem.");
            }
            if (evt.error) {
              // The server refuses inside the stream as well as before it, so
              // the countdown is read from both places.
              noteRateLimit(evt.error);
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
            if (temporary) {
              tempThreadRef.current.drop(assistantMsg.id);
              publishTemp();
            } else {
              await db.messages.delete(assistantMsg.id);
            }
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
    [activeChatId, appendMessage, branchAnswer, dropFromMessage, markError, noteRateLimit, patchMessage, publishTemp, readMessage, reasoningEffort, responseLength, searchMode, selectedMode, streamingId, temporary, threadHistory, writeContent, writeUsage]
  );

  // ── The repository agent ───────────────────────────────────────────────────
  //
  // One turn is one paid request: the first step charges the flat Code price and
  // returns a signed token that lets the rest of the turn continue without a
  // second charge. The client drives the loop so Stop cancels the request in
  // flight, and each read is written into the message as it happens.
  const sendAgentMessage = useCallback(
    async (text: string, options?: { regenerateAssistantId?: string; editMessageId?: string }) => {
      if (!project || streamingId) return;
      let chatId: string | null = temporary ? TEMP_CHAT_ID : activeChatId;
      let assistantId: string;

      // Editing a question with a repository attached has to go through the
      // agent. Sending it to ordinary chat would answer the same wording with no
      // repository access at all — and look exactly like a normal answer, which
      // is the worst way for the two to differ.
      if (options?.editMessageId) {
        const original = await readMessage(options.editMessageId);
        if (!original || original.role !== "user") return;
        chatId = original.chatId;
        await patchMessage(original.id, { content: text, error: undefined });
        // Everything after the edited question belonged to the answer it is
        // replacing, so it goes with it.
        await dropFromMessage(chatId, original.id, original.createdAt, false);
        const assistant = await appendMessage({
          chatId,
          role: "assistant",
          content: "",
          model: getMode("code").display,
        });
        assistantId = assistant.id;
        if (!temporary) setActiveChatId(chatId);
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
          await appendMessage({ chatId, role: "user", content: text });
          if (!temporary) await maybeAutoTitle(chatId, text);
          const assistant = await appendMessage({
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

      const history = (await threadHistory(chatId))
        .filter((entry) => entry.role !== "system" && entry.content.trim().length > 0)
        .map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.content }));

      const controller = new AbortController();
      abortRef.current = controller;
      let transcript: unknown[] = [];
      let turnToken: string | undefined;
      let content = "";
      const steps: AgentStep[] = [];

      try {
        for (let step = 0; step < 10; step += 1) {
          const response = await fetch("/api/agent/step", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await authHeader()) },
            body: JSON.stringify({ projectId: project.id, history, transcript, turnToken }),
            signal: controller.signal,
          });
          const payload = (await response.json().catch(() => null)) as
            | {
                content?: string;
                steps?: AgentStep[];
                transcript?: unknown[];
                turnToken?: string;
                done?: boolean;
                model?: string;
                usage?: { prompt: number; completion: number };
                changesetId?: string | null;
                changesetWarning?: string | null;
                error?: string;
              }
            | null;

          if (!response.ok) {
            const message = payload?.error ?? `The agent request failed (HTTP ${response.status}).`;
            noteRateLimit(message);
            await markError(assistantId, message);
            return;
          }
          if (!payload) {
            await markError(assistantId, "The agent returned an unreadable response.");
            return;
          }

          transcript = payload.transcript ?? transcript;
          turnToken = payload.turnToken ?? turnToken;
          if (payload.steps?.length) steps.push(...payload.steps);
          if (payload.content) content = content ? `${content}\n\n${payload.content}` : payload.content;
          // The id follows the answer, so the review card survives a reload and
          // still points at the change the server signed.
          if (payload.changesetWarning) setModelNotice(payload.changesetWarning);
          await patchMessage(assistantId, {
            content,
            steps: [...steps],
            ...(payload.model ? { model: payload.model } : {}),
            ...(payload.changesetId ? { changesetId: payload.changesetId } : {}),
          });
          if (payload.usage) {
            await writeUsage(assistantId, {
              prompt: payload.usage.prompt,
              completion: payload.usage.completion,
              total: payload.usage.prompt + payload.usage.completion,
            });
          }
          if (payload.done) break;
        }

        if (!content.trim() && steps.length === 0 && !controller.signal.aborted) {
          await markError(assistantId, "The agent did not return an answer. Try asking again.");
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (!aborted) {
          await markError(assistantId, error instanceof Error ? error.message : "The agent request failed.");
        }
        if (aborted) {
          const row = await readMessage(assistantId);
          if (row && !row.content) {
            if (temporary) {
              tempThreadRef.current.drop(assistantId);
              publishTemp();
            } else {
              await db.messages.delete(assistantId);
            }
          }
        }
      } finally {
        setStreamingId(null);
        abortRef.current = null;
        void refreshDew();
      }
    },
    [activeChatId, appendMessage, branchAnswer, dropFromMessage, markError, noteRateLimit, patchMessage, project, publishTemp, readMessage, streamingId, temporary, threadHistory, writeUsage]
  );

  const handleSend = useCallback(
    (text: string, images: ImageAttachment[], documents?: DocumentAttachment[]) => {
      // Someone who has sent a message has decided Openmi is worth a second
      // look, which is the earliest the install prompt can be justified. It
      // arrives as a custom event because the prompt decides for itself
      // whether to ask — this page only reports what happened.
      window.dispatchEvent(new Event("openmi:engage"));
      // With a repository attached, a plain question goes to the agent. Anything
      // carrying attachments stays in ordinary chat: the agent has no way to
      // read an image, and silently dropping one would be worse than saying so.
      if (project && images.length === 0 && (!documents || documents.length === 0)) {
        void sendAgentMessage(text);
        return;
      }
      void sendMessage(text, images, documents);
    },
    [project, sendAgentMessage, sendMessage]
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

  // The conversation on screen: a temporary thread has no database rows to read,
  // so it is read from memory instead.
  const threadMessages = temporary ? tempMessages : messages;

  const handleCopyConversation = useCallback(async () => {
    const text = threadMessages.map((message) => `${message.role === "user" ? "You" : "Openmi"}: ${message.content}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setModelNotice("Conversation copied to your clipboard");
    } catch {
      setModelNotice("Clipboard access is unavailable in this browser");
    }
  }, [threadMessages]);

  const isStreaming = streamingId !== null;
  // The message being drawn has no content yet, so it is kept explicitly to
  // show the drawing placeholder.
  // A question made only of an attachment has no text at all; images were
  // already admitted, and documents have to be too, or a file-only question
  // disappears from the thread the moment it is sent.
  const visibleMessages = threadMessages.filter(
    (m) => m.content || m.images || m.documents?.length || m.error || (m.steps && m.steps.length > 0)
  );

  // Nothing is rendered until localStorage has been read, so a returning
  // visitor never sees the chat flash before their name is known.
  if (!hydrated) return null;

  // Maintenance replaces the page outright rather than covering it, so
  // nothing behind the notice is mounted and there is nothing to navigate to.
  if (!maintenance.resolved) return null;
  if (maintenance.active) {
    return (
      <>
        <MaintenanceScreen message={maintenance.message} />
        <SplashScreen />
      </>
    );
  }

  // The first identity read is in flight. A blank screen with the mark is the
  // honest thing here: either the sign-in screen or the product follows, and
  // guessing which would flash the wrong one.
  if (!account) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-canvas text-text-body">
        <OpenmiMark className="h-8 w-8 animate-pulse" />
        <SplashScreen />
      </div>
    );
  }

  // Openmi requires an account. There is no guest path and no skip: the sign-in
  // screen is the whole interface until a provider or email returns a session.
  if (!account.signedIn) {
    return (
      <>
        <AuthScreen
          initialError={authError}
          unavailable={
            account.status === "unconfigured"
              ? "unconfigured"
              : account.status === "unreachable"
                ? "unreachable"
                : null
          }
        />
        <SplashScreen />
      </>
    );
  }

  // Signed in, and the name is being resolved from the account and written to
  // this browser. This is a single bounded read, not a gate on the product.
  if (!displayName) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-canvas text-text-body">
        <OpenmiMark className="h-8 w-8 animate-pulse" />
        <SplashScreen />
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-canvas text-text-body">
      <Sidebar
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        temporary={temporary}
        onToggleTemporary={toggleTemporary}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setSidebarOpen(false);
        }}
        displayName={displayName}
        onOpenRepo={() => {
          setRepoOpen(true);
          setSidebarOpen(false);
        }}
      />

      <main className="app-surface relative flex min-w-0 flex-1 flex-col overflow-hidden animate-view-in">
        <div className="surface-glow pointer-events-none absolute inset-0" aria-hidden />

        <header className="safe-top relative z-20 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-card px-4 md:px-6">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lift flex h-9 w-9 items-center justify-center rounded-full text-text-body transition-colors hover:bg-white/[0.06] hover:text-white md:hidden"
            aria-label="Open menu"
            data-tutorial="mobile-menu"
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
            <span className="truncate text-[17px] font-medium tracking-[-0.02em] text-white">
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
          <ModeSelector
            selected={selectedMode}
            onChange={handleModeChange}
            available={available}
          />
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
            <ChatThread
              messages={visibleMessages}
              streamingId={streamingId}
              isEmpty={visibleMessages.length === 0}
              onRegenerate={handleRegenerate}
              onEditMessage={handleEditMessage}
              onCopyConversation={handleCopyConversation}
              onSwitchVariant={handleSwitchVariant}
            />
            {project && (
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
                <span className="shrink-0 text-[10px] text-white/25">read-only</span>
                <button
                  type="button"
                  onClick={() => setProject(null)}
                  className="ml-auto shrink-0 rounded-full px-2 py-1 text-[10px] text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/70"
                >
                  Leave repo
                </button>
              </div>
            )}
            <ChatInput
              onSend={handleSend}
              disabled={isStreaming}
              onStop={stopStreaming}
              rateLimitUntil={rateLimitUntil}
            />
          </div>

        </div>
      </main>

      {!tutorialFinished && (
        <OpenmiTutorial
          sidebarOpen={sidebarOpen}
          onOpenSidebar={openSidebar}
          onFinished={finishTutorial}
        />
      )}

      <RepoPanel
        open={repoOpen}
        onClose={() => setRepoOpen(false)}
        project={project}
        onSelectProject={setProject}
      />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        displayName={displayName}
        onDisplayNameChange={handleSaveName}
        searchMode={searchMode}
        onSearchModeChange={handleSearchModeChange}
        searchAvailable={searchAvailable}
        responseLength={responseLength}
        onResponseLengthChange={handleResponseLengthChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={handleReasoningEffortChange}
        appearance={appearance}
        onAppearanceChange={handleAppearanceChange}
      />

      {/* Branding splash — a fresh visit to the home page only, once per
          session. It sits above the app while this page finishes loading. */}
      <SplashScreen />

      {/* Install prompt — mobile only, and only once Openmi has been used. */}
      <InstallPrompt />
    </div>
  );
}

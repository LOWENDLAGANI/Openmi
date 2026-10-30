"use client";

// ── Settings → API keys ──────────────────────────────────────────────────────
// The account can bring its own model keys instead of relying on whatever the
// deployment has. Three things make that safe to offer, and all three are in the
// server route rather than here: the key is checked with the vendor before it is
// stored, it is sealed before it reaches a row, and the browser is never given
// it back — this screen only ever sees a four-character hint.
//
// The component therefore has no way to read a key, which is the point: a page
// that cannot display one cannot leak one through a screenshot, a log or a
// stale React state.

import { useCallback, useEffect, useState } from "react";
import { authHeader } from "@/lib/supabase";
import Spinner from "./Spinner";
import {
  keyProblem,
  keySourceLabel,
  USER_KEY_HELP,
  USER_KEY_LABELS,
  USER_KEY_PROVIDERS,
  USER_KEY_SOURCES,
  type KeySource,
  type StoredKeySummary,
  type UserKeyProvider,
} from "@/lib/providerKeyState";

interface KeysPayload {
  keys: StoredKeySummary[];
  storeReady: boolean;
  deployment: Record<UserKeyProvider, boolean>;
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
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (HTTP ${response.status})`);
  return payload as T;
}

export default function ApiKeysSection() {
  const [payload, setPayload] = useState<KeysPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<UserKeyProvider | null>(null);
  const [editing, setEditing] = useState<UserKeyProvider | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    try {
      setPayload(await api<KeysPayload>("/api/keys"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read your keys.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const startEditing = (provider: UserKeyProvider) => {
    setEditing(provider);
    setDraft("");
    setError(null);
    setNotice(null);
  };

  const save = async (provider: UserKeyProvider) => {
    const problem = keyProblem(provider, draft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(provider);
    setError(null);
    setNotice(null);
    try {
      await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ provider, key: draft.trim() }),
      });
      setEditing(null);
      setDraft("");
      setNotice(`${USER_KEY_LABELS[provider]} key saved. Your requests use it from now on.`);
      // The mode picker is already mounted and asked the server before this key
      // existed; it needs to ask again.
      window.dispatchEvent(new Event("openmi:keys-changed"));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The key could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (provider: UserKeyProvider) => {
    setBusy(provider);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/keys?provider=${provider}`, { method: "DELETE" });
      setEditing(null);
      setNotice(
        `${USER_KEY_LABELS[provider]} key removed. ${
          payload?.deployment[provider] ? "The deployment's key is used again." : "That provider can no longer answer for you."
        }`
      );
      window.dispatchEvent(new Event("openmi:keys-changed"));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The key could not be removed.");
    } finally {
      setBusy(null);
    }
  };

  const storedFor = (provider: UserKeyProvider): StoredKeySummary | null =>
    payload?.keys.find((key) => key.provider === provider) ?? null;

  const sourceFor = (provider: UserKeyProvider): KeySource => {
    if (storedFor(provider)) return "account";
    return payload?.deployment[provider] ? "deployment" : "missing";
  };

  return (
    <section>
      <h3 className="mb-1.5 text-[13px] font-semibold text-white">API keys</h3>


      <div className="space-y-2">
        {USER_KEY_PROVIDERS.map((provider) => {
          const stored = storedFor(provider);
          const source = sourceFor(provider);
          const open = editing === provider;
          const problem = open && draft.trim() ? keyProblem(provider, draft) : null;

          return (
            <div key={provider} className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-white/90">{USER_KEY_LABELS[provider]}</p>
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-white/35">{USER_KEY_HELP[provider]}</p>
                  <p className="mt-1 text-[10.5px] text-white/45">
                    {keySourceLabel(source, stored?.hint)}
                    {source === "missing" && (
                      <span className="text-white/30"> — this mode cannot answer until a key is added</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {stored && !open && (
                    <button
                      type="button"
                      onClick={() => void remove(provider)}
                      disabled={busy !== null}
                      className="rounded-lg px-2 py-1 text-[10.5px] text-white/40 transition-colors hover:bg-white/[0.06] hover:text-red-200/80 disabled:opacity-40"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {busy === provider && <Spinner size={11} />}
                        {busy === provider ? "Removing…" : "Remove"}
                      </span>
                    </button>
                  )}
                  {!open && (
                    <button
                      type="button"
                      onClick={() => startEditing(provider)}
                      disabled={busy !== null || payload?.storeReady === false}
                      className="rounded-lg border border-white/[0.12] px-2.5 py-1 text-[10.5px] font-medium text-white/70 transition hover:bg-white/[0.06] disabled:opacity-40"
                    >
                      {stored ? "Replace" : "Add key"}
                    </button>
                  )}
                </div>
              </div>

              {open && (
                <div className="mt-2 space-y-1.5">
                  <label className="block">
                    <span className="mb-1 block text-[10.5px] text-white/35">
                      Paste the {USER_KEY_LABELS[provider]} key · from {USER_KEY_SOURCES[provider]}
                    </span>
                    <input
                      type="password"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste the key"
                      className="w-full rounded-lg border border-white/[0.09] bg-black/25 px-2.5 py-2 font-mono text-[11.5px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                    />
                  </label>
                  {problem && <p className="text-[10.5px] leading-relaxed text-amber-200/70">{problem}</p>}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void save(provider)}
                      disabled={busy !== null || !draft.trim() || Boolean(problem)}
                      className="rounded-lg border border-[#a9d8bb]/25 bg-[#a9d8bb]/[0.08] px-2.5 py-1 text-[10.5px] font-medium text-[#a9d8bb] transition hover:bg-[#a9d8bb]/[0.14] disabled:opacity-40"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {busy === provider && <Spinner size={11} />}
                        {busy === provider ? "Checking…" : "Save key"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(null);
                        setDraft("");
                      }}
                      disabled={busy !== null}
                      className="rounded-lg px-2 py-1 text-[10.5px] text-white/40 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
                    >
                      Cancel
                    </button>
                    <span className="ml-auto text-[10px] text-white/25">Checked with the provider before saving</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {payload?.storeReady === false && (
        <p className="mt-2 text-[10.5px] leading-relaxed text-amber-100/60">
          This deployment cannot store a key: it needs <span className="font-mono">GITHUB_TOKEN_KEY</span> (32
          bytes of hex) set, because the same secret seals every stored credential. Until then, Openmi uses the
          deployment&apos;s own keys.
        </p>
      )}
      {error && <p className="mt-2 text-[11px] leading-relaxed text-red-200/80">{error}</p>}
      {notice && <p className="mt-2 text-[11px] leading-relaxed text-[#a9d8bb]/75">{notice}</p>}
    </section>
  );
}

"use client";

// ── "Why can't I sign in?" ──────────────────────────────────────────────────
//
// A collapsed row in Settings, not a permanent part of the interface. It exists
// because the error the SDK shows (`provider_disabled`) names no cause and no
// fix, and the four provider switches live in one place in the Supabase
// dashboard. Opening this and pressing one button replaces that guessing with
// the backend's own answer.
//
// Nothing here decides access. It reports which project this build talks to and
// which of the four doors that project has opened.

import { useCallback, useState } from "react";
import { diagnoseSignIn, type SignInDiagnosis } from "@/lib/authDiagnostics";

export default function AuthDiagnostics() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignInDiagnosis | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      setResult(await diagnoseSignIn());
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The check could not run.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <details className="mt-3 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <summary className="cursor-pointer list-none text-[11.5px] text-white/45 transition-colors hover:text-white/70">
        Why can&apos;t I sign in?
      </summary>

      <div className="mt-2 space-y-2">
        <p className="text-[10.5px] leading-relaxed text-white/35">
          Asks the project which of Google, GitHub, Microsoft and email sign-in it has switched on.
          Nothing is created and no account is needed.
        </p>

        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="rounded-lg border border-white/[0.12] px-2.5 py-1.5 text-[11px] font-medium text-white/75 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
        >
          {busy ? "Checking…" : "Run the check"}
        </button>

        {failure && <p className="text-[10.5px] leading-relaxed text-red-200/80">{failure}</p>}

        {result && (
          <div className="space-y-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-black/25 px-2.5 py-2 text-[10px]">
              <dt className="text-white/30">project</dt>
              <dd className="truncate font-mono text-white/70">{result.projectId ?? "— not set —"}</dd>
              <dt className="text-white/30">auth domain</dt>
              <dd className="truncate font-mono text-white/70">{result.authDomain ?? "— not set —"}</dd>
              <dt className="text-white/30">API key</dt>
              <dd className="truncate font-mono text-white/70">{result.keyHint ?? "— not set —"}</dd>
              <dt className="text-white/30">origin</dt>
              <dd className="truncate font-mono text-white/70">{result.origin || "—"}</dd>
              <dt className="text-white/30">answer</dt>
              <dd
                className={`truncate font-mono ${result.ok ? "text-[#a9d8bb]" : "text-amber-200/90"}`}
              >
                {result.ok ? "OK" : (result.backendMessage ?? "no response")}
              </dd>
              <dt className="text-white/30">methods</dt>
              <dd className="truncate font-mono text-white/70">
                {[
                  result.methods.google ? "google" : null,
                  result.methods.github ? "github" : null,
                  result.methods.microsoft ? "azure" : null,
                  result.methods.email ? "email" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "none"}
              </dd>
            </dl>

            <div
              className={`rounded-lg border px-2.5 py-2 ${
                result.ok
                  ? "border-[#a9d8bb]/20 bg-[#a9d8bb]/[0.05]"
                  : "border-amber-300/20 bg-amber-400/[0.05]"
              }`}
            >
              <p
                className={`text-[11px] leading-relaxed ${
                  result.ok ? "text-[#c9e6d4]/90" : "text-amber-100/85"
                }`}
              >
                {result.verdict}
              </p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-white/45">{result.nextStep}</p>
            </div>

            <p className="text-[9.5px] leading-relaxed text-white/25">
              These values are embedded when the site is built. If the project URL does not match the
              Supabase project you have been changing, that is the whole answer: the deployed build
              is talking to a different project.
            </p>
          </div>
        )}
      </div>
    </details>
  );
}

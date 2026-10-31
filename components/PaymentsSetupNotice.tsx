"use client";

// ── The notice before a buyer pays ───────────────────────────────────────────
//
// Shown on the top-up page and in the admin console, and rendered only when the
// payments migration is genuinely absent. Everywhere else it draws nothing.
//
// The check is a one-row read of `payment_receipts`, which is the cheapest
// question that can be asked of a table: an empty answer and a refused answer
// both mean it exists, and only "no such table" means the migration is pending.
// It runs on mount, so an owner who applies the migration and reloads sees the
// notice disappear without touching anything; the button is there for the case
// where the page is already open.
//
// The sentence names the migration file and the command, because "the database
// refused" is not something anyone can act on. It is a setup notice, not a
// visitor-facing error: a buyer should understand that this is the deployment's
// problem, not their payment's.

import { useCallback, useEffect, useState } from "react";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import {
  PAYMENTS_APPLY_COMMAND,
  PAYMENTS_GAP_SUMMARY,
  PAYMENTS_MIGRATION,
  paymentsSchemaGap,
} from "@/lib/paymentsSetup";

export default function PaymentsSetupNotice({ className = "" }: { className?: string }) {
  const [pending, setPending] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    // No project configured is not a pending migration: the pages already say
    // that nothing can be stored, and a second banner would name the wrong fix.
    if (!supabaseConfigured) return;
    const client = getSupabase();
    if (!client) return;

    setBusy(true);
    try {
      const { error } = await client.from("payment_receipts").select("id").limit(1);
      setPending(paymentsSchemaGap(error));
      setChecked(true);
    } catch {
      // A dropped request proves nothing. Leaving the answer as it was is
      // better than telling an owner to run a migration that is already applied.
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (!checked || !pending) return null;

  return (
    <div
      role="status"
      className={`rounded-[14px] border border-amber-300/25 bg-amber-400/[0.07] px-3.5 py-3 ${className}`}
    >
      <p className="text-[12px] font-semibold text-amber-100">Payments are not set up on this deployment</p>
      <p className="mt-1 text-[11px] leading-relaxed text-amber-100/70">{PAYMENTS_GAP_SUMMARY}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-amber-100/50">
        Apply{" "}
        <code className="rounded bg-black/35 px-1 py-0.5 font-mono text-[10.5px] text-amber-100/90">
          {PAYMENTS_MIGRATION}
        </code>{" "}
        with{" "}
        <code className="rounded bg-black/35 px-1 py-0.5 font-mono text-[10.5px] text-amber-100/90">
          {PAYMENTS_APPLY_COMMAND}
        </code>
        , then check again.
      </p>
      <button
        type="button"
        onClick={() => void check()}
        disabled={busy}
        className="mt-2 rounded-lg border border-amber-200/25 px-2.5 py-1 text-[11px] font-medium text-amber-100/85 transition-colors hover:bg-amber-200/10 disabled:opacity-50"
      >
        {busy ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

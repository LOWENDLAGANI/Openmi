import { useState } from 'react';
import type { ConfigCheck, ConfigGroup } from '../../shared/types';

export interface SetupChecklistProps {
  checks: ConfigCheck[];
  /** Message from a failed health request, shown at the top. */
  error?: string | null;
  retrying?: boolean;
  onRetry: () => void;
  /** Lets the user continue into the app even with variables missing. */
  onSkip?: () => void;
}

const GROUP_TITLES: Record<ConfigGroup, string> = {
  required: 'Required',
  recommended: 'Recommended',
  optional: 'Optional',
};

const GROUP_HINTS: Record<ConfigGroup, string> = {
  required: 'The app cannot start without these.',
  recommended: 'Needed for the full experience: a model provider and GitHub App access.',
  optional: 'Tuning knobs — every one has a working default.',
};

function StatusDot({ present }: { present: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
        present ? 'bg-emerald-400' : 'bg-amber-400'
      }`}
    />
  );
}

function CheckRow({ check }: { check: ConfigCheck }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-slate-800 first:border-t-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2 py-2.5 text-left"
      >
        <StatusDot present={check.present} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <code className="font-mono text-xs text-slate-100">{check.name}</code>
            {check.present ? (
              <span className="text-[10px] uppercase tracking-wide text-emerald-400">set</span>
            ) : check.defaultValue ? (
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                default: {check.defaultValue}
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wide text-amber-400">missing</span>
            )}
            {check.secret && (
              <span className="text-[10px] uppercase tracking-wide text-slate-600">secret</span>
            )}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">
            {check.purpose}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-[10px] text-slate-600">{open ? 'hide' : 'how'}</span>
      </button>
      {open && (
        <div className="mb-3 ml-4 rounded-lg bg-slate-900/70 p-3 text-xs text-slate-400">
          <p className="leading-relaxed">{check.howToSet}</p>
          {check.example && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-950/60 p-2 font-mono text-[11px] text-slate-300">
              {check.example}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

export default function SetupChecklist({
  checks,
  error,
  retrying,
  onRetry,
  onSkip,
}: SetupChecklistProps) {
  const required = checks.filter((c) => c.required);
  const missingRequired = required.filter((c) => !c.present);
  const done = required.length - missingRequired.length;
  const total = checks.length;
  const setCount = checks.filter((c) => c.present).length;

  return (
    <div className="min-h-full px-4 py-6 safe-top safe-bottom">
      <div className="mx-auto max-w-lg">
        <h1 className="text-xl font-bold text-white">Setup checklist</h1>
        <p className="mt-1 text-sm text-slate-400">
          {missingRequired.length === 0
            ? 'Every required environment variable is set. Here is the full list.'
            : `${missingRequired.length} required variable${
                missingRequired.length === 1 ? '' : 's'
              } still need${missingRequired.length === 1 ? 's' : ''} to be set.`}
        </p>

        <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>
              Required: {done}/{required.length} set
            </span>
            <span>
              All: {setCount}/{total} set
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${total ? (setCount / total) * 100 : 0}%` }}
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-4">
          {(['required', 'recommended', 'optional'] as ConfigGroup[]).map((group) => {
            const items = checks.filter((c) => c.group === group);
            if (items.length === 0) return null;
            return (
              <section
                key={group}
                className="rounded-xl border border-slate-700 bg-slate-800/40 px-3 py-2"
              >
                <header className="py-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-200">
                    {GROUP_TITLES[group]}
                  </h2>
                  <p className="mt-0.5 text-[11px] text-slate-500">{GROUP_HINTS[group]}</p>
                </header>
                <ul>
                  {items.map((check) => (
                    <CheckRow key={check.name} check={check} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="mt-6 flex flex-col gap-2">
          <button
            onClick={onRetry}
            disabled={retrying}
            className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {retrying ? 'Checking…' : 'Re-check'}
          </button>
          {onSkip && (
            <button
              onClick={onSkip}
              className="w-full rounded-xl border border-slate-700 py-3 text-sm text-slate-400 hover:text-slate-200"
            >
              Continue to the app
            </button>
          )}
          <p className="text-center text-[11px] leading-relaxed text-slate-500">
            Set variables in Vercel → Project → Settings → Environment Variables, then redeploy.
            Locally, put them in <code className="font-mono">.env.local</code> and restart the dev
            server.
          </p>
        </div>
      </div>
    </div>
  );
}

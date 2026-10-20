import type { RuntimeConfig } from '@/lib/config';
import { Banner, Card, SectionLabel } from '@/components/ui';

/**
 * This screen is what a fresh deployment shows before secrets are configured.
 * It lists missing keys (never values) so setup failures are self-diagnosing.
 */
export function Setup({ config }: { config: RuntimeConfig }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-5 pb-safe pt-safe">
      <header className="pt-8">
        <div className="inline-flex size-10 items-center justify-center rounded-2xl bg-emerald-400 text-lg font-black text-emerald-950">
          M
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">
          OpenMi needs configuration
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          The app is deployed and reachable — it just doesn't have credentials yet. Add the values
          below and reload.
        </p>
      </header>

      <Banner tone="warning">
        Missing: <span className="font-mono text-[12px]">{config.missing.join(', ') || 'none'}</span>
      </Banner>

      <Card className="space-y-3 p-4">
        <SectionLabel>1 · Database</SectionLabel>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          Apply the SQL migrations in <code className="text-zinc-200">supabase/migrations</code>,
          then set <code className="text-zinc-200">SUPABASE_URL</code>,{' '}
          <code className="text-zinc-200">SUPABASE_ANON_KEY</code> and the service role key.
        </p>
        <SectionLabel>2 · Worker secrets</SectionLabel>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          <code className="text-zinc-200">GITHUB_TOKEN_ENC_KEY</code> (32 random bytes, base64) and{' '}
          <code className="text-zinc-200">OPENROUTER_API_KEY</code> via{' '}
          <code className="text-zinc-200">wrangler secret put</code>.
        </p>
        <SectionLabel>3 · GitHub OAuth</SectionLabel>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          Enable the GitHub provider in Supabase Auth with the <code>repo</code> scope, then sign in.
        </p>
      </Card>

      <p className="pb-4 text-center text-[11px] text-zinc-600">
        Full walkthrough: <span className="font-mono">README.md</span>
      </p>
    </main>
  );
}

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
        <SectionLabel>1 · Firebase project</SectionLabel>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          Create a Firebase project, enable Firestore and both Google and GitHub sign-in, then
          deploy the rules and indexes in <code className="text-zinc-200">firebase/</code>. Set{' '}
          <code className="text-zinc-200">FIREBASE_PROJECT_ID</code>,{' '}
          <code className="text-zinc-200">FIREBASE_API_KEY</code>, and a service account (
          <code className="text-zinc-200">FIREBASE_CLIENT_EMAIL</code> +{' '}
          <code className="text-zinc-200">FIREBASE_PRIVATE_KEY</code>).
        </p>
        <SectionLabel>2 · Server secrets</SectionLabel>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          <code className="text-zinc-200">GITHUB_TOKEN_ENC_KEY</code> (32 random bytes, base64) and{' '}
          <code className="text-zinc-200">OPENROUTER_API_KEY</code> as Vercel environment variables.
        </p>
        <SectionLabel>3 · Google + GitHub OAuth</SectionLabel>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          Enable the <strong className="text-zinc-200">Google</strong> provider (used to sign in)
          and the <strong className="text-zinc-200">GitHub</strong> provider with the{' '}
          <code>repo</code> scope (used only to link GitHub to the signed-in account), then sign in
          with Google.
        </p>
      </Card>

      <p className="pb-4 text-center text-[11px] text-zinc-600">
        Full walkthrough: <span className="font-mono">README.md</span>
      </p>
    </main>
  );
}

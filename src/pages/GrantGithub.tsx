import { useState } from 'react';
import { useApp } from '@/lib/app-context';
import { signInWithGithub } from '@/lib/supabase';
import { Banner, Button, Card } from '@/components/ui';
import { GithubMark, Lock } from '@/components/icons';

/**
 * Shown when the session exists but no GitHub token is stored — e.g. the user
 * signed in before granting repo scope, or the token was revoked on GitHub.
 */
export function GrantGithub() {
  const { supabase, signOut, error } = useApp();
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function grant() {
    setLoading(true);
    setLocalError(null);
    try {
      await signInWithGithub(supabase);
    } catch (signInError) {
      setLocalError(signInError instanceof Error ? signInError.message : 'Sign-in failed');
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5 pb-safe pt-safe">
      <div>
        <div className="flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-emerald-300">
          <Lock className="size-5" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">
          Grant repository access
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-zinc-400">
          OpenMi needs a GitHub token with <code className="text-zinc-200">repo</code> scope so the
          background agent can read your files and push commits while your phone is asleep.
        </p>
      </div>

      <Card className="space-y-2 p-4">
        <p className="text-[12px] font-semibold text-zinc-200">What the token is used for</p>
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-zinc-500">
          <li>· Reading the file tree and file contents of repos you select</li>
          <li>· Creating one atomic commit per prompt</li>
          <li>· Never force-pushing, deleting, or changing repo settings</li>
        </ul>
      </Card>

      {localError ?? error ? <Banner>{localError ?? error}</Banner> : null}

      <div className="space-y-3">
        <Button fullWidth loading={loading} onClick={() => void grant()} className="min-h-14">
          <GithubMark className="size-5" />
          Authorize GitHub
        </Button>
        <Button variant="ghost" fullWidth onClick={() => void signOut()}>
          Use a different account
        </Button>
      </div>
    </main>
  );
}

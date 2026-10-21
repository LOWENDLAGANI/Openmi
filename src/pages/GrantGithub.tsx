import { useState } from 'react';
import { useApp } from '@/lib/app-context';
import { linkGithub } from '@/lib/firebase';
import { Banner, Button, Card } from '@/components/ui';
import { GithubMark, Lock } from '@/components/icons';

/**
 * Shown after sign-in when the session exists but GitHub is not linked yet —
 * Google creates the account, GitHub is connected here so the agent can push.
 *
 * Preferred path is the GitHub App: per-repository, revocable, no re-auth. The
 * OAuth path (a redirect that LINKS GitHub to the signed-in account) stays
 * available for deployments without an App configured and for users who only
 * need to browse repositories.
 */
export function GrantGithub() {
  const { auth, config, api, signOut, error } = useApp();
  const [busy, setBusy] = useState<'app' | 'oauth' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const appEnabled = config.githubApp.enabled;

  async function installApp() {
    setBusy('app');
    setLocalError(null);
    try {
      const url = await api.startGithubAppInstall();
      window.location.assign(url);
    } catch (installError) {
      setLocalError(
        installError instanceof Error ? installError.message : 'Could not start the install flow',
      );
      setBusy(null);
    }
  }

  async function authorizeOauth() {
    setBusy('oauth');
    setLocalError(null);
    try {
      await linkGithub(auth);
    } catch (signInError) {
      setLocalError(
        signInError instanceof Error ? signInError.message : 'Could not connect GitHub',
      );
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5 pt-safe pb-safe">
      <div>
        <div className="flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-emerald-300">
          <Lock className="size-5" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">Connect GitHub</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-zinc-400">
          Your account is ready — one last step. The background agent needs GitHub write access to
          commit on your behalf. Install the OpenMi app on only the repositories you want it to
          touch — you can revoke access at any time.
        </p>
      </div>

      <Card className="space-y-2 p-4">
        <p className="text-[12px] font-semibold text-zinc-200">What the agent can do</p>
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-zinc-500">
          <li>· Read the file tree and contents of repositories you select</li>
          <li>· Create one atomic commit per prompt</li>
          <li>· Never force-push, delete files, or change repository settings</li>
        </ul>
      </Card>

      {localError ?? error ? <Banner>{localError ?? error}</Banner> : null}

      <div className="space-y-3">
        {appEnabled ? (
          <>
            <Button
              fullWidth
              loading={busy === 'app'}
              disabled={busy !== null}
              onClick={() => void installApp()}
              className="min-h-14"
            >
              <GithubMark className="size-5" />
              Install the OpenMi GitHub App
            </Button>
            <button
              type="button"
              onClick={() => void authorizeOauth()}
              disabled={busy !== null}
              className="w-full py-2 text-[12px] font-medium text-zinc-400 underline-offset-4 active:underline disabled:opacity-60"
            >
              {busy === 'oauth' ? 'Redirecting…' : 'Connect GitHub with OAuth instead'}
            </button>
          </>
        ) : (
          <Button
            fullWidth
            loading={busy === 'oauth'}
            onClick={() => void authorizeOauth()}
            className="min-h-14"
          >
            <GithubMark className="size-5" />
            Authorize GitHub
          </Button>
        )}

        <Button variant="ghost" fullWidth onClick={() => void signOut()}>
          Use a different account
        </Button>
      </div>
    </main>
  );
}

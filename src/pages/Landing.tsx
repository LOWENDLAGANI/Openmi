import { useState } from 'react';
import { signInWithGithub } from '@/lib/firebase';
import { useApp } from '@/lib/app-context';
import { Banner, Button } from '@/components/ui';
import { Bolt, GithubMark, GitCommit, Lock } from '@/components/icons';

const GUARANTEES = [
  {
    icon: Bolt,
    title: 'Runs after your tab closes',
    body: 'Durable Cloudflare Workflows keep generating while your phone is locked or you lose signal.',
  },
  {
    icon: Lock,
    title: 'No deleted files, ever',
    body: 'Changes are committed atomically on top of the current tree. No force pushes, no destructive patches.',
  },
  {
    icon: GitCommit,
    title: 'One clean commit per prompt',
    body: 'Your repo history stays readable: one prompt, one reviewable commit.',
  },
];

export function Landing() {
  const { auth } = useApp();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    try {
      await signInWithGithub(auth);
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Sign-in failed');
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-safe pt-safe">
      <div className="flex flex-1 flex-col justify-center gap-8 py-10">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/8 px-3 py-1 text-[11px] font-semibold tracking-wide text-emerald-300 uppercase">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
            Background agents
          </div>
          <h1 className="mt-5 text-[34px] leading-[1.08] font-semibold tracking-tight text-white">
            Ship code from
            <br />
            your phone.
          </h1>
          <p className="mt-3 max-w-[19rem] text-[15px] leading-relaxed text-zinc-400">
            Type what you want. OpenMi edits your GitHub repo, commits it, and moves on — no laptop,
            no terminal, no open tab.
          </p>
        </div>

        <div className="space-y-3">
          {GUARANTEES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-emerald-300">
                <Icon className="size-4" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-zinc-100">{title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">{body}</p>
              </div>
            </div>
          ))}
        </div>

        {error ? <Banner>{error}</Banner> : null}
      </div>

      <div className="space-y-3 pb-2">
        <Button fullWidth loading={loading} onClick={handleSignIn} className="min-h-14 text-base">
          <GithubMark className="size-5" />
          Continue with GitHub
        </Button>
        <p className="px-2 text-center text-[11px] leading-relaxed text-zinc-600">
          OpenMi requests repository access so the agent can commit on your behalf. Access can be
          revoked on GitHub at any time.
        </p>
      </div>
    </main>
  );
}

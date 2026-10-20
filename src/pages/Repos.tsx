import { useEffect, useMemo, useState } from 'react';
import type { GithubRepoView } from '@shared/types';
import { useApp } from '@/lib/app-context';
import { navigate } from '@/lib/router';
import { relativeTime } from '@/lib/format';
import { ChevronLeft, Lock, Search } from '@/components/icons';
import { Banner, Button, Card, Spinner, cx } from '@/components/ui';

export function Repos({ firstRun, onClose }: { firstRun: boolean; onClose?: () => void }) {
  const { api, projects, reload, setActiveProjectId } = useApp();
  const [repos, setRepos] = useState<GithubRepoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .repos()
      .then((next) => {
        if (!cancelled) setRepos(next);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load repositories');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const connected = useMemo(
    () => new Set(projects.map((project) => project.repoFullName.toLowerCase())),
    [projects],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return repos
      .filter((repo) => (needle ? repo.fullName.toLowerCase().includes(needle) : true))
      .slice(0, 60);
  }, [repos, query]);

  async function connect(repo: GithubRepoView) {
    setConnecting(repo.fullName);
    setError(null);
    try {
      const project = await api.createProject({ repoFullName: repo.fullName });
      await reload();
      setActiveProjectId(project.id);
      navigate('/');
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Could not connect repo');
    } finally {
      setConnecting(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-safe">
      <header className="pt-safe sticky top-0 z-10 -mx-5 border-b border-white/6 bg-[#08090c]/85 px-5 pt-3 pb-3 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => (onClose ? onClose() : navigate('/'))}
            className="-ml-2 flex size-9 items-center justify-center rounded-full text-zinc-400 active:bg-white/8"
            aria-label="Back"
          >
            <ChevronLeft className="size-5" />
          </button>
          <div>
            <p className="text-[15px] font-semibold text-white">
              {firstRun ? 'Connect a repository' : 'Add a repository'}
            </p>
            <p className="text-[11px] text-zinc-500">Repos you can push to</p>
          </div>
        </div>
        <div className="relative mt-3">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search repositories"
            className="h-11 w-full rounded-2xl border border-white/8 bg-white/5 pr-3 pl-9 text-[14px] text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-400/40 focus:outline-none"
          />
        </div>
      </header>

      <div className="flex-1 space-y-2 py-4">
        {firstRun ? (
          <p className="px-1 pb-2 text-[12px] leading-relaxed text-zinc-500">
            Pick the repository OpenMi should edit. You can add more later — the agent only ever
            writes to repos you choose.
          </p>
        ) : null}

        {error ? <Banner>{error}</Banner> : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
            <Spinner />
            <span className="text-[13px]">Loading repositories…</span>
          </div>
        ) : null}

        {!loading && filtered.length === 0 ? (
          <Card className="px-4 py-10 text-center">
            <p className="text-[14px] font-medium text-zinc-200">No repositories found</p>
            <p className="mx-auto mt-1 max-w-[15rem] text-[12px] leading-relaxed text-zinc-500">
              Create one on GitHub first, or re-authenticate to grant repository access.
            </p>
          </Card>
        ) : null}

        {filtered.map((repo) => {
          const already = connected.has(repo.fullName.toLowerCase());
          const busy = connecting === repo.fullName;

          return (
            <Card key={repo.fullName} className="overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[13.5px] font-semibold text-zinc-100">
                      {repo.fullName}
                    </p>
                    {repo.private ? <Lock className="size-3 shrink-0 text-zinc-500" /> : null}
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    {repo.defaultBranch}
                    {repo.updatedAt ? ` · updated ${relativeTime(repo.updatedAt)}` : ''}
                    {!repo.canPush ? ' · no write access' : ''}
                  </p>
                </div>
                <Button
                  variant={already ? 'secondary' : 'primary'}
                  loading={busy}
                  disabled={!repo.canPush || (already && !busy)}
                  onClick={() => void connect(repo)}
                  className={cx('min-h-9 shrink-0 rounded-xl px-3.5 text-[12px]')}
                >
                  {already ? 'Connected' : 'Use'}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </main>
  );
}

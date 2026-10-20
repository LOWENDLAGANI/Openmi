import { useCallback, useEffect, useState } from 'react';
import type { TaskSummary } from '@shared/types';
import { useApp } from '@/lib/app-context';
import { navigate } from '@/lib/router';
import { PromptComposer } from '@/components/PromptComposer';
import { QuotaMeter } from '@/components/QuotaMeter';
import { TaskCard } from '@/components/TaskCard';
import { Plus } from '@/components/icons';
import { Banner, Button, Card, SectionLabel, Spinner, cx } from '@/components/ui';

export function Home() {
  const { api, me, projects, activeProject, setActiveProjectId, reload, signOut } = useApp();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);

  const projectId = activeProject?.id ?? null;

  useEffect(() => {
    if (!projectId) {
      setTasks([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .projectTasks(projectId)
      .then((next) => {
        if (!cancelled) {
          setTasks(next);
          setError(null);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load tasks');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, projectId, pollTick]);

  const hasActive = tasks.some((task) => task.status === 'queued' || task.status === 'running');

  // Poll only while something is actually in flight: no idle battery drain.
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setPollTick((tick) => tick + 1), 3500);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  const submitPrompt = useCallback(
    async (prompt: string) => {
      if (!projectId) throw new Error('Pick a repository first');
      const result = await api.createTask({ projectId, prompt });
      setTasks((current) => [result.task, ...current]);
      await reload();
      navigate(`/tasks/${result.task.id}`);
    },
    [api, projectId, reload],
  );

  const quotaExhausted = (me?.quota.remaining ?? 0) <= 0;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-safe">
      <header className="pt-safe sticky top-0 z-10 -mx-5 mb-4 border-b border-white/6 bg-[#08090c]/85 px-5 pt-3 pb-3 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-xl bg-emerald-400 text-sm font-black text-emerald-950">
              M
            </div>
            <div>
              <p className="text-[13px] leading-tight font-semibold text-white">OpenMi</p>
              <p className="text-[11px] leading-tight text-zinc-500">
                {activeProject ? activeProject.repoFullName : 'No repo connected'}
              </p>
            </div>
          </div>
          {me ? (
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex items-center gap-2 rounded-full border border-white/8 bg-white/5 py-1 pr-3 pl-1 active:bg-white/10"
            >
              {me.user.avatarUrl ? (
                <img
                  src={me.user.avatarUrl}
                  alt=""
                  className="size-6 rounded-full"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="size-6 rounded-full bg-white/10" />
              )}
              <span className="text-[11px] font-medium text-zinc-300">
                {me.user.login ?? 'Account'}
              </span>
            </button>
          ) : null}
        </div>
        {me ? (
          <div className="mt-2.5">
            <QuotaMeter quota={me.quota} />
          </div>
        ) : null}
      </header>

      <div className="flex-1 space-y-5">
        <div className="no-scrollbar -mx-5 flex items-center gap-2 overflow-x-auto px-5">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => setActiveProjectId(project.id)}
              className={cx(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-[12px] font-medium transition-colors',
                project.id === activeProject?.id
                  ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                  : 'border-white/8 bg-white/4 text-zinc-400 active:bg-white/8',
              )}
            >
              {project.name}
              {project.commitMode === 'pull_request' ? (
                <span className="rounded bg-white/10 px-1 text-[9px] tracking-wide text-zinc-300 uppercase">
                  PR
                </span>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate('/repos')}
            className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-white/12 px-3.5 py-2 text-[12px] font-medium text-zinc-400 active:bg-white/6"
          >
            <Plus className="size-3.5" />
            Add repo
          </button>
        </div>

        <PromptComposer
          onSubmit={submitPrompt}
          disabled={!activeProject || quotaExhausted}
          disabledReason={
            quotaExhausted
              ? 'Daily limit reached — resets at midnight UTC'
              : 'Connect a repository to start'
          }
          placeholder={
            activeProject
              ? `What should OpenMi change in ${activeProject.name}?`
              : 'Connect a repository to start'
          }
        />

        {quotaExhausted ? (
          <Banner tone="warning">
            You have used all {me?.quota.limit} tasks for today. The counter resets at{' '}
            {me ? new Date(me.quota.resetsAt).toLocaleTimeString([], { timeStyle: 'short' }) : 'midnight UTC'}
            .
          </Banner>
        ) : null}

        {error ? <Banner>{error}</Banner> : null}

        <section className="space-y-2.5">
          <div className="flex items-center justify-between px-1">
            <SectionLabel>Recent tasks</SectionLabel>
            {loading && tasks.length === 0 ? <Spinner className="size-3.5 text-zinc-500" /> : null}
          </div>

          {tasks.length === 0 && !loading ? (
            <Card className="px-4 py-8 text-center">
              <p className="text-[14px] font-medium text-zinc-200">Nothing here yet</p>
              <p className="mx-auto mt-1 max-w-[16rem] text-[12px] leading-relaxed text-zinc-500">
                Describe a change above. The agent will read the repo, edit the files, and commit
                while you close the app.
              </p>
            </Card>
          ) : (
            tasks.map((task) => <TaskCard key={task.id} task={task} />)
          )}
        </section>

        <footer className="flex items-center justify-between px-1 pt-2 pb-4">
          <p className="text-[10px] text-zinc-600">
            Commits are atomic and never force-pushed.
          </p>
          <Button variant="ghost" className="min-h-8 px-2 text-[11px]" onClick={() => void signOut()}>
            Sign out
          </Button>
        </footer>
      </div>
    </main>
  );
}

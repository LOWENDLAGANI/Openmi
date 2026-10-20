import { useEffect, useState } from 'react';
import type { TaskDetail as TaskDetailView } from '@shared/types';
import { useApp } from '@/lib/app-context';
import { navigate } from '@/lib/router';
import { relativeTime, shortSha } from '@/lib/format';
import { ChevronLeft, ExternalLink, GitCommit } from '@/components/icons';
import { Banner, Card, SectionLabel, Spinner, StatusPill, cx } from '@/components/ui';

const POLL_MS = 2500;

export function TaskDetail({ taskId }: { taskId: string }) {
  const { api } = useApp();
  const [task, setTask] = useState<TaskDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    api
      .task(taskId)
      .then((next) => {
        if (cancelled) return;
        setTask(next);
        setError(null);
        if (next.status === 'queued' || next.status === 'running') {
          timer = window.setTimeout(() => setTick((value) => value + 1), POLL_MS);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load this task');
        }
      });

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [api, taskId, tick]);

  const active = task?.status === 'queued' || task?.status === 'running';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-safe">
      <header className="pt-safe sticky top-0 z-10 -mx-5 border-b border-white/6 bg-[#08090c]/85 px-5 pt-3 pb-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="-ml-2 flex size-9 items-center justify-center rounded-full text-zinc-400 active:bg-white/8"
            aria-label="Back to tasks"
          >
            <ChevronLeft className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-white">Task</p>
            <p className="truncate font-mono text-[10px] text-zinc-500">{taskId}</p>
          </div>
          {task ? <StatusPill status={task.status} /> : null}
        </div>
      </header>

      <div className="flex-1 space-y-4 py-4">
        {error ? <Banner>{error}</Banner> : null}

        {!task && !error ? (
          <div className="flex items-center justify-center gap-2 py-20 text-zinc-500">
            <Spinner />
            <span className="text-[13px]">Loading task…</span>
          </div>
        ) : null}

        {task ? (
          <>
            <Card className="p-4">
              <SectionLabel>Prompt</SectionLabel>
              <p className="mt-2 text-[15px] leading-relaxed text-zinc-100">{task.prompt}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                <span>{relativeTime(task.createdAt)}</span>
                {task.branch ? (
                  <span className="font-mono text-[11px] text-zinc-400">{task.branch}</span>
                ) : null}
                {task.commitSha ? (
                  <span className="font-mono text-[11px] text-emerald-300/80">
                    {shortSha(task.commitSha)}
                  </span>
                ) : null}
              </div>
            </Card>

            {task.summary ? (
              <Card className="p-4">
                <SectionLabel>Result</SectionLabel>
                <p className="mt-2 text-[13.5px] leading-relaxed text-zinc-300">{task.summary}</p>
              </Card>
            ) : null}

            {task.errorMessage ? (
              <Banner>
                <span className="font-semibold">{task.errorCode ?? 'FAILED'}</span>
                <br />
                {task.errorMessage}
              </Banner>
            ) : null}

            {task.files.length > 0 ? (
              <Card className="p-4">
                <SectionLabel>Changed files</SectionLabel>
                <ul className="mt-2 space-y-1.5">
                  {task.files.map((file) => (
                    <li key={file.path} className="flex items-start gap-2">
                      <span
                        className={cx(
                          'mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide uppercase',
                          file.operation === 'create'
                            ? 'bg-emerald-400/15 text-emerald-300'
                            : 'bg-sky-400/15 text-sky-300',
                        )}
                      >
                        {file.operation === 'create' ? 'new' : 'edit'}
                      </span>
                      <span className="font-mono text-[11.5px] break-all text-zinc-300">
                        {file.path}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <SectionLabel>Agent timeline</SectionLabel>
                {active ? <Spinner className="size-3 text-emerald-400" /> : null}
              </div>

              {task.events.length === 0 ? (
                <p className="mt-2 text-[12px] text-zinc-500">Waiting for the agent to start…</p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {task.events.map((event, index) => (
                    <li key={event.seq} className="relative flex gap-3">
                      {index < task.events.length - 1 ? (
                        <span className="absolute top-3 left-[3px] h-full w-px bg-white/10" />
                      ) : null}
                      <span
                        className={cx(
                          'mt-1.5 size-[7px] shrink-0 rounded-full',
                          event.level === 'error'
                            ? 'bg-red-400'
                            : event.level === 'warn'
                              ? 'bg-amber-300'
                              : 'bg-emerald-400',
                        )}
                      />
                      <div className="min-w-0">
                        <p className="text-[12.5px] leading-relaxed text-zinc-300">
                          {event.message}
                        </p>
                        <p className="text-[10px] text-zinc-600">
                          {relativeTime(event.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            {active ? (
              <p className="px-2 text-center text-[11px] leading-relaxed text-zinc-500">
                You can close this tab — the agent keeps working in the background and commits on its
                own.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {task?.commitUrl ? (
        <div className="pb-safe sticky bottom-0 -mx-5 border-t border-white/6 bg-[#08090c]/90 px-5 pt-3 backdrop-blur-xl">
          <a
            href={task.commitUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-400 text-[15px] font-semibold text-emerald-950 active:bg-emerald-300"
          >
            <GitCommit className="size-4" />
            View on GitHub
            <ExternalLink className="size-4 opacity-70" />
          </a>
        </div>
      ) : null}
    </main>
  );
}

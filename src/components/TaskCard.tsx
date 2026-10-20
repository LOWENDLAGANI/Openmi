import type { TaskSummary } from '@shared/types';
import { relativeTime, truncate } from '@/lib/format';
import { navigate } from '@/lib/router';
import { GitCommit } from './icons';
import { Card, StatusPill } from './ui';

export function TaskCard({ task }: { task: TaskSummary }) {
  const active = task.status === 'queued' || task.status === 'running';

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => navigate(`/tasks/${task.id}`)}
        className="w-full px-4 py-3.5 text-left transition-colors active:bg-white/4"
      >
        <div className="flex items-center justify-between gap-3">
          <StatusPill status={task.status} />
          <span className="text-[11px] text-zinc-500">{relativeTime(task.createdAt)}</span>
        </div>
        <p className="mt-2.5 text-[15px] leading-snug font-medium text-zinc-100">
          {truncate(task.prompt, 140)}
        </p>
        {task.summary ? (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-zinc-400">
            {task.summary}
          </p>
        ) : null}
        {task.errorMessage && task.status === 'failed' ? (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-red-300/90">
            {task.errorMessage}
          </p>
        ) : null}
        {active ? (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/8">
            <div className="h-full w-1/3 animate-[pulse_1.6s_ease-in-out_infinite] rounded-full bg-emerald-400/70" />
          </div>
        ) : null}
      </button>

      {task.commitUrl ? (
        <a
          href={task.commitUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="flex items-center gap-2 border-t border-white/6 px-4 py-2.5 text-[12px] font-medium text-emerald-300 active:bg-emerald-400/5"
        >
          <GitCommit className="size-4" />
          {task.filesChanged} file{task.filesChanged === 1 ? '' : 's'} ·{' '}
          {task.commitSha?.slice(0, 7)}
        </a>
      ) : null}
    </Card>
  );
}

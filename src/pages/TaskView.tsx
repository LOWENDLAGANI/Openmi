import { useEffect, useState } from 'react';
import { apiGet, retryTask } from '../lib/api';
import type { Task, TaskEvent } from '../../shared/types';

export default function TaskView({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!task) return;
    setRetrying(true);
    setError(null);
    try {
      await retryTask(task.id);
      load();
    } catch (e: any) {
      setError(e?.message ?? 'retry failed');
    } finally {
      setRetrying(false);
    }
  };

  const load = async () => {
    try {
      const data = await apiGet<{ task: Task; events: TaskEvent[] }>(`/api/tasks/${taskId}`);
      setTask(data.task);
      setEvents(data.events);
    } catch (e: any) {
      setError(e?.message ?? 'failed to load');
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      if (!task || task.status === 'queued' || task.status === 'running') load();
    }, 3000);
    return () => clearInterval(iv);
  }, [taskId, task?.status]);

  const inFlight = task?.status === 'queued' || task?.status === 'running';

  return (
    <div className="min-h-full max-w-lg mx-auto px-4 py-6 safe-top safe-bottom">
      <button onClick={onBack} className="text-sm text-slate-400 hover:text-white mb-4">
        ← Back
      </button>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {!task && !error && <p className="text-slate-400 text-sm">Loading…</p>}

      {task && (
        <>
          <div className="mb-4">
            <span
              className={`inline-block text-xs font-medium px-2 py-1 rounded-full ${
                task.status === 'succeeded'
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : task.status === 'failed'
                    ? 'bg-red-500/20 text-red-400'
                    : task.status === 'conflict'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-brand-500/20 text-brand-400'
              }`}
            >
              {inFlight ? 'working…' : task.status}
            </span>
            <h1 className="text-base font-medium text-white mt-3 whitespace-pre-wrap">
              {task.prompt}
            </h1>
          </div>

          {task.commitUrl && (
            <a
              href={task.commitUrl}
              target="_blank"
              rel="noreferrer"
              className="block mb-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm rounded-xl p-3 hover:bg-emerald-500/20"
            >
              View commit on GitHub →
            </a>
          )}
          {task.pullRequestUrl && (
            <a
              href={task.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="block mb-3 bg-brand-500/10 border border-brand-500/30 text-brand-400 text-sm rounded-xl p-3 hover:bg-brand-500/20"
            >
              View pull request →
            </a>
          )}
          {(task.status === 'failed' || task.status === 'conflict') && (
            <>
              <div className="mb-3 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-xl p-3">
                <div className="font-medium">{task.errorCode ?? task.status}</div>
                <div className="text-xs mt-1 opacity-80">{task.errorMessage}</div>
              </div>
              <button
                onClick={retry}
                disabled={retrying}
                className="mb-3 w-full bg-brand-600 text-white font-medium py-2.5 rounded-xl hover:bg-brand-700 disabled:opacity-50 text-sm"
              >
                {retrying ? 'Retrying…' : '↻ Retry this task'}
              </button>
            </>
          )}

          <h2 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">
            Timeline
          </h2>
          <div className="space-y-2">
            {events.map((e) => (
              <div key={e.id} className="flex gap-3 text-sm">
                <div className="w-2 h-2 mt-1.5 rounded-full bg-brand-500 shrink-0" />
                <div>
                  <div className="text-slate-200">{e.message ?? e.type}</div>
                  <div className="text-xs text-slate-500">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))}
            {inFlight && (
              <div className="flex gap-3 text-sm">
                <div className="w-2 h-2 mt-1.5 rounded-full bg-brand-500 animate-pulse shrink-0" />
                <div className="text-slate-400">agent is working in the background…</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

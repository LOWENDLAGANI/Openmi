import { useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import type { Project, Task, QuotaInfo } from '../../shared/types';

export default function ProjectView({
  projectId,
  onBack,
  onOpenTask,
}: {
  projectId: string;
  onBack: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const me = await apiGet<{ quota: QuotaInfo }>('/api/me');
      setQuota(me.quota);
      const [projects, taskList] = await Promise.all([
        apiGet<{ projects: Project[] }>('/api/projects'),
        apiGet<{ tasks: Task[] }>(`/api/projects/${projectId}/tasks`),
      ]);
      setProject(projects.projects.find((p) => p.id === projectId) ?? null);
      setTasks(taskList.tasks);
    } catch (e: any) {
      setError(e?.message ?? 'failed to load');
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      if (tasks.some((t) => t.status === 'queued' || t.status === 'running')) load();
    }, 4000);
    return () => clearInterval(iv);
  }, [projectId, tasks]);

  const submit = async () => {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { task } = await apiPost<{ task: Task }>('/api/tasks', { projectId, prompt: prompt.trim() });
      setPrompt('');
      onOpenTask(task.id);
    } catch (e: any) {
      if (e instanceof ApiError) {
        setError(`${e.code}: ${e.message}`);
      } else {
        setError(e?.message ?? 'failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const statusColor = (s: Task['status']) => {
    switch (s) {
      case 'succeeded': return 'text-emerald-400';
      case 'failed': return 'text-red-400';
      case 'conflict': return 'text-amber-400';
      case 'running': return 'text-brand-400 animate-pulse';
      default: return 'text-slate-400';
    }
  };

  return (
    <div className="min-h-full max-w-lg mx-auto px-4 py-6 safe-top safe-bottom">
      <button onClick={onBack} className="text-sm text-slate-400 hover:text-white mb-4">
        ← Back
      </button>
      <h1 className="text-lg font-bold text-white mb-1 break-all">
        {project?.repoFullName ?? '…'}
      </h1>
      {quota && (
        <p className="text-xs text-slate-400 mb-4">
          {quota.remainingToday}/{quota.dailyTaskLimit} tasks left today
        </p>
      )}

      <div className="mb-6">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent build or fix? e.g. “add a dark mode toggle”"
          rows={4}
          className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 resize-none"
        />
        <button
          onClick={submit}
          disabled={submitting || !prompt.trim()}
          className="mt-2 w-full bg-brand-600 text-white font-medium py-3 rounded-xl hover:bg-brand-700 disabled:opacity-50 active:scale-[0.99] transition"
        >
          {submitting ? 'Dispatching…' : 'Run task'}
        </button>
        {error && <p className="mt-2 text-red-400 text-sm">{error}</p>}
      </div>

      <h2 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">
        Recent tasks
      </h2>
      {tasks.length === 0 ? (
        <p className="text-sm text-slate-500">No tasks yet. Run one above.</p>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => onOpenTask(t.id)}
              className="w-full text-left bg-slate-800/60 border border-slate-700 rounded-xl p-3 hover:border-brand-500 transition"
            >
              <div className="text-sm text-white truncate">{t.prompt}</div>
              <div className={`text-xs mt-1 ${statusColor(t.status)}`}>
                {t.status}
                {t.commitUrl && ' · committed'}
                {t.errorMessage && ` · ${t.errorCode}`}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

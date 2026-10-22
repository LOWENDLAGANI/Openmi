import { useEffect, useState } from 'react';
import { apiGet, apiPost, getProjectFiles } from '../lib/api';
import ErrorList, { toErrorState, type ErrorState } from '../components/ErrorList';
import type { Project, Task, QuotaInfo, RepoFile } from '../../shared/types';

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
  const [files, setFiles] = useState<RepoFile[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [filesError, setFilesError] = useState<ErrorState | null>(null);
  const [tab, setTab] = useState<'tasks' | 'files'>('tasks');
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);

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
      setError(toErrorState(e, 'failed to load'));
    }
  };

  const loadFiles = async () => {
    setFilesError(null);
    try {
      const data = await getProjectFiles(projectId);
      setFiles(data.files);
      setFilesTruncated(data.truncated);
    } catch (e: any) {
      setFilesError(toErrorState(e, 'failed to load files'));
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      if (tasks.some((t) => t.status === 'queued' || t.status === 'running')) load();
    }, 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tasks]);

  useEffect(() => {
    if (tab === 'files' && files.length === 0 && !filesError) loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const submit = async () => {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { task } = await apiPost<{ task: Task }>('/api/tasks', { projectId, prompt: prompt.trim() });
      setPrompt('');
      onOpenTask(task.id);
    } catch (e: any) {
      setError(toErrorState(e, 'failed'));
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

  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

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
          {quota.remainingToday}/{quota.dailyLimit} tasks left today
          {typeof quota.tokensUsedToday === 'number' &&
            ` · ${quota.tokensUsedToday.toLocaleString()} tokens used`}
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
        {error && <ErrorList state={error} className="mt-2" />}
      </div>

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setTab('tasks')}
          className={`flex-1 text-xs font-medium py-2 rounded-lg border transition ${
            tab === 'tasks'
              ? 'bg-brand-600 border-brand-500 text-white'
              : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-white'
          }`}
        >
          Recent tasks
        </button>
        <button
          onClick={() => setTab('files')}
          className={`flex-1 text-xs font-medium py-2 rounded-lg border transition ${
            tab === 'files'
              ? 'bg-brand-600 border-brand-500 text-white'
              : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-white'
          }`}
        >
          Files
        </button>
      </div>

      {tab === 'tasks' && (
        <>
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
        </>
      )}

      {tab === 'files' && (
        <div>
          {filesError && <ErrorList state={filesError} className="mb-3" />}
          {!filesError && files.length === 0 && (
            <p className="text-sm text-slate-500">Loading repository files…</p>
          )}
          {sortedFiles.length > 0 && (
            <div className="bg-slate-800/40 border border-slate-700 rounded-xl overflow-hidden">
              <div className="max-h-96 overflow-y-auto">
                {sortedFiles.map((f) => {
                  const depth = f.path.split('/').length - 1;
                  const isDir = f.type === 'tree';
                  return (
                    <div
                      key={f.path}
                      className="flex items-center gap-2 px-3 py-2 text-xs border-b border-slate-700/50 last:border-0"
                      style={{ paddingLeft: `${12 + depth * 14}px` }}
                    >
                      <span className={isDir ? 'text-amber-400' : 'text-slate-500'}>
                        {isDir ? '▸' : '·'}
                      </span>
                      <span className={isDir ? 'text-slate-300 font-medium' : 'text-slate-400'}>
                        {f.path.split('/').pop()}
                      </span>
                      {!isDir && typeof f.size === 'number' && (
                        <span className="ml-auto text-slate-600">
                          {f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {filesTruncated && (
            <p className="text-xs text-slate-500 mt-2">
              Large repository — showing first 500 files.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

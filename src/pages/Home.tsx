import { useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { linkGithub, getConfig, firebaseAuth } from '../lib/firebase';
import ErrorList, { toErrorState, type ErrorState } from '../components/ErrorList';
import type { Project, QuotaInfo, Profile, PublicConfig } from '../../shared/types';

export default function Home({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [repoInput, setRepoInput] = useState('');
  const [error, setError] = useState<ErrorState | null>(null);
  const [linking, setLinking] = useState(false);

  const load = async () => {
    try {
      const [me, c] = await Promise.all([apiGet<{ profile: Profile; quota: QuotaInfo }>('/api/me'), getConfig()]);
      setProfile(me.profile);
      setQuota(me.quota);
      setCfg(c);
      const p = await apiGet<{ projects: Project[] }>('/api/projects');
      setProjects(p.projects);
    } catch (e: any) {
      setError(toErrorState(e, 'failed to load'));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const connectRepo = async () => {
    if (!repoInput.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const { project } = await apiPost<{ project: Project }>('/api/projects', { repoFullName: repoInput.trim() });
      setRepoInput('');
      await load();
      onOpenProject(project.id);
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'GITHUB_NOT_CONNECTED') {
        setError(toErrorState(new Error('Link GitHub first, then connect the repo.')));
      } else {
        setError(toErrorState(e, 'failed to connect'));
      }
    } finally {
      setConnecting(false);
    }
  };

  const doLinkGithub = async () => {
    setLinking(true);
    setError(null);
    try {
      await linkGithub();
      await load();
    } catch (e: any) {
      setError(toErrorState(e, 'GitHub link failed (may already be linked)'));
    } finally {
      setLinking(false);
    }
  };

  const signOut = () => firebaseAuth().signOut();

  const ghConnected = profile?.githubLinked || profile?.githubAppInstalled;

  return (
    <div className="min-h-full max-w-lg mx-auto px-4 py-6 safe-top safe-bottom">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">OpenMi</h1>
          {quota && (
            <p className="text-xs text-slate-400">
              {quota.remainingToday}/{quota.dailyLimit} tasks left today
              {quota.runningNow > 0 && ` · ${quota.runningNow} running`}
            </p>
          )}
        </div>
        <button onClick={signOut} className="text-xs text-slate-400 hover:text-white">
          Sign out
        </button>
      </header>

      {!ghConnected && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 mb-4">
          <p className="text-sm text-slate-300 mb-3">
            Connect GitHub so the agent can commit to your repos.
          </p>
          <div className="flex flex-col gap-2">
            {cfg?.githubAppConfigured && cfg.githubAppInstallUrl && (
              <a
                href={cfg.githubAppInstallUrl}
                className="text-center bg-brand-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-brand-700"
              >
                Install GitHub App (recommended)
              </a>
            )}
            <button
              onClick={doLinkGithub}
              disabled={linking}
              className="text-center bg-slate-700 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-slate-600 disabled:opacity-50"
            >
              {linking ? 'Linking…' : 'Link GitHub account (OAuth fallback)'}
            </button>
          </div>
        </div>
      )}

      <div className="mb-6">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">
          Connect a repository
        </label>
        <div className="flex gap-2 mt-2">
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repo"
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
          />
          <button
            onClick={connectRepo}
            disabled={connecting || !repoInput.trim()}
            className="bg-brand-600 text-white text-sm font-medium px-4 rounded-lg hover:bg-brand-700 disabled:opacity-50"
          >
            {connecting ? '…' : 'Connect'}
          </button>
        </div>
      </div>

      {error && <ErrorList state={error} className="mb-4" />}

      <h2 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">
        Your projects
      </h2>
      {projects.length === 0 ? (
        <p className="text-sm text-slate-500">No projects yet. Connect a repo above.</p>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpenProject(p.id)}
              className="w-full text-left bg-slate-800/60 border border-slate-700 rounded-xl p-4 hover:border-brand-500 transition active:scale-[0.99]"
            >
              <div className="font-medium text-white text-sm">{p.repoFullName}</div>
              <div className="text-xs text-slate-400 mt-1">
                {p.defaultBranch} · {p.commitMode} commits
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

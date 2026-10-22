import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { initFirebase, firebaseAuth } from './lib/firebase';
import { getHealth } from './lib/api';
import SetupChecklist from './components/SetupChecklist';
import Login from './pages/Login';
import Home from './pages/Home';
import ProjectView from './pages/ProjectView';
import TaskView from './pages/TaskView';
import type { HealthResponse } from '../shared/types';

type Route =
  | { name: 'home' }
  | { name: 'project'; projectId: string }
  | { name: 'task'; taskId: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h.startsWith('project/')) return { name: 'project', projectId: h.slice('project/'.length) };
  if (h.startsWith('task/')) return { name: 'task', taskId: h.slice('task/'.length) };
  return { name: 'home' };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash());
  const unsubRef = useRef<(() => void) | null>(null);
  // Setup checklist state: which variables are set, whether the user chose to
  // continue anyway, and whether the checklist was opened explicitly.
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  const loadHealth = async () => {
    setChecking(true);
    try {
      const h = await getHealth();
      setHealth(h);
      setHealthError(null);
      // Nothing is missing any more: leave the checklist by itself.
      if (!h.checks.some((c) => c.required && !c.present)) setShowSetup(false);
    } catch (e: any) {
      setHealthError(
        `Could not read the server configuration (${e?.message ?? 'unknown error'}). The API may be unreachable.`,
      );
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    loadHealth();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setInitError(
          'Startup timed out — the API may be unreachable or still cold-starting. Refresh in a moment, or check the Vercel deployment URL and env vars.',
        );
        setReady(true);
      }
    }, 25000);
    initFirebase()
      .then(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        unsubRef.current = onAuthStateChanged(firebaseAuth(), (u) => {
          setUser(u);
          setReady(true);
        });
      })
      .catch((e: any) => {
        if (cancelled) return;
        clearTimeout(timeout);
        setInitError(e?.message ?? 'Failed to initialise');
        setReady(true);
      });
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      unsubRef.current?.();
      unsubRef.current = null;
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  // The startup banner explains what went wrong; this retries the same
  // initialisation (and the configuration check) without a full page reload.
  const retryInit = async () => {
    setRetrying(true);
    setInitError(null);
    loadHealth();
    try {
      await initFirebase();
      unsubRef.current?.();
      unsubRef.current = onAuthStateChanged(firebaseAuth(), (u) => {
        setUser(u);
        setReady(true);
      });
      setReady(true);
    } catch (e: any) {
      setInitError(e?.message ?? 'Failed to initialise');
      setReady(true);
    } finally {
      setRetrying(false);
    }
  };

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  // Missing required variables block the app; the checklist explains how to
  // set each one. The user can continue into the app anyway.
  const missingRequired = (health?.checks ?? []).filter((c) => c.required && !c.present);
  const showChecklist =
    health !== null && (showSetup || (missingRequired.length > 0 && !setupDismissed));

  if (showChecklist) {
    return (
      <SetupChecklist
        checks={health.checks}
        error={healthError}
        retrying={checking}
        onRetry={loadHealth}
        onSkip={() => {
          setShowSetup(false);
          setSetupDismissed(true);
        }}
      />
    );
  }

  if (!ready) {
    return (
      <div className="min-h-full flex items-center justify-center text-slate-400 text-sm">
        Loading…
      </div>
    );
  }

  if (!user) {
    const banner = initError ?? healthError;
    return (
      <>
        {banner && (
          <div className="fixed top-0 inset-x-0 z-50 bg-amber-500/15 border-b border-amber-500/40 text-amber-300 text-xs px-4 py-2 safe-top">
            <div className="max-w-lg mx-auto flex items-start gap-3">
              <div className="flex-1 break-words">{banner}</div>
              <div className="flex shrink-0 gap-3">
                {health && (
                  <button
                    onClick={() => setShowSetup(true)}
                    className="underline underline-offset-2"
                  >
                    Setup
                  </button>
                )}
                <button
                  onClick={retryInit}
                  disabled={retrying}
                  className="underline underline-offset-2 disabled:opacity-50"
                >
                  {retrying ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            </div>
          </div>
        )}
        <Login />
      </>
    );
  }

  if (route.name === 'task') {
    return <TaskView taskId={route.taskId} onBack={() => history.back()} />;
  }
  if (route.name === 'project') {
    return (
      <ProjectView
        projectId={route.projectId}
        onBack={() => go('/')}
        onOpenTask={(id) => go(`/task/${id}`)}
      />
    );
  }
  return <Home onOpenProject={(id) => go(`/project/${id}`)} />;
}

import { useEffect, useState } from 'react';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import { initFirebase } from './lib/firebase';
import Login from './pages/Login';
import Home from './pages/Home';
import ProjectView from './pages/ProjectView';
import TaskView from './pages/TaskView';

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
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setInitError('Startup timed out — the API may be unreachable or still cold-starting. Refresh in a moment, or check the Vercel deployment URL and env vars.');
        setReady(true);
      }
    }, 25000);
    initFirebase()
      .then(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        const unsub = onAuthStateChanged(getAuth(), (u) => {
          setUser(u);
          setReady(true);
        });
        return () => unsub();
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
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  if (!ready) {
    return (
      <div className="min-h-full flex items-center justify-center text-slate-400 text-sm">
        Loading…
      </div>
    );
  }

  if (!user) {
    return (
      <>
        {initError && (
          <div className="fixed top-0 inset-x-0 z-50 bg-amber-500/15 border-b border-amber-500/40 text-amber-300 text-xs px-4 py-2 safe-top">
            {initError}
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

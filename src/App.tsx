import { useApp } from '@/lib/app-context';
import { matchTaskDetail, usePathname } from '@/lib/router';
import { Banner, Button, Spinner } from '@/components/ui';
import { GrantGithub } from '@/pages/GrantGithub';
import { Home } from '@/pages/Home';
import { Landing } from '@/pages/Landing';
import { Repos } from '@/pages/Repos';
import { TaskDetail } from '@/pages/TaskDetail';

function Splash() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3">
      <div className="flex size-11 animate-pulse items-center justify-center rounded-2xl bg-emerald-400 text-lg font-black text-emerald-950">
        M
      </div>
      <p className="flex items-center gap-2 text-[12px] text-zinc-500">
        <Spinner className="size-3" /> Loading workspace
      </p>
    </main>
  );
}

export function App() {
  const { authReady, session, me, projects, booting, error, reload } = useApp();
  const pathname = usePathname();

  if (!authReady) return <Splash />;
  if (!session) return <Landing />;

  if (!me) {
    if (booting) return <Splash />;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-5">
        <Banner>{error ?? 'Could not load your workspace.'}</Banner>
        <Button onClick={() => void reload()}>Try again</Button>
      </main>
    );
  }

  if (!me.github) return <GrantGithub />;

  if (pathname === '/repos') return <Repos firstRun={false} />;
  if (projects.length === 0) return <Repos firstRun />;

  const taskId = matchTaskDetail(pathname);
  if (taskId) return <TaskDetail taskId={taskId} />;

  return <Home />;
}

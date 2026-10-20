import { useEffect, useState } from 'react';

/**
 * Tiny history router: the app has three screens, so a routing library would
 * cost more than it saves. Handles back/forward and deep links.
 */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return pathname;
}

export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function matchTaskDetail(pathname: string): string | null {
  const match = /^\/tasks\/([0-9a-f-]{36})$/.exec(pathname);
  return match?.[1] ?? null;
}

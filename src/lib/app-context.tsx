import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getRedirectResult, onAuthStateChanged, signOut as firebaseSignOut, type User } from 'firebase/auth';
import type { MeView, ProjectView } from '@shared/types';
import { createApiClient, type ApiClient } from './api';
import type { RuntimeConfig } from './config';
import { githubProviderTokenFrom, initFirebase, type Auth } from './firebase';

interface AppContextValue {
  config: RuntimeConfig;
  auth: Auth;
  api: ApiClient;
  user: User | null;
  authReady: boolean;
  me: MeView | null;
  projects: ProjectView[];
  booting: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  activeProject: ProjectView | null;
  setActiveProjectId: (id: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const ACTIVE_PROJECT_KEY = 'openmi.activeProjectId';

export function AppProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}) {
  const { auth } = useMemo(() => initFirebase(config.firebase), [config.firebase]);
  const userRef = useRef<User | null>(null);
  const linkedTokenRef = useRef<string | null>(null);
  const pendingProviderTokenRef = useRef<string | null>(null);

  const getToken = useCallback(
    async (forceRefresh = false): Promise<string> => {
      const current = userRef.current;
      if (!current) throw new Error('Not signed in');
      return current.getIdToken(forceRefresh);
    },
    [],
  );

  const api = useMemo(() => createApiClient(getToken), [getToken]);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [me, setMe] = useState<MeView | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(
    () => window.localStorage.getItem(ACTIVE_PROJECT_KEY),
  );

  const refresh = useCallback(
    async (currentUser: User | null) => {
      if (!currentUser) {
        setMe(null);
        setProjects([]);
        return;
      }
      setBooting(true);
      try {
        // A GitHub OAuth provider token is only handed to the client on the
        // sign-in redirect result, so persist it server-side the first time
        // we see it.
        const providerToken = pendingProviderTokenRef.current;
        if (providerToken && linkedTokenRef.current !== providerToken) {
          linkedTokenRef.current = providerToken;
          pendingProviderTokenRef.current = null;
          try {
            await api.linkGithub(providerToken);
          } catch (linkError) {
            setError(
              linkError instanceof Error
                ? linkError.message
                : 'Could not link GitHub. Try signing in again.',
            );
          }
        }
        const [nextMe, nextProjects] = await Promise.all([api.me(), api.projects()]);
        setMe(nextMe);
        setProjects(nextProjects);
      } catch (refreshError) {
        setError(
          refreshError instanceof Error ? refreshError.message : 'Could not load your account',
        );
      } finally {
        setBooting(false);
      }
    },
    [api],
  );

  useEffect(() => {
    let active = true;
    // Capture the GitHub provider token from a just-completed OAuth redirect.
    // This must run once on mount; the token is unavailable afterwards.
    getRedirectResult(auth)
      .then((result) => {
        if (!active || !result) return;
        const token = githubProviderTokenFrom(result);
        if (token) {
          pendingProviderTokenRef.current = token;
          // onAuthStateChanged usually fires — and calls refresh() — before
          // this async result lands, so refresh() already ran with an empty
          // pending token and never linked GitHub. Refresh again now that the
          // token is captured. The linkedTokenRef guard makes a double-link a
          // no-op if the first refresh already won the race.
          const current = userRef.current;
          if (current) void refresh(current);
        }
      })
      .catch(() => {
        // A failed/cancelled redirect leaves no token; sign-in state is still
        // reported by onAuthStateChanged below.
      });

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (!active) return;
      userRef.current = nextUser;
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) void refresh(nextUser);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [auth, refresh]);

  useEffect(() => {
    if (user) void refresh(user);
  }, [user?.uid, refresh]);

  const reload = useCallback(async () => {
    await refresh(user);
  }, [refresh, user]);

  // GitHub redirects back with a result flag; reflect it once, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('github_app');
    if (!flag) return;
    params.delete('github_app');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
    if (flag === 'error') {
      setError('GitHub App installation could not be verified. Start the install again.');
    } else if (flag === 'suspended') {
      setError('That GitHub App installation is suspended on GitHub.');
    } else if (flag === 'pending') {
      setError('Installation requested — an organization owner still needs to approve it.');
    } else if (user) {
      void refresh(user);
    }
  }, [user, refresh]);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
    userRef.current = null;
    setMe(null);
    setProjects([]);
    linkedTokenRef.current = null;
    pendingProviderTokenRef.current = null;
  }, [auth]);

  const setActiveProjectId = useCallback((id: string) => {
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    setActiveProjectIdState(id);
  }, []);

  const activeProject = useMemo(() => {
    if (projects.length === 0) return null;
    const match = projects.find((project) => project.id === activeProjectId);
    return match ?? projects[0] ?? null;
  }, [projects, activeProjectId]);

  const value: AppContextValue = {
    config,
    auth,
    api,
    user,
    authReady,
    me,
    projects,
    booting,
    error,
    setError,
    reload,
    signOut,
    activeProject,
    setActiveProjectId,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}

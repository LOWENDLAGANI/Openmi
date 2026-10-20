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
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { MeView, ProjectView } from '@shared/types';
import { createApiClient, type ApiClient } from './api';
import type { RuntimeConfig } from './config';
import { createSupabaseClient } from './supabase';

interface AppContextValue {
  config: RuntimeConfig;
  supabase: SupabaseClient;
  api: ApiClient;
  session: Session | null;
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
  const supabase = useMemo(
    () => createSupabaseClient(config.supabaseUrl, config.supabaseAnonKey),
    [config.supabaseUrl, config.supabaseAnonKey],
  );
  const api = useMemo(() => createApiClient(supabase), [supabase]);

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [me, setMe] = useState<MeView | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(
    () => window.localStorage.getItem(ACTIVE_PROJECT_KEY),
  );
  const linkedTokenRef = useRef<string | null>(null);

  const refresh = useCallback(
    async (currentSession: Session | null) => {
      if (!currentSession) {
        setMe(null);
        setProjects([]);
        return;
      }

      setBooting(true);
      try {
        // A GitHub OAuth token is only handed to the client on the sign-in
        // response, so persist it server-side the first time we see it.
        const providerToken = currentSession.provider_token;
        if (providerToken && linkedTokenRef.current !== providerToken) {
          linkedTokenRef.current = providerToken;
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
        setError(refreshError instanceof Error ? refreshError.message : 'Could not load your account');
      } finally {
        setBooting(false);
      }
    },
    [api],
  );

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setAuthReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) void refresh(nextSession);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [supabase, refresh]);

  useEffect(() => {
    if (session) void refresh(session);
  }, [session?.access_token, refresh]);

  const reload = useCallback(async () => {
    await refresh(session);
  }, [refresh, session]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setMe(null);
    setProjects([]);
    linkedTokenRef.current = null;
  }, [supabase]);

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
    supabase,
    api,
    session,
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

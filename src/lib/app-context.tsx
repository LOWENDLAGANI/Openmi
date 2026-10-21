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
/** Set before the OAuth redirect navigates away; consumed to detect a silent break. */
const OAUTH_PENDING_KEY = 'openmi:oauthPending';
function clearOAuthPending(): void {
  try {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
  } catch {
    /* storage unavailable */
  }
}
/** Returns true if a redirect was in flight, and clears the flag atomically. */
function consumeOAuthPending(): boolean {
  try {
    const pending = sessionStorage.getItem(OAUTH_PENDING_KEY) === '1';
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    return pending;
  } catch {
    return false;
  }
}

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
        if (!active) return;
        if (!result) return; // leave the pending flag for onAuthStateChanged to diagnose
        clearOAuthPending();
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
        } else {
          // Signed in, but Firebase returned no GitHub provider token (rare).
          // Linking would then never succeed; tell the user instead of
          // silently leaving them on the Connect-GitHub screen.
          setError(
            'GitHub sign-in completed but the repository access token was not returned. Install the OpenMi GitHub App below, or sign in again.',
          );
        }
      })
      .catch((redirectError) => {
        if (!active) return;
        clearOAuthPending(); // a specific error is surfaced below; don't double-report
        // A failed redirect leaves the user signed out. The previous code
        // swallowed this entirely, so the bounce back to the login screen
        // looked like an endless loop with no explanation. Surface the real
        // Firebase error code so the failure is diagnosable.
        const code = (redirectError as { code?: string } | null)?.code;
        if (
          code === 'auth/popup-closed-by-user' ||
          code === 'auth/cancelled-popup-request' ||
          code === 'auth/redirect-cancelled-by-user' ||
          code === 'auth/user-cancelled'
        ) {
          return; // user cancelled — no error banner needed
        }
        setError(
          code === 'auth/account-exists-with-different-credential'
            ? 'This email is already linked to another sign-in method. Sign in with your original provider, then link GitHub from account settings.'
            : code === 'auth/web-storage-unsupported' ||
                code === 'auth/operation-not-supported-in-this-environment'
              ? 'Your browser blocks the storage Firebase needs to keep you signed in. Allow cookies and site data, then try again.'
              : code === 'auth/timeout'
                ? 'GitHub sign-in timed out. Please try again.'
                : code === 'auth/invalid-credential' || code === 'auth/invalid-verification-code'
                  ? 'GitHub rejected the sign-in. Check the GitHub provider in Firebase console: Client ID, Client secret, and the authorized callback URL must match your GitHub OAuth app.'
                  : `GitHub sign-in did not complete (${code ?? 'unknown error'}). Try again.`,
        );
      });

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (!active) return;
      userRef.current = nextUser;
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        clearOAuthPending();
        void refresh(nextUser);
      } else if (consumeOAuthPending()) {
        // We just navigated back from an OAuth redirect (flag set before
        // signInWithRedirect) but Firebase reports no user and getRedirectResult
        // returned null — the redirect chain broke silently. Typical causes:
        // app domain missing from Firebase Authorized domains, or the GitHub
        // OAuth app's callback URL is not <authDomain>/__/auth/handler.
        setError(
          'GitHub sign-in returned without establishing a session. Add your site domain to Firebase → Authentication → Settings → Authorized domains, and verify the GitHub OAuth callback URL in Firebase console.',
        );
      }
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

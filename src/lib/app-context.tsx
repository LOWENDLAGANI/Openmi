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
import { consumeOAuthFlow, githubProviderTokenFrom, initFirebase, type Auth, type OAuthFlow } from './firebase';

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
/** Human label per in-flight flow, for error banners on a broken redirect. */
function flowLabel(flow: OAuthFlow): string {
  return flow === 'link' ? 'GitHub authorization' : 'Sign-in';
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
        // GitHub link redirect result, so persist it server-side the first
        // time we see it.
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
    // Snapshot the SDK's pending-redirect marker BEFORE getRedirectResult can
    // consume it — init doesn't (getAuth() is registered without a
    // popupRedirectResolver, so only getRedirectResult clears this key, after
    // awaiting init). It splits the two silent-null causes on the return leg:
    // missing = storage cleared mid-flow; present = redirect started but the
    // auth-domain event hand-off never delivered a result (blocked third-party
    // storage / abandoned at the provider). document.referrer names the hop
    // that brought the browser back.
    const pendingRedirectAtLoad = (() => {
      try {
        return (
          sessionStorage.getItem(
            `firebase:pendingRedirect:${config.firebase.apiKey}:[DEFAULT]`,
          ) !== null
        );
      } catch {
        return null;
      }
    })();
    const referrerHost = (() => {
      try {
        return document.referrer ? new URL(document.referrer).host : null;
      } catch {
        return null;
      }
    })();
    const returnLeg = ` [return leg: pending-redirect ${
      pendingRedirectAtLoad === null ? 'unreadable' : pendingRedirectAtLoad ? 'present' : 'missing'
    }, last hop ${referrerHost ?? 'none'}]`;
    // Capture the GitHub provider token from a just-completed OAuth redirect.
    // This must run once on mount; the token is unavailable afterwards.
    getRedirectResult(auth)
      .then((result) => {
        // Consumed only by the active run — the single judge of which redirect
        // was in flight (a StrictMode-inactive run must not steal the marker).
        const flow = active ? consumeOAuthFlow() : null;
        if (!result) {
          // Two possible reasons: the user simply opened the site signed-out
          // (flag absent), or we started an OAuth redirect that came back
          // WITHOUT a credential — the chain broke silently (wrong origin,
          // blocked Firebase auth-handler iframe, storage cleared mid-flow).
          // The SDK always emits onAuthStateChanged(null) BEFORE this promise
          // settles (init finishes first, the redirect result is delivered
          // afterwards), so the pending flow must be judged here — consuming
          // it in the auth listener fired a false positive on every
          // successful sign-in.
          if (active && flow) {
            // NOTE: neither branch advises adding the origin to Authorized
            // domains — seeing this branch at all PROVES the origin passed
            // Firebase's pre-navigation check (`_openRedirect` awaits
            // `_originValidation` before leaving the page, so an unauthorized
            // origin rejects signInWithRedirect/linkWithRedirect at start with
            // `auth/unauthorized-domain`, surfaced by the catch handler below).
            setError(
              flow === 'link'
                ? `GitHub authorization returned to ${window.location.origin} without completing. If you cancelled on GitHub that's expected; otherwise verify the GitHub OAuth callback URL (<authDomain>/__/auth/handler) in the Firebase console, then try again.${returnLeg}`
                : `Google sign-in returned to ${window.location.origin} with no session — it didn't finish. If you cancelled at Google that's expected. Otherwise the redirect started but Firebase delivered no result: a content blocker or third-party-storage restriction on the auth-domain hand-off is the usual cause (see Firebase's redirect best practices for non-Firebase-hosted apps).${
                    pendingRedirectAtLoad === false
                      ? ' Note: the pending redirect was already missing when this page loaded — site data was cleared mid-flow.'
                      : ''
                  }${returnLeg}`,
            );
          }
          return;
        }
        const token = githubProviderTokenFrom(result);
        if (token) {
          pendingProviderTokenRef.current = token;
          // onAuthStateChanged usually fires — and calls refresh() — before
          // this async result lands, so refresh() already ran with an empty
          // pending token and never linked GitHub. Refresh again now that the
          // token is captured. The linkedTokenRef guard makes a double-link a
          // no-op if the first refresh already won the race. Deliberately not
          // gated on `active`: in dev StrictMode the first effect run receives
          // the result, and its refs are shared with the second (still-active)
          // run, so the captured token must survive the cleanup.
          const current = userRef.current;
          if (current) void refresh(current);
        } else if (active && flow === 'link') {
          // The GitHub link completed but Firebase returned no provider token
          // (rare). Linking would then never succeed; tell the user instead of
          // silently leaving them on the Connect-GitHub screen. A Google
          // sign-in carries no GitHub token by design — that is not an error.
          setError(
            'GitHub authorization completed but the repository access token was not returned. Install the OpenMi GitHub App below, or connect again.',
          );
        }
      })
      .catch((redirectError) => {
        if (!active) return;
        // A specific error is surfaced below; consume the marker first so a
        // stale flag never doubles the report on a later load.
        const flow = consumeOAuthFlow();
        const label = flowLabel(flow ?? 'signin');
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
            ? 'This email is already linked to another sign-in method. Sign in with your original provider, then connect GitHub from the Connect GitHub screen.'
            : code === 'auth/credential-already-in-use'
              ? 'That GitHub account is already connected to a different OpenMi account. Disconnect it there first, or sign in with that account.'
              : code === 'auth/provider-already-linked'
                ? 'GitHub is already connected but its access token was missing. Install the OpenMi GitHub App below, or sign out and back in to retry.'
                : code === 'auth/web-storage-unsupported' ||
                    code === 'auth/operation-not-supported-in-this-environment'
                  ? 'Your browser blocks the storage Firebase needs to keep you signed in. Allow cookies and site data, then try again.'
                  : code === 'auth/timeout'
                    ? `${label} timed out. Please try again.`
                    : code === 'auth/invalid-credential' ||
                        code === 'auth/invalid-verification-code'
                      ? flow === 'link'
                        ? 'GitHub rejected the authorization. Check the GitHub provider in Firebase console: Client ID, Client secret, and the authorized callback URL must match your GitHub OAuth app.'
                        : 'Google rejected the sign-in. Check the Google provider in Firebase console: the authorized web origins and OAuth client must match this site.'
                      : code === 'auth/unauthorized-domain'
                        ? `This domain is not allowed to use Firebase sign-in. Add ${window.location.origin.replace(/^https?:\/\//, '')} to Firebase → Authentication → Settings → Authorized domains, then try again.`
                        : code === 'auth/network-request-failed'
                          ? `${label} could not finish because a request to Firebase failed. An ad blocker or network restriction may be interfering — allow Firebase/auth domains for this site and try again.`
                          : `${label} did not complete (${code ?? 'unknown error'}). Try again.`,
        );
      });

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (!active) return;
      userRef.current = nextUser;
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        // Deliberately does NOT clear the pending OAuth flow: a GitHub link
        // attempt starts while already signed in, so this emission would wipe
        // the marker before getRedirectResult judges a silently broken
        // redirect. The .then/.catch handlers above consume it instead.
        // A failed attempt's banner must not outlive a successful sign-in
        // (the pending-flag check runs before the redirect result lands, so
        // errors set during this load can go stale).
        setError(null);
        void refresh(nextUser);
      }
      // Signed-out emission: do NOT judge the oauth pending flow here. The SDK
      // always emits onAuthStateChanged(null) before getRedirectResult() settles
      // on the return page, so consuming the flow here fired a false "sign-in
      // returned without a session" error on every *successful* sign-in. The
      // null-result branch of getRedirectResult above is the single judge.
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
    setError(null);
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

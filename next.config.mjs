import { withSentryConfig } from "@sentry/nextjs/config";

// ── Security headers ────────────────────────────────────────────────────────
// Applied to every response from one place rather than per route, so a new API
// route cannot forget them.
//
// The CSP is deliberately the permissive-but-bounded kind rather than a
// nonce-based one. Openmi's own markup ships from 'self'; the restrictions that
// buy real safety here are the *boundaries*: nothing may be framed by a third
// party, no form may post anywhere unexpected, and the app may only talk to the
// one service it actually uses — its own origin and the Supabase project (Auth
// over https, PostgREST over https, realtime over wss). An injected script from
// another origin is blocked outright; an injected inline script is not, which
// is the accepted trade until the artifact preview — an <iframe srcdoc> that
// inherits this policy and would break under 'strict-dynamic' — is served from
// a separate origin.
//
// The wildcard is what makes this survive a project move: a Supabase project URL
// is https://<ref>.supabase.co, and Auth, PostgREST and Realtime all live under
// it. A custom domain in front of the project would need naming here too.
// Dropping any of these turns into a silent auth failure, which is exactly the
// kind of breakage that survives a code review.
const isDev = process.env.NODE_ENV !== "production";
const devEval = isDev ? " 'unsafe-eval'" : "";

// ── AdSense boundaries ──────────────────────────────────────────────────────
// Named one host at a time, with what each is for. AdSense is the only
// third-party script this app loads, and the policy still has to stop an
// injected script from talking anywhere it likes — so no `*` and no scheme
// wildcard for scripts, ever. These lists are also what the CSP test reads.
const adScriptOrigins = [
  "https://pagead2.googlesyndication.com", // the loader itself
  "https://*.googlesyndication.com", // ad rendering and measurement
  "https://*.googleadservices.com", // click and conversion measurement
  "https://adservice.google.com", // ad serving
];
const adFrameOrigins = [
  "https://googleads.g.doubleclick.net", // the ad iframe
  "https://tpc.googlesyndication.com", // the ad iframe's static frame
];
const adImageOrigins = [
  "https://*.doubleclick.net",
  "https://*.googlesyndication.com",
];

const contentSecurityPolicy = [
  "default-src 'self'",
  // 'unsafe-inline' for scripts is required by Next's hydration bootstrap, and
  // for styles because the app sets inline style attributes from React.
  // 'unsafe-eval' is added below for `next dev` only. React Refresh — the hot
  // reload runtime — evaluates a string to register each component, and without
  // it every page of the development site renders as an empty black screen with
  // an EvalError in the console. Production never gets the directive.
  `script-src 'self' 'unsafe-inline'${devEval} ${adScriptOrigins.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${adImageOrigins.join(" ")}`,
  "font-src 'self' data:",
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co ${adScriptOrigins.join(" ")}`,
  // The app's own artifact preview, plus the ad iframes. Nothing else.
  `frame-src 'self' ${adFrameOrigins.join(" ")}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  // Only meaningful over https; browsers ignore it over http, so it is safe to
  // always send.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Cross-Origin-Opener-Policy",
    // Supabase Auth is a full-page round trip, not a popup, so nothing needs to
    // keep a cross-origin window handle alive.
    value: "same-origin",
  },
  {
    key: "Permissions-Policy",
    // Camera and microphone are used by the composer (photo capture, voice
    // input) so they stay on for this origin only. Everything else the app has
    // no business asking for is switched off.
    value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

const nextConfig = {
  // The landing page moved to the root route. Answered here rather than with a
  // page that calls redirect(): a prerendered page's redirect only happens once
  // the client runs, so old links would render a blank hop instead of a 308.
  async redirects() {
    return [{ source: "/landing", destination: "/", permanent: true }];
  },
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

// Sentry wraps the config only when it is actually configured.
//
// This is a build-time switch, not a runtime one. The wrapper injects the
// client/server/edge config and rewrites every module for source maps, which
// roughly triples peak memory during `next build`. Doing that on every build —
// including the ones for a deployment that will never report an error — costs
// minutes and can exhaust a small build machine for nothing. So the wrapper is
// applied only when a DSN is present, which is exactly the condition under
// which reporting can happen at all.
//
// The consequence is worth stating plainly: with no DSN set, error reporting is
// off, and that is the whole point. With one set, the wrapper activates and
// stack traces resolve via uploaded source maps.
const sentryEnabled = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

export default sentryEnabled
  ? withSentryConfig(nextConfig, {
      silent: !process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Uploaded as release artefacts rather than served from the app, so the
      // public bundle is unchanged.
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
      widenClientFileUpload: true,
      hideSourceMaps: true,
      disableLogger: true,
    })
  : nextConfig;

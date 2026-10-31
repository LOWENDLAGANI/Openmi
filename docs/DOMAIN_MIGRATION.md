# New domain, same Vercel project

Everything to change when Openmi moves to a domain you just bought while the app
keeps running on the same Vercel project. Hosting, database, keys and data do
**not** move; what moves is the origin — and an origin is baked into more places
than it looks: build-time metadata, OAuth callbacks, Supabase redirect rules,
push subscriptions and search results.

Status: reference for a future move. Nothing here has been applied yet.
Last updated: 2026-10-29.

## The short version

| # | Where | What | Needs a rebuild? |
|---|---|---|---|
| 1 | Registrar → Vercel | Point the domain at the project and pick one canonical host | No |
| 2 | Vercel → Settings → Environment Variables | **`NEXT_PUBLIC_SITE_URL`** on Production *and* Preview | **Yes** |
| 3 | Supabase → Authentication → URL Configuration | Site URL + Redirect URLs (app origin, `/auth/reset-password`, localhost) | No |
| 4 | GitHub → OAuth App | Authorization callback URL `https://<new-domain>/api/github/oauth/callback` | No |
| 5 | Google Search Console, AdSense, email, push | Verify the new property, re-review ads, sender/subject, re-subscribe | No |
| 6 | Code | Two hardcoded `HTTP-Referer` values; docs | Yes (same deploy as #2) |

Everything else — Supabase URL and keys, model keys, AdSense ids, Sentry,
Upstash, Tavily, VAPID keys — is origin-independent and stays as it is.

## 1. Decide the canonical host before touching anything

Pick exactly one: `https://example.com` (apex) or `https://www.example.com`.
Every other host must redirect to it, permanently. Two hosts serving the same app
means two cookie jars, two service-worker scopes, two sets of OAuth callbacks and
links that resolve to whichever one the visitor happened to type.

`NEXT_PUBLIC_SITE_URL` must be that origin, **scheme included and no trailing
slash** — `https://example.com`, not `https://example.com/`. `lib/github/oauth.ts`
falls back to forwarded headers when it is malformed, which is a silently
different redirect from the one GitHub was configured with.

## 2. Vercel

Project → **Settings → Domains** → add the domain. Vercel prints the records to
create at the registrar:

- apex: `A` → `76.76.21.21` (Vercel may show a different target; use the one it
  prints, it changes)
- `www`: `CNAME` → `cname.vercel-dns.com`

Then choose the redirect direction in the same screen so the non-canonical host
308s to the canonical one. Keep the existing `*.vercel.app` domain attached:
it is the deployment's fallback address and removing it means a DNS mistake takes
the site down instead of just the new name.

Certificates are issued automatically once DNS resolves. Wait for **Valid
Configuration** before step 3.

## 3. Environment variables (the part that needs a redeploy)

Vercel → **Settings → Environment Variables**:

| Variable | New value | Scope |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://<new-domain>` | Production, Preview |

Why it cannot be skipped: it is read at **build time** by
[app/robots.ts](app/robots.ts), [app/sitemap.ts](app/sitemap.ts) and
[app/layout.tsx](app/layout.tsx#L34) (`metadataBase`), all of which are
prerendered. Changing it on a running deployment changes nothing until the next
build. It is also read at request time by
[lib/serverControl.ts](lib/serverControl.ts#L259) (the same-origin guard on
mutations) and [lib/github/oauth.ts](lib/github/oauth.ts#L175) (the GitHub
redirect).

After saving, **redeploy** (Deployments → ⋯ → Redeploy, and make sure "Use
existing build cache" is off for this one). A cached build keeps the old origin
in `robots.txt` and `sitemap.xml`.

Nothing else in [.env.example](.env.example) contains an origin. `WEB_PUSH_SUBJECT`
is a `mailto:` address — update it only if you are also changing the contact
address.

## 4. Supabase (dashboard, no migration)

Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://<new-domain>`
- **Redirect URLs**: keep the old origin while the change settles, and add
  - `https://<new-domain>`
  - `https://<new-domain>/auth/reset-password`
  - `http://localhost:3000` and `http://localhost:3000/auth/reset-password`

Every sign-in ends with the browser returning to one of these so the client can
exchange the PKCE code. A missing entry is an "invalid redirect URL" after the
provider has already authenticated the person — the worst place to fail.

Provider callbacks point at **Supabase**, not at this app
(`https://<project-ref>.supabase.co/auth/v1/callback`), so Google, GitHub and
Azure client settings do not change. See
[supabase/README.md](supabase/README.md#L115) for the provider list.

Sessions are per origin. After the move, people who sign in on the old address
get a separate session there; nothing is lost, they simply sign in again on the
new one.

## 5. GitHub OAuth App (the repository connection)

This is the app's own OAuth App, separate from the GitHub login Supabase handles.

GitHub → Settings → Developer settings → OAuth Apps → the Openmi app:

- **Homepage URL**: `https://<new-domain>`
- **Authorization callback URL**: `https://<new-domain>/api/github/oauth/callback`

The redirect is built from `NEXT_PUBLIC_SITE_URL` in
[lib/github/oauth.ts](lib/github/oauth.ts#L140), so the two must agree exactly.
Keep the old callback listed during the transition; GitHub allows one callback
URL per app, so the old origin's connect flow stops working the moment you save
— acceptable once the old host redirects.

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` do not change. Stored tokens stay
valid: they are sealed with `GITHUB_TOKEN_KEY`, not tied to a hostname.

## 6. Search, ads, email, push

- **Google Search Console** — add the new domain as a property, verify it (the
  existing `public/google15b7f2c7296d7959.html` is a path on any origin, so it
  keeps working), then submit `https://<new-domain>/sitemap.xml`. Keep the old
  property and its 301 in place; rankings follow a permanent redirect, slowly.
- **AdSense** — add the new domain as a site in AdSense and expect a fresh
  review. `/ads.txt` is generated from `NEXT_PUBLIC_ADSENSE_CLIENT_ID`, so it is
  already correct after the redeploy. The publisher and slot ids do not change.
  Ads on the old origin keep serving until it is redirected.
- **Email (Supabase Auth SMTP)** — if you send auth mail from an address on the
  old domain, add the new one to the provider's verified senders. Resetting a
  password from the new origin still needs `/auth/reset-password` in the redirect
  list from step 4.
- **Web push** — subscriptions are bound to the origin that created them. VAPID
  keys stay, but everyone has to re-subscribe on the new domain. Old
  subscriptions fail silently; they are not a reason to delay the move.
- **Sentry** — the DSN is origin-independent. If the project restricts allowed
  origins or uses a tunnel route, add the new host there.

## 7. Code that still names the old origin

Two files hardcode `https://openmi-ai.vercel.app` as the OpenRouter
`HTTP-Referer` header:

- [lib/providers.ts](lib/providers.ts#L73)
- [lib/promptOptimizer.ts](lib/promptOptimizer.ts#L115)

OpenRouter only uses these for attribution, so nothing breaks — but they will
keep advertising the old domain. The durable fix is to read
`process.env.NEXT_PUBLIC_SITE_URL` with the literal as a fallback, in the same
deploy as step 3. Nothing else in `app/`, `lib/` or `components/` contains a
hostname; share links, referral links and `window.location.origin` uses are all
computed at runtime and are correct on any domain.

Docs that mention the old address (`README.md`, `docs/legacy/VERCEL_ENV.md`) are
worth a sweep so the next reader is not sent to a redirect.

## 8. Verify before announcing it

Run against the new origin after the redeploy:

```bash
curl -sI https://<new-domain>/ | grep -i 'strict-transport\|content-security'
curl -s  https://<new-domain>/robots.txt | grep -i sitemap
curl -s  https://<new-domain>/sitemap.xml | head -5
curl -s  https://<new-domain>/ads.txt | head -3
curl -s  https://<new-domain>/manifest.webmanifest | head -5
curl -sI https://<old-origin>/ | head -3        # expect 308 to the new host
```

Then, in a browser:

1. Sign in with each provider you enabled; the round trip must land on the
   **new** origin, and the session must survive a reload.
2. Settings → Account shows the right name and the generated avatar.
3. Connect GitHub from the repository panel — that exercises the callback from
   step 5. A `redirect_uri_mismatch` means step 5 and `NEXT_PUBLIC_SITE_URL`
   disagree.
4. Open an old `/share/<id>` link and confirm the preview card resolves to the
   new origin (this is `metadataBase`).
5. Send one message, reload, and confirm history comes back from the account —
   history is server-loaded, so a wrong Supabase redirect shows up here.
6. Admin console: one mutation (Dew adjust) to confirm the same-origin guard
   accepts the new host.
7. Install the PWA from the new origin; the old installed copy is a different
   app and can be removed.

## 9. Rollback

Nothing in this move destroys data. If the new domain misbehaves: set
`NEXT_PUBLIC_SITE_URL` back to the old origin, redeploy, and remove the new
domain from Vercel. Supabase redirect URLs and the GitHub callback can keep the
old entries, which is why step 4 says to add rather than replace first.

## What does not change

- Supabase project URL, anon key, service role key, migrations, every row
- Model provider keys, Tavily, Upstash, Sentry, AdSense publisher/slot ids
- `GITHUB_TOKEN_KEY`, `AGENT_TURN_SECRET`, `AGENT_SWEEP_SECRET`, VAPID keys
- The Vercel deployment itself, its build settings and its `*.vercel.app` URL
- The CSP in [next.config.mjs](next.config.mjs): it names `'self'` and third
  parties, never the app's own hostname

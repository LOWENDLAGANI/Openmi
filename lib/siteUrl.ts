// ── This deployment's own origin ────────────────────────────────────────────
//
// One place that answers "what address is this app served from", because the
// answer is baked into files that are generated at build time (`robots.txt`,
// `sitemap.xml`, Open Graph tags) and into headers sent to other services
// (OpenRouter's attribution referer). When the app moved off its `*.vercel.app`
// address to openmi.space, each of those places held its own copy of the old
// origin, so the move was four edits and a risk of finding a fifth later.
//
// `NEXT_PUBLIC_SITE_URL` still wins: a preview deployment, a fork or a
// localhost run can point elsewhere without editing code. The fallback is the
// canonical domain, not a placeholder, so a deployment that forgets the variable
// still names a real address rather than `example.com`.

/** The canonical origin, used when no environment variable is set. */
export const DEFAULT_SITE_ORIGIN = "https://openmi.space";

/**
 * The origin this deployment considers canonical, without a trailing slash.
 *
 * A value that is not an absolute URL is ignored rather than repaired: half a
 * URL would produce share links and a sitemap pointing nowhere, which is worse
 * than the default it replaces.
 */
export function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ?? "";
  if (!configured) return DEFAULT_SITE_ORIGIN;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_SITE_ORIGIN;
    return configured;
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
}

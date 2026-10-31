import type { MetadataRoute } from "next";

// ── robots.txt ───────────────────────────────────────────────────────────────
// Generated rather than static so the sitemap's URL and the robots entry can
// never drift apart: both read the same environment variable, and a deployment
// on a custom domain produces a matching pair without anyone editing a file in
// /public.
//
// There used to be a static public/robots.txt alongside this route. It was
// never the fallback it was meant to be, for two separate reasons. In
// `next dev` a public file and a page file at the same path are a conflict
// Next.js refuses to resolve, so /robots.txt answered 500 instead of falling
// back to anything. In production the outcome was quieter and worse: the
// static file shadowed this route, so the sitemap line always named the
// hardcoded origin the file carried while the deployment sat on some other
// one — the drift this route exists to prevent, arriving by exactly the
// route meant to prevent it.
//
// One file, one source of truth: the rules below are what is served, and the
// sitemap URL is derived from NEXT_PUBLIC_SITE_URL the same way app/sitemap.ts
// derives its entries.
//
// Note that this route is prerendered at build time, so the variable has to
// be set when the deployment is built rather than only when it starts. Vercel
// supplies it to both, so a build there already has the right origin in it.
const base = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || "https://openmi.space";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        // Everything that is meant to be public is allowed: the pages, and
        // not the API. The API routes are not listed because they are not
        // crawlable anyway (they are POST-only or require an identity), and
        // naming them here would only tell a scraper where to aim.
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/chat"],
      },
    ],
    // Share previews are the growth loop, so the pages that carry them are
    // named explicitly for any crawler that reads sitemap.xml.
    sitemap: `${base}/sitemap.xml`,
  };
}

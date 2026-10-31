import { adsTxt } from "@/lib/ads";

// ── /ads.txt ─────────────────────────────────────────────────────────────────
// What AdSense verifies the domain against. Generated from the same variable
// the banner reads, so the file can never advertise a publisher the site does
// not use — and a deployment without ads answers 404 instead of serving an
// empty authorization line that a crawler would read as "no sellers".
//
// Cached like robots and sitemap: the content changes once, in a deploy.

export const dynamic = "force-dynamic";

export function GET(): Response {
  const body = adsTxt(process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID);

  if (!body) {
    return new Response("Not configured", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  }

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

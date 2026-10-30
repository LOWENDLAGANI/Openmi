// ── Openmi — one origin, defined once ───────────────────────────────────────
//
// The origin is baked into files generated at build time (`robots.txt`,
// `sitemap.xml`, Open Graph tags) and into a header sent to OpenRouter. Before
// [lib/siteUrl.ts](../lib/siteUrl.ts) each place carried its own copy, so moving
// the app off its `*.vercel.app` address to openmi.space meant finding four
// literals and hoping there was no fifth.
//
// These checks pin both halves of that: the fallback is the canonical domain and
// survives a malformed variable, and no file names the old host again.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SITE_ORIGIN, siteOrigin } from "../lib/siteUrl";

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  \u2717 ${label}`);
    console.log(`    ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

/** Runs `fn` with NEXT_PUBLIC_SITE_URL set to `value`, then restores it. */
function withSiteUrl(value: string | undefined, fn: () => void): void {
  const saved = process.env.NEXT_PUBLIC_SITE_URL;
  if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  }
}

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

console.log("\ncanonical origin");

check("the built-in origin is the live domain", () => {
  assert.equal(DEFAULT_SITE_ORIGIN, "https://openmi.space");
});

check("an unset variable falls back to it", () => {
  withSiteUrl(undefined, () => assert.equal(siteOrigin(), "https://openmi.space"));
  withSiteUrl("   ", () => assert.equal(siteOrigin(), "https://openmi.space"));
});

check("a trailing slash is removed, because every caller appends a path", () => {
  withSiteUrl("https://openmi.space/", () => assert.equal(siteOrigin(), "https://openmi.space"));
  withSiteUrl("https://openmi.space///", () => assert.equal(siteOrigin(), "https://openmi.space"));
});

check("surrounding whitespace from a copied dashboard value is ignored", () => {
  withSiteUrl("  https://openmi.space  ", () => assert.equal(siteOrigin(), "https://openmi.space"));
});

check("a preview or localhost deployment can point elsewhere", () => {
  withSiteUrl("https://openmi-git-main.vercel.app", () =>
    assert.equal(siteOrigin(), "https://openmi-git-main.vercel.app")
  );
  withSiteUrl("http://localhost:3000", () => assert.equal(siteOrigin(), "http://localhost:3000"));
});

check("a value that is not an absolute http url is refused, not repaired", () => {
  withSiteUrl("openmi.space", () => assert.equal(siteOrigin(), "https://openmi.space"));
  withSiteUrl("javascript:alert(1)", () => assert.equal(siteOrigin(), "https://openmi.space"));
  withSiteUrl("not a url", () => assert.equal(siteOrigin(), "https://openmi.space"));
});

check("the sitemap and robots file derive their entries from the helper", () => {
  for (const file of ["app/sitemap.ts", "app/robots.ts"]) {
    const text = source(file);
    assert.match(text, /from "@\/lib\/siteUrl"/, `${file} does not import the helper`);
    assert.match(text, /const base = siteOrigin\(\)/, `${file} does not use it`);
    assert.doesNotMatch(text, /example\.com/, `${file} still carries a placeholder origin`);
  }
});

check("no source file names the old vercel host", () => {
  for (const file of ["lib/providers.ts", "lib/promptOptimizer.ts", "lib/siteUrl.ts", ".env.example"]) {
    assert.doesNotMatch(source(file), /openmi-ai\.vercel\.app/, `${file} still names the old host`);
  }
});

check("the OpenRouter attribution header comes from the origin", () => {
  assert.match(source("lib/providers.ts"), /"HTTP-Referer": siteOrigin\(\)/);
  assert.match(source("lib/promptOptimizer.ts"), /"HTTP-Referer": siteOrigin\(\)/);
});

check("the example environment names the live domain", () => {
  assert.match(source(".env.example"), /^NEXT_PUBLIC_SITE_URL=https:\/\/openmi\.space$/m);
});

if (failed > 0) {
  console.log(`\nsite-url: ${failed} check(s) failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nsite-url: ${passed} checks passed`);

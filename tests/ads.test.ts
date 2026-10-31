// ── Openmi — tests for the ad slot ───────────────────────────────────────────
//
// An ad unit is easy to get subtly wrong in ways nobody notices until a
// reviewer does: a slot that renders without a tag (an empty box), a banner
// that pushes the composer down when it finally loads, a script injected twice,
// a CSP widened to `*` "just to make the ad work". Each of those is pinned
// here, including the one that matters most — the policy stays a list of named
// hosts.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AD_HEIGHT_DESKTOP,
  AD_HEIGHT_MOBILE,
  AD_MAX_WIDTH,
  ADSTERRA_BANNER_HEIGHT,
  ADSTERRA_BANNER_WIDTH,
  adsterraBannerConfigured,
  adsterraBannerKey,
  adsterraBannerOrigin,
  adsterraBannerSrc,
} from "../lib/ads";

let failures = 0;
let passes = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

async function main(): Promise<void> {
  console.log("\nthe tag");

  await test("the tag URL must be a real script carrying a zone key", () => {
    const src = "//www.highperformanceformat.com/3306d19d042fdaa38a6dfac27962817e/invoke.js";
    assert.equal(
      adsterraBannerSrc(src),
      "https://www.highperformanceformat.com/3306d19d042fdaa38a6dfac27962817e/invoke.js"
    );
    for (const bad of [
      "",
      "   ",
      "3306d19d042fdaa38a6dfac27962817e",
      "https://example.com/tag.html",
      "javascript:alert(1)",
      "https://www.highperformanceformat.com/invoke.js",
      undefined,
    ]) {
      assert.equal(adsterraBannerSrc(bad), null, `"${bad}" must not be loaded as a script`);
    }
  });

  await test("the zone key comes from the tag itself, not a second variable", () => {
    assert.equal(adsterraBannerKey("https://host.test/abc12345/invoke.js"), "abc12345");
    assert.equal(adsterraBannerKey("https://host.test/invoke.js"), null, "no key segment means no tag");
    assert.equal(adsterraBannerKey("nonsense"), null);
    assert.equal(adsterraBannerKey(null), null);
  });

  await test("the origin is what the policy allows", () => {
    assert.equal(
      adsterraBannerOrigin("https://pl9.highperformanceformat.com/a/b/invoke.js"),
      "https://pl9.highperformanceformat.com"
    );
    assert.equal(adsterraBannerOrigin(null), null);
  });

  await test("no tag means no banner", () => {
    assert.equal(adsterraBannerConfigured(""), false);
    assert.equal(adsterraBannerConfigured(undefined), false);
    assert.equal(adsterraBannerConfigured("//host.test/abc12345/invoke.js"), true);
    assert.equal(adsterraBannerConfigured("//host.test/abc12345/invoke.js?x=1"), true);
  });

  await test("the banner fits the reserved slot", () => {
    assert.equal(ADSTERRA_BANNER_WIDTH, 320);
    assert.equal(ADSTERRA_BANNER_HEIGHT, 50);
    // A taller unit would be clipped by the box the composer is laid out around.
    assert.ok(ADSTERRA_BANNER_HEIGHT <= AD_HEIGHT_MOBILE, "the banner must not outgrow the slot");
  });

  console.log("\nthe slot");

  await test("the height is reserved, and the two sizes are the only source", () => {
    assert.equal(AD_HEIGHT_MOBILE, 50);
    assert.equal(AD_HEIGHT_DESKTOP, 60);
    assert.equal(AD_MAX_WIDTH, 728);
    const banner = read("components/AdBanner.tsx");
    assert.match(banner, /height: AD_HEIGHT_MOBILE/, "the mobile height must come from the constant");
    assert.match(banner, /height: \$\{AD_HEIGHT_DESKTOP\}px/, "the desktop height must come from the constant");
    // A breakpoint override rather than a measured height is what keeps the
    // composer still when the network is slow.
    assert.match(banner, /min-width: 768px/);
  });

  await test("the kill switch removes the furniture, a missing tag does not", () => {
    const banner = read("components/AdBanner.tsx");
    assert.match(banner, /const ready = enabled && Boolean\(src\) && Boolean\(key\)/);
    assert.match(banner, /if \(!enabled\) return null;/, "only the admin switch may remove the box");
    assert.doesNotMatch(banner, /if \(!ready\) return null;/, "an unconfigured slot must stay visible");
  });

  await test("the empty slot says what it is and how big it is", () => {
    const banner = read("components/AdBanner.tsx");
    assert.match(banner, /data-ad-placeholder="true"/);
    assert.match(banner, /Ad space · \{ADSTERRA_BANNER_WIDTH\} × \{ADSTERRA_BANNER_HEIGHT\}/);
    // One box, one height: the placeholder sits inside the same reserved slot
    // as a filled banner, so the composer never moves when a tag is added.
    assert.match(banner, /style=\{\{ height: AD_HEIGHT_MOBILE \}\}/);
  });

  await test("the tag loads once, inside the reserved box", () => {
    const banner = read("components/AdBanner.tsx");
    assert.match(banner, /\{ready \? \(/, "the holder exists only when there is a tag to load");
    assert.match(banner, /holder\.current/);
    assert.match(banner, /node\.dataset\.loaded === "true"/, "a remount must not request a second banner");
    assert.match(banner, /win\.atOptions = \{/);
    assert.match(banner, /format: "iframe"/);
    assert.match(banner, /document\.createElement\("script"\)/);
    assert.equal(banner.match(/createElement\("script"\)/g)?.length, 1, "one injected tag, not two");
    assert.match(banner, /data-adsterra-banner="true"/);
  });

  await test("the ad is kept off the screens it does not belong on", () => {
    const page = read("app/chat/page.tsx");
    // One placement, inside the one guard. Anything outside it would put an
    // advertisement where the screen is not meant to have any furniture.
    assert.match(page, /!focusHome && <AdBanner enabled=\{appConfig\?\.adsEnabled !== false\} \/>/);
    assert.equal(page.match(/<AdBanner/g)?.length, 1, "one placement, one component");
  });

  await test("the kill switch is a stored column, not just a code comment", () => {
    const config = read("lib/appConfig.ts");
    assert.match(config, /adsEnabled: boolean/);
    assert.match(config, /adsEnabled: asBool\(value\.adsEnabled, DEFAULT_CONFIG\.adsEnabled\)/);
    assert.match(read("lib/serverControl.ts"), /ads_enabled: config\.adsEnabled/);
    assert.match(read("supabase/migrations/20261025000100_ads_enabled.sql"), /ads_enabled boolean not null default true/);
    assert.match(read("components/AdminControls.tsx"), /label="Ads"/);
  });

  console.log("\none network only");

  await test("no second ad network survives anywhere", () => {
    // Removing a network is only done when nothing can re-introduce it: a
    // leftover env var, CSP entry, route or component import would bring it
    // back the next time someone pastes a tag into the dashboard.
    for (const file of [
      ".env.example",
      "lib/ads.ts",
      "components/AdBanner.tsx",
      "app/chat/page.tsx",
      "next.config.mjs",
      "app/privacy/page.tsx",
      "README.md",
      "docs/DOMAIN_MIGRATION.md",
    ]) {
      assert.doesNotMatch(
        read(file),
        /adsense|googlesyndication|googlesyndication|doubleclick|googleadservices|adssettings/i,
        `${file} still names the removed network`
      );
      assert.doesNotMatch(read(file), /popunder/i, `${file} still names the removed popunder`);
    }
    assert.throws(() => read("components/AdPopunder.tsx"), "the popunder component must stay deleted");
    assert.throws(() => read("app/ads.txt/route.ts"), "the ads.txt route was AdSense's; it must be gone");
  });

  console.log("\nthe policy");

  await test("the CSP derives the one ad origin rather than wildcarding", () => {
    const config = read("next.config.mjs");
    assert.match(config, /NEXT_PUBLIC_ADSTERRA_BANNER_SRC/);
    assert.match(config, /const adScripts = bannerOrigin \? \[bannerOrigin\] : \[\]/);
    assert.match(config, /const adFrames = bannerOrigin \? \[bannerOrigin\] : \[\]/);
    assert.match(config, /frame-src[^\n]*\$\{adFrames\.join/);
  });

  await test("the CSP wildcards nothing but the Supabase project", async () => {
    const { default: config } = await import("../next.config.mjs");
    const headers = await config.headers();
    const firstRow = headers[0];
    assert.ok(firstRow, "the app must send headers");
    const csp = firstRow.headers.find((header: { key: string }) => header.key === "Content-Security-Policy");
    assert.ok(csp, "the app must send a CSP at all");
    const policy: string = csp.value;
    assert.ok(!policy.includes(" *"), "a bare wildcard defeats the boundary this policy exists for");

    const allowedWildcards = new Set([
      // Supabase: one project is https://<ref>.supabase.co, and auth, REST and
      // realtime all live under it. Moving a project must not break the app.
      "https://*.supabase.co",
      "wss://*.supabase.co",
    ]);

    for (const directive of policy.split(";")) {
      for (const source of directive.trim().split(/\s+/).slice(1)) {
        if (!source.includes("*")) continue;
        assert.ok(allowedWildcards.has(source), `the CSP wildcards "${source}", which is not a Supabase host`);
      }
    }

    for (const host of ["googlesyndication", "doubleclick", "googleadservices", "adservice.google.com"]) {
      assert.ok(!policy.includes(host), `the policy still allows ${host}, which no code loads`);
    }
  });

  console.log("\npublic surface");

  await test("the privacy page names the network and the ad controls", () => {
    const page = read("app/privacy/page.tsx");
    assert.match(page, /Adsterra/);
    assert.match(page, /adsterra\.com\/privacy-policy/);
    assert.match(page, /Your rights and controls/);
    assert.match(page, /Settings → Your data/);
    assert.match(page, /export const metadata/);
  });

  console.log(
    failures === 0
      ? `\n${passes} passed\n`
      : `\n${passes} passed, ${failures} FAILED\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();

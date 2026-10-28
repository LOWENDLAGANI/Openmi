// ── Openmi — tests for the ad slot ───────────────────────────────────────────
//
// An ad unit is easy to get subtly wrong in ways nobody notices until a
// reviewer does: a slot that renders before its ids exist (an empty box), a
// banner that pushes the composer down when it finally loads, a script tag that
// loads twice, a CSP widened to `*` "just to make the ad work". Each of those is
// pinned here, including the one that matters most — the policy stays a list of
// named hosts.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AD_HEIGHT_DESKTOP,
  AD_HEIGHT_MOBILE,
  AD_MAX_WIDTH,
  adsTxt,
  adsenseClientId,
  adsenseConfigured,
  adsenseSlotId,
  adPopunderConfigured,
  adsterraPopunderOrigin,
  adsterraPopunderSrc,
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
  console.log("\nids");

  await test("a real publisher id is accepted, a near miss is not", () => {
    assert.equal(adsenseClientId("ca-pub-1234567890123456"), "ca-pub-1234567890123456");
    for (const value of ["", "   ", "pub-1234567890123456", "ca-pub-abc", "ca-pub-123", undefined]) {
      assert.equal(adsenseClientId(value), null, `"${value}" must not count as a publisher id`);
    }
  });

  await test("a slot id is digits only", () => {
    assert.equal(adsenseSlotId("1234567890"), "1234567890");
    for (const value of ["", "slot-1", "12", undefined]) {
      assert.equal(adsenseSlotId(value), null);
    }
  });

  await test("both ids are required before anything renders", () => {
    assert.equal(adsenseConfigured("ca-pub-1234567890123456", "1234567890"), true);
    assert.equal(adsenseConfigured("ca-pub-1234567890123456", ""), false);
    assert.equal(adsenseConfigured("", "1234567890"), false);
    assert.equal(adsenseConfigured(undefined, undefined), false);
  });

  console.log("\nads.txt");

  await test("ads.txt is derived from the publisher id", () => {
    assert.equal(
      adsTxt("ca-pub-1234567890123456"),
      "google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n"
    );
  });

  await test("no publisher id means no ads.txt, not an empty one", () => {
    assert.equal(adsTxt(null), null);
    assert.equal(adsTxt("ca-pub-nope"), null);
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

  await test("nothing renders without ids or with the kill switch off", () => {
    const banner = read("components/AdBanner.tsx");
    assert.match(banner, /const ready = enabled && Boolean\(client\) && Boolean\(slot\)/);
    assert.match(banner, /if \(!ready\) return null;/);
  });

  await test("exactly one push per mount", () => {
    const banner = read("components/AdBanner.tsx");
    assert.match(banner, /const pushed = useRef\(false\)/);
    assert.match(banner, /if \(!ready \|\| pushed\.current\) return;/);
    assert.match(banner, /pushed\.current = true/);
    assert.equal(banner.match(/adsbygoogle\.push/g)?.length, 1, "a second push would double-count");
  });

  await test("the loader is lazy, same-origin-checked and not auto ads", () => {
    const banner = read("components/AdBanner.tsx");
    assert.match(banner, /strategy="afterInteractive"/);
    assert.match(banner, /data-ad-format="horizontal"/);
    assert.equal(banner.match(/data-ad-client=/g)?.length, 1, "one unit, one client id");
    assert.match(banner, /\$\{ADSENSE_SCRIPT\}\?client=/, "the loader URL comes from the one constant");
    assert.equal(
      banner.match(/googlesyndication\.com\/pagead/g)?.length ?? 0,
      0,
      "the URL must not be hard-coded twice"
    );
  });

  await test("the ad is kept off the screens it does not belong on", () => {
    const page = read("app/chat/page.tsx");
    // Both the banner and the popunder sit inside the same guard. Either one
    // outside it would put an advertisement in a temporary chat, which is the
    // screen whose whole promise is that nothing is recorded.
    assert.match(
      page,
      /!focusHome && !temporary && \([\s\S]*?<AdBanner enabled=\{appConfig\?\.adsEnabled !== false\}/
    );
    assert.match(
      page,
      /!focusHome && !temporary && \([\s\S]*?<AdPopunder enabled=\{appConfig\?\.adsEnabled !== false\}/
    );
  });

  await test("the kill switch is a stored column, not just a code comment", () => {
    const config = read("lib/appConfig.ts");
    assert.match(config, /adsEnabled: boolean/);
    assert.match(config, /adsEnabled: asBool\(value\.adsEnabled, DEFAULT_CONFIG\.adsEnabled\)/);
    assert.match(read("lib/serverControl.ts"), /ads_enabled: config\.adsEnabled/);
    assert.match(read("supabase/migrations/20261025000100_ads_enabled.sql"), /ads_enabled boolean not null default true/);
    assert.match(read("components/AdminControls.tsx"), /label="Ads"/);
  });

  console.log("\nthe popunder");

  await test("a popunder needs a real script URL, not a bare key", () => {
    assert.equal(
      adsterraPopunderSrc("//pl123.profitablecpmrate.com/ab/cd.js"),
      "https://pl123.profitablecpmrate.com/ab/cd.js"
    );
    for (const value of ["", "   ", "pl123", "https://example.com/tag", "javascript:alert(1)", undefined]) {
      assert.equal(adsterraPopunderSrc(value), null, `"${value}" must not be loaded as a script`);
    }
  });

  await test("the popunder's origin is what the policy allows", () => {
    assert.equal(
      adsterraPopunderOrigin("https://pl9.profitablecpmrate.com/a/b.js"),
      "https://pl9.profitablecpmrate.com"
    );
    assert.equal(adsterraPopunderOrigin(null), null);
  });

  await test("no tag means no popunder, and the switch still wins", () => {
    assert.equal(adPopunderConfigured(""), false);
    assert.equal(adPopunderConfigured(undefined), false);
    assert.equal(adPopunderConfigured("//pl1.example.com/a.js"), true);
    const popunder = read("components/AdPopunder.tsx");
    assert.match(popunder, /if \(!enabled \|\| !src\) return null;/);
    assert.equal(popunder.match(/<Script/g)?.length, 1, "one tag, not two");
    assert.match(popunder, /strategy="afterInteractive"/);
  });

  await test("the popunder is loaded on the same screens as the banner", () => {
    const page = read("app/chat/page.tsx");
    assert.match(page, /<AdPopunder enabled=\{appConfig\?\.adsEnabled !== false\}/);
  });

  await test("the CSP derives the popunder origin rather than wildcarding", () => {
    const config = read("next.config.mjs");
    assert.match(config, /NEXT_PUBLIC_ADSTERRA_POPUNDER_SRC/);
    assert.match(config, /const adScripts = \[\.\.\.adScriptOrigins/);
    assert.match(config, /script-src[^\n]*\$\{adScripts\.join/);
  });

  console.log("\nthe policy");

  await test("the CSP names AdSense's hosts and nothing wilder", async () => {
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
      // AdSense's own hosts, named per directive.
      "https://*.googlesyndication.com",
      "https://*.googleadservices.com",
      "https://*.doubleclick.net",
    ]);

    for (const directive of policy.split(";")) {
      for (const source of directive.trim().split(/\s+/).slice(1)) {
        if (!source.includes("*")) continue;
        assert.ok(allowedWildcards.has(source), `the CSP wildcards "${source}", which is not one of the named hosts`);
      }
    }
  });

  await test("each AdSense capability is present where the ad needs it", async () => {
    const { default: config } = await import("../next.config.mjs");
    const headers = await config.headers();
    const row = headers[0];
    assert.ok(row, "the app must send headers");
    const policy: string =
      row.headers.find((header: { key: string }) => header.key === "Content-Security-Policy")?.value ?? "";
    assert.ok(policy.length > 0, "the app must send a CSP at all");
    const directive = (name: string) =>
      policy
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name} `)) ?? "";

    for (const host of ["https://pagead2.googlesyndication.com", "https://*.googleadservices.com"]) {
      assert.ok(directive("script-src").includes(host), `script-src is missing ${host}`);
      assert.ok(directive("connect-src").includes(host), `connect-src is missing ${host}`);
    }
    for (const host of ["https://googleads.g.doubleclick.net", "https://tpc.googlesyndication.com"]) {
      assert.ok(directive("frame-src").includes(host), `frame-src is missing ${host}`);
    }
    for (const host of ["https://*.doubleclick.net"]) {
      assert.ok(directive("img-src").includes(host), `img-src is missing ${host}`);
    }
  });

  console.log("\npublic surface");

  await test("there is a privacy page that names the ad settings and deletion", () => {
    const page = read("app/privacy/page.tsx");
    assert.match(page, /AdSense/);
    assert.match(page, /Adsterra/);
    assert.match(page, /popunder/i);
    assert.match(page, /adssettings\.google\.com/);
    assert.match(page, /Your rights and controls/);
    assert.match(page, /Settings → Your data/);
    assert.match(page, /export const metadata/);
  });

  await test("ads.txt answers 404 when the deployment has no publisher", () => {
    const route = read("app/ads.txt/route.ts");
    assert.match(route, /status: 404/);
    assert.match(route, /text\/plain/);
  });

  console.log(
    failures === 0
      ? `\n${passes} passed\n`
      : `\n${passes} passed, ${failures} FAILED\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();

// ── Openmi — tests for the rate-limit policy ─────────────────────────────────
//
// The plan's claim is "one policy, one error shape, visible countdown, no
// unguarded routes". Each of those is a property that decays quietly — a new
// route passes its own literal, a 429 loses its header, an endpoint ships
// without a limiter — so this file pins all four rather than testing one happy
// path through the counter.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RATE_LIMITS, rateLimitMessage, type RateLimitScope } from "../lib/rateLimitPolicy";
import {
  checkRateLimit,
  rateLimitHeaders,
  rateLimitRefusal,
  sharedRateLimit,
  type CallerIdentity,
} from "../lib/serverControl";
import { parseRetrySeconds, secondsRemaining } from "../lib/rateLimit";

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

/** Every route file under app/api, so a new route cannot hide from the scan. */
function routeFiles(dir = "app/api"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (entry === "route.ts") out.push(path);
  }
  return out.sort();
}

const caller = (uid: string): CallerIdentity => ({ uid, email: `${uid}@example.test` });
const request = { headers: new Headers() };

async function main(): Promise<void> {
  console.log("\nthe policy table");

  await test("every scope has a real ceiling and a word for it", () => {
    const scopes = Object.entries(RATE_LIMITS);
    assert.ok(scopes.length >= 15, "the table covers the routes this app ships");
    for (const [scope, policy] of scopes) {
      assert.ok(Number.isInteger(policy.perMinute) && policy.perMinute > 0, `${scope} has no ceiling`);
      assert.ok(policy.label.trim().length > 0, `${scope} has no label, so refusals cannot explain it`);
    }
  });

  await test("no route passes its own literal limit any more", () => {
    // The whole point of the table. A number here is a policy that cannot be
    // reviewed with the rest of it.
    for (const file of routeFiles()) {
      const source = read(file);
      assert.ok(
        !/checkRateLimit\(req,[^)]*,\s*\d+/.test(source),
        `${file} still passes a literal ceiling to checkRateLimit`
      );
    }
  });

  await test("every scope a route spends exists in the table", () => {
    const used = new Set<string>();
    for (const file of routeFiles()) {
      for (const match of read(file).matchAll(/checkRateLimit\(req, [^,]+(?:, [^,)]+)?, "([\w-]+)"/g)) {
        used.add(match[1]!);
      }
    }
    assert.ok(used.size >= 15, `only found ${used.size} scopes in the routes`);
    for (const scope of used) {
      assert.ok(scope in RATE_LIMITS, `route uses scope "${scope}", which the policy does not define`);
    }
  });

  await test("the routes that had no limiter now take one", () => {
    for (const file of [
      "app/api/setup/route.ts",
      "app/api/github/status/route.ts",
      "app/api/admin/config/route.ts",
      "app/api/admin/models/route.ts",
    ]) {
      assert.match(read(file), /checkRateLimit\(req,/, `${file} is unguarded`);
      assert.match(read(file), /rateLimitRefusal\(limit\)/, `${file} refuses without the shared shape`);
    }
  });

  console.log("\nthe counter");

  await test("this test runs on the in-process bucket, not a shared store", () => {
    // If a developer has Upstash configured, these tests would spend real
    // counters and could fail intermittently. Say which mode is under test.
    assert.equal(sharedRateLimit, false, "unset UPSTASH_REDIS_REST_* before running the tests");
  });

  await test("the ceiling comes from the policy, and the next call is refused", async () => {
    const who = caller("limit-ceiling");
    const scope: RateLimitScope = "setup";
    const { perMinute } = RATE_LIMITS[scope];
    const now = 1_000_000;

    for (let i = 0; i < perMinute; i += 1) {
      const state = await checkRateLimit(request, who, scope, now);
      assert.equal(state.allowed, true, `call ${i + 1} of ${perMinute} was refused`);
      assert.equal(state.limit, perMinute);
      assert.equal(state.remaining, perMinute - i - 1);
    }

    const refused = await checkRateLimit(request, who, scope, now);
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 0);
    assert.equal(refused.limit, perMinute);
    assert.equal(refused.retryAfterSeconds, 60, "a full minute bucket reports a minute");
  });

  await test("one account's flood does not spend another's budget", async () => {
    const scope: RateLimitScope = "setup";
    const now = 2_000_000;
    const { perMinute } = RATE_LIMITS[scope];

    for (let i = 0; i < perMinute; i += 1) await checkRateLimit(request, caller("flooder"), scope, now);
    const flooded = await checkRateLimit(request, caller("flooder"), scope, now);
    assert.equal(flooded.allowed, false);

    const bystander = await checkRateLimit(request, caller("bystander"), scope, now);
    assert.equal(bystander.allowed, true, "the limit followed the account, not the process");
    assert.equal(bystander.remaining, perMinute - 1);
  });

  await test("the window rolls over on its own", async () => {
    const who = caller("window");
    const scope: RateLimitScope = "setup";
    const now = 3_000_000;
    const { perMinute } = RATE_LIMITS[scope];

    for (let i = 0; i < perMinute; i += 1) await checkRateLimit(request, who, scope, now);
    assert.equal((await checkRateLimit(request, who, scope, now)).allowed, false);

    const later = now + 60_001;
    const fresh = await checkRateLimit(request, who, scope, later);
    assert.equal(fresh.allowed, true, "a minute later the bucket is empty again");
    assert.equal(fresh.remaining, perMinute - 1);
  });

  await test("an unidentified caller is limited by address, not exempt", async () => {
    const scope: RateLimitScope = "setup";
    const now = 4_000_000;
    const { perMinute } = RATE_LIMITS[scope];
    const anonymous = { headers: new Headers({ "x-forwarded-for": "203.0.113.9" }) };

    for (let i = 0; i < perMinute; i += 1) await checkRateLimit(anonymous, null, scope, now);
    assert.equal((await checkRateLimit(anonymous, null, scope, now)).allowed, false);
  });

  console.log("\nthe shape of a refusal");

  await test("a refusal carries Retry-After and the budget headers", async () => {
    const scope: RateLimitScope = "commits";
    const now = 5_000_000;
    const who = caller("headers");
    for (let i = 0; i < RATE_LIMITS[scope].perMinute; i += 1) await checkRateLimit(request, who, scope, now);
    const refused = await checkRateLimit(request, who, scope, now);
    const headers = rateLimitHeaders(refused, now);

    assert.equal(headers["Retry-After"], String(refused.retryAfterSeconds));
    assert.equal(headers["X-RateLimit-Limit"], String(RATE_LIMITS[scope].perMinute));
    assert.equal(headers["X-RateLimit-Remaining"], "0");
    assert.ok(Number(headers["X-RateLimit-Reset"]) > Math.floor(now / 1000));
  });

  await test("a successful call reports the budget without a Retry-After", async () => {
    const allowed = await checkRateLimit(request, caller("headers-ok"), "chat", 6_000_000);
    const headers = rateLimitHeaders(allowed, 6_000_000);
    assert.equal(headers["Retry-After"], undefined, "Retry-After is meaningless on a success");
    assert.equal(headers["X-RateLimit-Remaining"], String(allowed.remaining));
  });

  await test("the JSON refusal has one shape, wait included", async () => {
    const scope: RateLimitScope = "share-create";
    const now = 7_000_000;
    const who = caller("body-shape");
    for (let i = 0; i < RATE_LIMITS[scope].perMinute; i += 1) await checkRateLimit(request, who, scope, now);
    const refused = await checkRateLimit(request, who, scope, now);

    const response = rateLimitRefusal(refused);
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error?: string; retryAfterSeconds?: number; limit?: number };
    assert.ok(body.error && body.error.length > 0);
    assert.equal(body.retryAfterSeconds, refused.retryAfterSeconds);
    assert.equal(body.limit, RATE_LIMITS[scope].perMinute);
    assert.equal(response.headers.get("Retry-After"), String(refused.retryAfterSeconds));
  });

  await test("chat refuses inside the stream and repeats the wait as a field", () => {
    // The composer reads the event field; a proxy or an operator reads the
    // headers. Both come from the same state, so they cannot disagree.
    const route = read("app/api/chat/route.ts");
    assert.match(route, /retryAfterSeconds: limit\.retryAfterSeconds/);
    assert.match(route, /headers: rateLimitHeaders\(limit\)/);
    assert.match(route, /rateLimitMessage\(limit\.scope, limit\.retryAfterSeconds\)/);
  });

  console.log("\nthe client's side of it");

  await test("every server sentence parses to the same number", () => {
    for (const scope of Object.keys(RATE_LIMITS) as RateLimitScope[]) {
      assert.equal(parseRetrySeconds(rateLimitMessage(scope, 12)), 12, `${scope}'s sentence does not parse`);
    }
    // The shapes that existed before the policy, kept working: a client running
    // an older bundle must still find the wait.
    assert.equal(parseRetrySeconds("Too many attempts. Try again in 7s."), 7);
    assert.equal(parseRetrySeconds("Please wait 20s and try again."), 20);
    assert.equal(parseRetrySeconds("Too many requests. Try again shortly."), null);
    assert.equal(parseRetrySeconds("Openmi is paused right now."), null);
  });

  await test("the countdown never shows a negative or a fraction", () => {
    const now = 9_000_000;
    assert.equal(secondsRemaining(now + 4_500, now), 5);
    assert.equal(secondsRemaining(now - 5_000, now), 0);
    assert.equal(secondsRemaining(now, now), 0);
  });

  await test("the composer reads the body's field before the sentence", () => {
    const page = read("app/page.tsx");
    assert.match(page, /noteRateLimit\(message, payload\?\.retryAfterSeconds\)/);
    assert.match(page, /noteRateLimit\(evt\.error, evt\.retryAfterSeconds\)/);
    // And a successful answer clears the countdown instead of waiting it out.
    assert.match(page, /setRateLimitUntil\(\(current\) => \(current \? null : current\)\)/);
  });

  console.log("\nthe operator's copy");

  await test("the shared-store caveat is where an operator looks", () => {
    const env = read(".env.example");
    assert.match(env, /UPSTASH_REDIS_REST_URL/);
    assert.match(env, /cold start/);
    assert.match(env, /speed bump/);
    // And in the console, not only in a code comment.
    assert.match(read("components/AdminControls.tsx"), /cold start/);
    assert.match(read("components/AdminControls.tsx"), /per instance/);
  });

  console.log(
    failures === 0
      ? `\n${passes} passed\n`
      : `\n${passes} passed, ${failures} FAILED\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();

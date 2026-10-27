// ── Openmi — tests for the admin model health checks ───────────────────────────
//
// A status board that cannot be trusted is worse than none: an administrator
// who sees every model green while a chat is failing stops investigating. These
// pin the three things that make the check mean something — it asks the model
// you asked about, it tells the truth when the model cannot be reached, and it
// never carries a provider name into the browser to get there.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFailure, listModelTargets, modelTargetId, probeModel, providerDetail, PROBE_PROMPT } from "../lib/modelHealth";

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

/** Runs `fn` with the given keys present, then puts the environment back. */
async function withKeys(keys: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(keys)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The suite is sequential: the environment is mutated per test, and several
// checks depend on the previous one having put the keys back.
async function main(): Promise<void> {
console.log("\nthe model list the panel receives");

await test("every configured model gets its own row", async () => {
  await withKeys({ GEMINI_API_KEY: "test-key", OPENROUTER_API_KEY: "test-key", GROQ_API_KEY: undefined, OPENMI_HF_SPACE: "off" }, () => {
    const targets = listModelTargets();
    const names = targets.map((target) => target.name);
    assert.deepEqual(names, ["Openmi Auto", "Openmi V3", "Openmi V2", "Openmi V1"]);
  });
});

await test("the Groq model is listed by its product name", async () => {
  await withKeys({ GEMINI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, GROQ_API_KEY: "test-key", OPENMI_HF_SPACE: "off" }, () => {
    const targets = listModelTargets();
    assert.equal(targets.length, 1, "the Groq row is missing from the panel");
    const names = targets.map((target) => target.name);
    assert.equal(new Set(names).size, names.length, `two rows share a name: ${names.join(", ")}`);
    assert.equal(names[0], "Groq", "the Groq row does not carry its product name");
  });
});

await test("the list carries the Groq product name and not the wire model", async () => {
  await withKeys({ GEMINI_API_KEY: "test-key", OPENROUTER_API_KEY: "test-key", GROQ_API_KEY: "test-key" }, () => {
    const serialised = JSON.stringify(listModelTargets());
    for (const word of ["gemini", "openrouter", "https", "api_key"] as const) {
      assert.ok(
        !serialised.toLowerCase().includes(word),
        `the model list sent to the browser contains "${word}"`
      );
    }
    assert.ok(
      serialised.toLowerCase().includes("groq"),
      "the Groq product name is the one sanctioned place that word appears"
    );
    assert.ok(
      !serialised.toLowerCase().includes("gpt-oss"),
      "the wire model id stays out of the list even though the product name mentions the vendor"
    );
  });
});

await test("the id is stable and says nothing about the model", () => {
  const model = "gemini-3.8-flash";
  assert.equal(modelTargetId(model), modelTargetId(model), "the id changes between reads, so saved results drift");
  assert.notEqual(modelTargetId(model), modelTargetId("gemini-3.7-flash"), "two models share an id");
  assert.ok(!modelTargetId(model).includes("gemini"), "the id spells out the model it hides");
  assert.match(modelTargetId(model), /^[0-9a-f]{12}$/);
});

console.log("\nthe check itself");

await test("a check asks the model it was pointed at, not a fallback chain", () => {
  const health = read("lib/modelHealth.ts");
  assert.match(
    health,
    /getProviders\(mode\)\.find\(\(provider\) => modelTargetId\(provider\.model\) === id\)/,
    "the probe cannot tell which provider a row refers to"
  );
  // A broken model should still show up, not be silently skipped. The probe
  // talks to the one provider it resolved, not the next one that answers.
  assert.match(
    health,
    /await fetch\(provider\.url/,
    "the check does not call the provider it resolved"
  );
  assert.match(
    health,
    /const match = getProviders\(mode\)\.find\(/,
    "the check resolves more than one provider"
  );
});

await test("the probe is a real, bounded, vendor-scrubbed request", () => {
  const health = read("lib/modelHealth.ts");
  assert.match(health, /AbortSignal\.timeout\(PROBE_TIMEOUT_MS\)/, "a hanging model would never be reported");
  assert.match(health, /max_tokens/, "the reply is uncapped, so one check can be expensive");
  assert.match(health, /content: PROBE_PROMPT/, "the model is not asked for a comparable answer");
  // A cap tight enough to be consumed by a reasoning model makes healthy models
  // return nothing and look broken, which is the opposite of a health check.
  assert.ok(
    !/max_tokens:\s*64/.test(health),
    "the output cap is small enough that a thinking model returns an empty answer"
  );
});

console.log("\nwhat a failure says");

await test("a provider error is one sentence, not a machine dump", () => {
  const message = describeFailure(
    429,
    JSON.stringify({
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits",
      },
    })
  );
  assert.equal(message, "Rate limited or out of quota. You exceeded your current quota, please check your plan and billing details.");
  assert.ok(!message.includes("https://"), "a documentation URL is left in the status line");
  assert.ok(!message.includes("{"), "raw JSON reaches the panel");
  assert.ok(message.length < 200, `the failure line is ${message.length} characters long`);
});

await test("a status an administrator cannot act on is still named", () => {
  // This is the check doing its job: a model id the provider no longer serves.
  // The product no longer hides vendor names from its own administrator, so the
  // detail survives — as one clean sentence, not as JSON.
  assert.equal(
    describeFailure(404, JSON.stringify({ error: { message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it." } })),
    "The provider no longer offers this model. The model llama-3.3-70b-versatile does not exist or you do not have access to it."
  );
  assert.equal(describeFailure(402, ""), "The account is out of credit. (HTTP 402)");
  assert.equal(describeFailure(503, ""), "The model has no capacity right now. (HTTP 503)");
  assert.equal(describeFailure(418, ""), "The request failed. (HTTP 418)");
});

await test("a machine dump is reduced to one sentence", () => {
  // JSON, backticks and documentation URLs make a status line unreadable. The
  // sentence itself is kept: an administrator needs to know which model the
  // provider has stopped serving.
  assert.equal(
    providerDetail(JSON.stringify({ error: { message: "The model `gpt-oss-120b` does not exist." } })),
    "The model gpt-oss-120b does not exist"
  );
  assert.equal(
    providerDetail("fetch failed: getaddrinfo ENOTFOUND api.example.com"),
    "fetch failed: getaddrinfo ENOTFOUND api.example.com"
  );
  assert.equal(providerDetail(""), "");
});

await test("an unreachable model is reported, not thrown", async () => {
  await withKeys({ GEMINI_API_KEY: "test-key", OPENROUTER_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    const target = listModelTargets()[0]!;
    // The key is not a real credential, so this cannot succeed. The point is
    // that it comes back as a result an administrator can read.
    const result = await probeModel(target.id);
    assert.equal(result.ok, false, "a check with no usable key reported itself online");
    assert.ok(result.error.length > 0, "a failed check says nothing about why");
    assert.equal(result.reply, "");
  });
});

await test("an id that is not one of ours is refused without a request", async () => {
  await withKeys({ GEMINI_API_KEY: "test-key", OPENROUTER_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
    const result = await probeModel("not-a-model");
    assert.equal(result.ok, false);
    assert.match(result.error, /not configured/);
  });
});

console.log("\nonly the administrator can run a check");

await test("both admin model operations go through the administrator gate", () => {
  const route = read("app/api/admin/models/route.ts");
  const gates = route.match(/requireAdmin\(req\.headers\)/g) ?? [];
  assert.equal(gates.length, 2, "listing and checking must each be gated");
  assert.ok(!/isAdmin|verifyCaller/.test(route), "the route decides who is the administrator on its own");
});

await test("a check costs provider quota, so it is rate limited separately", () => {
  const route = read("app/api/admin/models/route.ts");
  assert.match(route, /PROBE_MIN_INTERVAL_MS/, "an unlimited button drains the deployment's quota");
  // The route has its own burst scope since the rate-limit policy landed. The
  // point of this check is unchanged: a model check must not spend the chat
  // allowance, or testing models could lock the administrator out of chatting.
  assert.match(route, /checkRateLimit\(req, null, "models"\)/, "the console has no burst limit of its own");
  assert.ok(!/consumeUsage|identityGate/.test(route), "a model check is counted as a chat message");
  assert.ok(!/checkRateLimit\([^)]*"chat"/.test(route), "a model check spends the chat bucket");
});

await test("only a hash can be sent as a model id", () => {
  const route = read("app/api/admin/models/route.ts");
  assert.match(
    route,
    /\^\[0-9a-f\]\{6,64\}\$/,
    "the id is not shape-checked, so a caller could aim a request at anything"
  );
});

console.log("\nwhat the administrator sees");

await test("every model has its own button and its own answer", () => {
  const panel = read("components/ModelHealth.tsx");
  assert.match(panel, /models\.map\(/, "the panel does not render a row per model");
  assert.match(panel, /onTest/, "a row has no button of its own");
  assert.match(panel, /Online/, "a successful check is not shown as online");
  assert.match(panel, /Offline/, "a failed check is not shown as offline");
  assert.match(panel, /\{result\.reply\}/, "the model's own words are not shown, so the check cannot be verified");
  assert.match(panel, /runCheck\(model\)/, "the button does not test the model on its own row");
});

await test("the panel is part of the admin console", () => {
  const admin = read("components/AdminPanel.tsx");
  assert.match(admin, /ModelHealthSection/, "the health section is not mounted in the console");
});

await test("no provider name reaches the panel", () => {
  const panel = read("components/ModelHealth.tsx");
  for (const word of ["gemini", "openrouter", "groq", "gpt-", "llama"]) {
    assert.ok(!panel.toLowerCase().includes(word), `components/ModelHealth.tsx mentions "${word}"`);
  }
});

console.log(
  failures === 0
    ? `\n${passes} passed\n`
    : `\n${passes} passed, ${failures} FAILED\n`
);
}

void main().then(() => {
  process.exit(failures === 0 ? 0 : 1);
});

// ── Openmi — tests for the visitor's account ───────────────────────────────────
//
// The rules pinned here are the ones whose failure is quiet. A guest shown as
// linked keeps a name they never asked to change; a name from the account
// quietly overwriting one just typed on this device is worse; and a bind path
// that could reach the administrator's console would be a hole in the product
// rather than a bug in it.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountExplanation,
  accountHeadline,
  describeAccount,
  describeLinkError,
  greetingName,
  isDismissed,
  NAME_MAX,
  normalizeName,
  resolveName,
} from "../lib/accountState";
import { explainSignInError } from "../lib/authDiagnostics";

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

const GUEST = { configured: true, signedIn: true, isAnonymous: true };

console.log("\naccount state");

test("a deployment with no Supabase project has no account to offer", () => {
  const view = describeAccount({ configured: false, signedIn: false });
  assert.equal(view.status, "unconfigured");
  assert.equal(view.canBind, false);
  assert.equal(view.isLinked, false);
});

test("a deployment that cannot be reached is not the same as one that is absent", () => {
  const view = describeAccount({ configured: true, reachable: false, signedIn: false });
  assert.equal(view.status, "unreachable");
  assert.equal(view.canBind, false);
});

test("an anonymous visitor is a guest who can still bind", () => {
  const view = describeAccount(GUEST);
  assert.equal(view.status, "guest");
  assert.equal(view.canBind, true);
  assert.equal(view.email, null);
});

test("nobody signed in yet is a guest, not an error", () => {
  const view = describeAccount({ configured: true, signedIn: false });
  assert.equal(view.status, "guest");
  assert.equal(view.canBind, true);
});

test("a Google account is linked and cannot be bound twice", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    isAnonymous: false,
    email: "someone@example.com",
    name: "Someone",
  });
  assert.equal(view.status, "linked");
  assert.equal(view.isLinked, true);
  assert.equal(view.canBind, false);
  assert.equal(view.email, "someone@example.com");
  assert.equal(view.name, "Someone");
});

test("a linked account is identified by anonymity, not by having an email", () => {
  // An anonymous account never has an address, and a Google account always does,
  // but the flag is the thing that actually says which kind of account this is.
  const view = describeAccount({
    configured: true,
    signedIn: true,
    isAnonymous: true,
    email: "leftover@example.com",
  });
  assert.equal(view.status, "guest");
  assert.equal(view.isLinked, false);
});

console.log("\nthe name a person is greeted by");

test("a name typed on this device is never replaced", () => {
  assert.equal(resolveName("Rani", "Old Name"), null);
});

test("an empty local name adopts the account's", () => {
  assert.equal(resolveName("", "Rani"), "Rani");
});

test("whitespace is not a name", () => {
  assert.equal(resolveName("   ", "Rani"), "Rani");
});

test("an account with no name adopts nothing", () => {
  assert.equal(resolveName("", null), null);
  assert.equal(resolveName("", "   "), null);
});

test("Google's name is the last resort, never an override", () => {
  // A name the person typed on this device outranks a name they chose for a
  // different site, and the account's own name outranks both. This function only
  // ever fills a gap, so a gap that is not there is left alone.
  assert.equal(greetingName("Rani", "Chosen", "Google Name"), null);
  assert.equal(greetingName("", "Chosen", "Google Name"), "Chosen");
  assert.equal(greetingName("", null, "Google Name"), "Google Name");
  assert.equal(greetingName("", null, null), null);
});

test("names are trimmed, collapsed and capped at the stored limit", () => {
  assert.equal(normalizeName("  Rani   Devi  "), "Rani Devi");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName("a".repeat(200)).length, NAME_MAX);
  assert.equal(NAME_MAX, 40, "the database rules validate the same limit");
});

test("a name over the limit is cut where the rules would cut it", () => {
  // Anything longer is refused by the .validate rule on the profile node, so
  // what is shown has to be what is allowed to be stored.
  const long = normalizeName("b".repeat(60));
  assert.equal(long.length, 40);
});

console.log("\nwhat the settings row says");

test("a guest is told their name is only on this device", () => {
  const view = describeAccount(GUEST);
  assert.match(accountHeadline(view, "Rani"), /this device only/);
  assert.match(accountExplanation(view), /any browser/);
});

test("a linked account shows the address it is linked to", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    isAnonymous: false,
    email: "someone@example.com",
  });
  assert.match(accountHeadline(view, "Rani"), /someone@example\.com/);
  assert.match(accountExplanation(view), /Detaching/);
});

test("an unconfigured deployment explains itself instead of offering a dead button", () => {
  const view = describeAccount({ configured: false, signedIn: false });
  assert.match(accountExplanation(view), /keeps working without it/);
});

test("the settings row never disappears, whatever the account service answers", () => {
  // It used to `return null` for `unconfigured` and `unreachable`, which removed
  // the whole Account section. A person opening Settings then found no account
  // row at all and no reason for its absence — the section had not broken, it had
  // declined to render. The copy for both states existed and was never shown.
  //
  // A state the visitor cannot see is a state they cannot fix, so both must
  // render the row and withhold only the controls that would fail at the click.
  const source = code("components/AccountSection.tsx");
  assert.doesNotMatch(
    source,
    /view\.status === "unconfigured" \|\| view\.status === "unreachable"\)\s*return null/,
    "the account row hides itself when it has something to explain"
  );
  // Both states are still named, so the row knows which explanation to show.
  assert.match(source, /status === "unconfigured"/);
  assert.match(source, /status === "unreachable"/);
  // And the sign-in form is withheld from a state that cannot use it.
  assert.match(source, /canSignIn/, "sign-in is gated on a state that can actually sign in");
});

console.log("\nfailures worth reading");

test("closing the window is not a failure", () => {
  assert.equal(isDismissed({ code: "access_denied" }), true);
  assert.equal(isDismissed(new Error("access_denied: user cancelled")), true);
  assert.equal(isDismissed({ code: "invalid_credentials" }), false);
});

test("a disabled sign-in method is reported as the fixable thing it is", () => {
  assert.match(describeLinkError({ code: "provider_disabled" }), /turn on Google/);
});

test("an account that already exists says so rather than failing cryptically", () => {
  assert.match(describeLinkError({ code: "identity_already_exists" }), /already linked/);
  assert.match(describeLinkError({ code: "email_exists" }), /Sign in instead/);
});

test("a project without anonymous sign-ins says which toggle that is", () => {
  // This build signs every first-time visitor in anonymously, so this one toggle
  // is the difference between a working product and a blank screen.
  assert.match(describeLinkError({ code: "anonymous_provider_disabled" }), /Anonymous sign-ins/);
});

test("an unrecognised failure keeps its own message", () => {
  assert.equal(
    describeLinkError(new Error("something specific")),
    "something specific"
  );
});

test("an email account is a linked account, and says so", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    isAnonymous: false,
    email: "someone@example.com",
    provider: "email",
    emailVerified: false,
  });
  assert.equal(view.status, "linked");
  assert.equal(view.provider, "email");
  assert.equal(view.emailVerified, false, "an unconfirmed address must not read as confirmed");
});

test("a confirmed address is reported as confirmed", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    isAnonymous: false,
    email: "someone@example.com",
    provider: "email",
    emailVerified: true,
  });
  assert.equal(view.emailVerified, true);
});

test("a guest has no provider and no confirmed address to speak of", () => {
  const view = describeAccount(GUEST);
  assert.equal(view.provider, null);
  assert.equal(view.emailVerified, false);
});

test("sign-ups being off is named as the setting it is", () => {
  const restricted = explainSignInError("SIGNUP_DISABLED", false);
  assert.match(restricted.verdict, /refuses new accounts/);
  assert.match(restricted.nextStep, /Allow new users to sign up/);
});

test("a disabled provider is not reported as a disabled project setting", () => {
  const provider = explainSignInError("ANONYMOUS_DISABLED", false);
  assert.match(provider.verdict, /Anonymous/);
  assert.doesNotMatch(provider.nextStep, /Allow new users/);
});

test("a key from another project is named as a mismatch, not as a toggle", () => {
  const mismatch = explainSignInError("INVALID_API_KEY", false);
  assert.match(mismatch.verdict, /two different projects/);
  assert.match(mismatch.nextStep, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});

test("a working project says so instead of sending someone to a toggle", () => {
  const healthy = explainSignInError(null, true);
  assert.match(healthy.verdict, /Account creation is not the problem/);
});

test("an unknown answer keeps the backend's own words", () => {
  assert.match(explainSignInError("SOMETHING_NEW", false).verdict, /SOMETHING_NEW/);
  assert.match(explainSignInError(null, false).verdict, /could not reach Supabase/);
});

test("each email failure names the next step", () => {
  assert.match(describeLinkError({ code: "invalid_credentials" }), /do not match/);
  assert.match(describeLinkError({ code: "email_exists" }), /Sign in instead/);
  assert.match(describeLinkError({ code: "weak_password" }), /six characters/);
  assert.match(describeLinkError({ code: "email_address_invalid" }), /not a valid email/);
  assert.match(describeLinkError({ code: "user_not_found" }), /Create one instead/);
});

console.log("\nthe account is not the administrator");

/**
 * Source with its comments removed.
 *
 * The separation being asserted here is a property of the code, not of the prose
 * around it: `lib/account.ts` explains at length why it stays away from the
 * console, and a test that matched those sentences would fail on the explanation
 * rather than on the behaviour. Stripping comments is what makes "does not import
 * the admin module" and "does not write the admin's node" the assertions they
 * look like.
 */
function code(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

test("nothing in the account path can read or write the admin's data", () => {
  // The binding code must stay away from the console entirely. Elevation is
  // decided by the policies in supabase/migrations naming one address, so a bind
  // path that so much as read that table would be a second, client-side
  // definition of who the administrator is.
  const source = code("lib/account.ts");
  assert.ok(
    !/cloudAdmin|verifyAdminAccess|signInAsAdmin|app_admin|is_admin/.test(source),
    "lib/account.ts reaches into the administrator's namespace"
  );
});

test("the bind path grants access by identity, never by a flag it sets", () => {
  const source = code("lib/account.ts");
  // The only things written are the caller's own name and the chat log the
  // existing sync already writes. No client-side copy of the admin address, and
  // no way to mark an account as elevated.
  assert.ok(!/ADMIN_EMAIL|isAdmin|elevat/i.test(source), "lib/account.ts decides who is an admin");
  assert.ok(!/set\(ref\([^)]*config/.test(source), "lib/account.ts writes server config");
});

test("binding goes through linking, which is what keeps the chats where they are", () => {
  // Signing in with a new account would silently orphan everything already
  // logged under the anonymous id. What makes the upgrade safe is not that
  // `linkIdentity` appears in the file — it is that it is used *instead of* a
  // fresh sign-in, on the account already in use, because attaching a credential
  // to that account is what leaves the uid alone.
  const source = code("lib/account.ts");
  assert.match(source, /isAnonymousUser\(existing\)/, "the guest path is not distinguished");
  assert.match(source, /linkIdentity\(/, "the guest path no longer links in place");

  const linkAt = source.indexOf("linkIdentity(");
  const signInAt = source.indexOf("signInWithOAuth(");
  assert.ok(linkAt > 0, "the in-place link disappeared");
  assert.ok(signInAt > linkAt, "a fresh sign-in is only reached after the link is refused");
});

test("the visitor's profile is not the console's visitor list", () => {
  // Two different tables on purpose. The console reads `visitor_registry`, which
  // a visitor may write but never read; a name that has to follow someone to
  // another browser needs a row they *can* read, and reusing the console's would
  // mean loosening a policy the console depends on.
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261023000100_identity.sql"),
    "utf8"
  );
  assert.match(
    sql,
    /create policy profiles_owner on public\.profiles\s+for all to authenticated\s+using \(id = auth\.uid\(\)\)/,
    "the profile is readable only by the person it belongs to"
  );
  assert.ok(
    !/for select to authenticated\s+using \(owner = auth\.uid\(\)\)/.test(
      sql.split("visitor_registry")[1]?.split("push_subscriptions")[0] ?? ""
    ),
    "the console's visitor list must stay unreadable to visitors"
  );
});

console.log(
  failures === 0
    ? `\n${passes} passed\n`
    : `\n${passes} passed, ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);

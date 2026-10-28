// ── Openmi — tests for the account ──────────────────────────────────────────
//
// The rules pinned here are the ones whose failure is quiet. A signed-out browser
// must be shown the sign-in screen rather than a half-working product; a name
// typed on this device must not be silently replaced by one from an account; and
// an anonymous identity must not creep back into the auth path.
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
  describeLinkReturn,
  greetingName,
  isDismissed,
  linkableProviders,
  NAME_MAX,
  normalizeName,
  providerLabel,
  resolveName,
  signInMethodLabel,
} from "../lib/accountState";
import { explainSignInError } from "../lib/authDiagnostics";
import { passwordProblem, recoveryRedirectUrl, RECOVERY_PATH } from "../lib/passwordRecovery";

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

/**
 * Source with its comments removed.
 *
 * The separation being asserted is a property of the code, not of the prose
 * around it: the auth modules explain at length why there is no anonymous door,
 * and a test that matched those sentences would fail on the explanation rather
 * than on the behaviour.
 */
function code(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

console.log("\naccount state");

test("a deployment with no Supabase project has no account service", () => {
  const view = describeAccount({ configured: false, signedIn: false });
  assert.equal(view.status, "unconfigured");
  assert.equal(view.signedIn, false);
  assert.equal(view.id, null);
});

test("a deployment that cannot be reached is not the same as one that is absent", () => {
  const view = describeAccount({ configured: true, reachable: false, signedIn: false });
  assert.equal(view.status, "unreachable");
  assert.equal(view.signedIn, false);
});

test("nobody signed in is signed out, not a guest with a hidden account", () => {
  const view = describeAccount({ configured: true, signedIn: false });
  assert.equal(view.status, "signed-out");
  assert.equal(view.signedIn, false);
  assert.equal(view.email, null);
  assert.equal(view.provider, null);
});

test("a real account is signed in and identifies its provider", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    id: "uid-1",
    email: "someone@example.com",
    name: "Someone",
    provider: "google",
  });
  assert.equal(view.status, "signed-in");
  assert.equal(view.signedIn, true);
  assert.equal(view.id, "uid-1");
  assert.equal(view.provider, "google");
  assert.equal(view.email, "someone@example.com");
  assert.equal(view.emailVerified, true, "an OAuth address is confirmed by the provider");
});

test("Microsoft is the product word for Supabase's azure provider", () => {
  assert.equal(providerLabel("microsoft"), "Microsoft");
  assert.equal(providerLabel("github"), "GitHub");
  assert.equal(providerLabel("email"), "email and password");
  assert.equal(providerLabel(null), "an account");
});

test("an unconfirmed email account must not read as confirmed", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    id: "uid-2",
    email: "someone@example.com",
    provider: "email",
    emailVerified: false,
  });
  assert.equal(view.status, "signed-in");
  assert.equal(view.emailVerified, false);
});

test("a confirmed email account is reported as confirmed", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    id: "uid-3",
    email: "someone@example.com",
    provider: "email",
    emailVerified: true,
  });
  assert.equal(view.emailVerified, true);
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

test("the provider's name is the last resort, never an override", () => {
  assert.equal(greetingName("Rani", "Chosen", "Provider Name"), null);
  assert.equal(greetingName("", "Chosen", "Provider Name"), "Chosen");
  assert.equal(greetingName("", null, "Provider Name"), "Provider Name");
  assert.equal(greetingName("", null, null), null);
});

test("names are trimmed, collapsed and capped at the stored limit", () => {
  assert.equal(normalizeName("  Rani   Devi  "), "Rani Devi");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName("a".repeat(200)).length, NAME_MAX);
  assert.equal(NAME_MAX, 40, "the database rules validate the same limit");
});

console.log("\nwhat the settings row says");

test("a signed-out browser is told to sign in, not offered a guest mode", () => {
  const view = describeAccount({ configured: true, signedIn: false });
  assert.equal(accountHeadline(view, "Rani"), "Not signed in");
  assert.match(accountExplanation(view), /Google, GitHub, Microsoft or email/);
  assert.doesNotMatch(accountExplanation(view), /without an account|guest|anonymous/i);
});

test("a signed-in account shows its address and its provider", () => {
  const view = describeAccount({
    configured: true,
    signedIn: true,
    id: "uid-1",
    email: "someone@example.com",
    provider: "github",
  });
  assert.match(accountHeadline(view, "Rani"), /someone@example\.com/);
  assert.match(accountExplanation(view), /GitHub/);
  assert.match(accountExplanation(view), /any browser/);
});

test("an unconfigured deployment explains itself instead of offering a dead button", () => {
  const view = describeAccount({ configured: false, signedIn: false });
  assert.match(accountExplanation(view), /account service/);
});

test("the settings row renders the states it cannot sign in from", () => {
  // It used to `return null` for `unconfigured` and `unreachable`, which removed
  // the whole Account section and left no reason for its absence. A state the
  // person cannot see is a state they cannot fix.
  const source = code("components/AccountSection.tsx");
  assert.match(source, /status === "unconfigured"/);
  assert.match(source, /status === "unreachable"/);
  assert.match(source, /signOutAccount/);
});

console.log("\nfailures worth reading");

test("closing the window is not a failure", () => {
  assert.equal(isDismissed({ code: "access_denied" }), true);
  assert.equal(isDismissed(new Error("access_denied: user cancelled")), true);
  assert.equal(isDismissed({ code: "invalid_credentials" }), false);
});

test("a disabled sign-in method is reported as the fixable thing it is", () => {
  assert.match(describeLinkError({ code: "provider_disabled" }), /Sign In \/ Providers/);
});

test("an account that already exists says so rather than failing cryptically", () => {
  assert.match(describeLinkError({ code: "identity_already_exists" }), /already linked/);
  assert.match(describeLinkError({ code: "email_exists" }), /Sign in instead/);
});

console.log("\none account, several sign-in methods");

test("each sign-in method is named the way the sign-in screen names it", () => {
  assert.equal(signInMethodLabel("google"), "Google");
  assert.equal(signInMethodLabel("github"), "GitHub");
  assert.equal(signInMethodLabel("azure"), "Microsoft");
  assert.equal(signInMethodLabel("email"), "Email and password");
  assert.equal(signInMethodLabel("saml"), "saml", "an unknown provider keeps its own id");
});

test("only the doors that are not attached are offered", () => {
  assert.deepEqual(linkableProviders([]), ["google", "github", "microsoft"]);
  assert.deepEqual(linkableProviders(["google", "azure"]), ["github"], "Microsoft is azure in Supabase");
  assert.deepEqual(linkableProviders(["google", "github", "azure"]), []);
});

test("a provider that belongs to another account is named as that, with the way out", () => {
  const message = describeLinkReturn("google", "Identity is already linked to another user.");
  assert.match(message, /different Openmi account/);
  assert.match(message, /unlink it in Settings/);
  assert.match(message, /does not merge/);
});

test("manual linking switched off is reported as the dashboard setting it is", () => {
  assert.match(describeLinkReturn("github", "Manual linking is disabled"), /manual linking/);
});

test("an unrecognised linking refusal keeps the provider's own words", () => {
  assert.equal(describeLinkReturn("github", "boom"), "Could not link GitHub: boom");
});

test("removing the last way into an account is refused with a next step", () => {
  assert.match(describeLinkError({ code: "single_identity_not_deletable" }), /Attach another method/);
  assert.match(describeLinkError({ code: "email_conflict_identity_not_deletable" }), /another account/);
  assert.match(describeLinkError({ code: "identity_not_found" }), /no longer attached/);
});

test("the account screen binds and unbinds through Supabase's identity API", () => {
  const account = code("lib/account.ts");
  assert.match(account, /getUserIdentities/);
  assert.match(account, /linkIdentity/);
  assert.match(account, /unlinkIdentity/);
  const section = code("components/AccountSection.tsx");
  assert.match(section, /Sign-in methods/);
  assert.match(section, /linkSignInMethod/);
  assert.match(section, /unlinkSignInMethod/);
});

test("anonymous-only advice is gone", () => {
  // The old build told people to enable the Anonymous provider. There is no
  // anonymous door any more, so that error must fall through to Supabase's own
  // words rather than send someone to a toggle that no longer matters.
  assert.doesNotMatch(
    describeLinkError({ code: "anonymous_provider_disabled" }),
    /Anonymous sign-ins/
  );
});

test("an unrecognised failure keeps its own message", () => {
  assert.equal(describeLinkError(new Error("something specific")), "something specific");
});

console.log("\nthe sign-in diagnosis");

test("a working project names the methods it actually has", () => {
  const healthy = explainSignInError(null, true, {
    google: true,
    github: true,
    microsoft: false,
    email: true,
  });
  assert.match(healthy.verdict, /Google, GitHub and email and password/);
  assert.match(healthy.nextStep, /method you picked/);
});

test("a project with no doors open is named as that", () => {
  const closed = explainSignInError("NO_PROVIDERS", false);
  assert.match(closed.verdict, /None of the four sign-in methods/);
  assert.match(closed.nextStep, /Sign In \/ Providers/);
});

test("sign-ups being off is named as the setting it is", () => {
  const restricted = explainSignInError("SIGNUP_DISABLED", false);
  assert.match(restricted.verdict, /refuses new accounts/);
  assert.match(restricted.nextStep, /Allow new users to sign up/);
});

test("a key from another project is named as a mismatch, not as a toggle", () => {
  const mismatch = explainSignInError("INVALID_API_KEY", false);
  assert.match(mismatch.verdict, /two different projects/);
  assert.match(mismatch.nextStep, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
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

console.log("\nthe auth path has no anonymous door and the four providers are wired");

test("no auth module mints an anonymous identity", () => {
  const sources = ["lib/supabase.ts", "lib/account.ts", "lib/emailAuth.ts"]
    .map(code)
    .join("\n");
  assert.doesNotMatch(sources, /signInAnonymously/);
  assert.doesNotMatch(sources, /is_anonymous/);
  assert.doesNotMatch(sources, /isAnonymousUser/);
  assert.doesNotMatch(sources, /updateUser\(\{\s*email/);
});

test("Google, GitHub and Microsoft all go through Supabase OAuth", () => {
  const source = code("lib/account.ts");
  assert.match(source, /google/);
  assert.match(source, /github/);
  assert.match(source, /azure/);
  assert.match(source, /signInWithOAuth/);
  assert.match(source, /consumeOAuthError/);
});

test("email registration is a real sign-up, not an upgrade of a hidden guest", () => {
  const source = code("lib/emailAuth.ts");
  assert.match(source, /signUp\(/);
  assert.match(source, /signInWithPassword\(/);
  assert.doesNotMatch(source, /signUpToGuest|signOutToGuest/);
});

test("the main page gates the product on a signed-in account", () => {
  const source = code("app/chat/page.tsx");
  assert.match(source, /watchAccount/);
  assert.match(source, /if \(!account\.signedIn\)/);
  assert.match(source, /AuthScreen/);
});

test("nothing in the account path can read or write the admin's data", () => {
  const source = code("lib/account.ts");
  assert.ok(
    !/cloudAdmin|verifyAdminAccess|signInAsAdmin|app_admin|is_admin/.test(source),
    "lib/account.ts reaches into the administrator's namespace"
  );
});

test("the visitor's profile is not the console's visitor list", () => {
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
      sql.split("visitor_registry")[1]?.split("profiles")[0] ?? ""
    ),
    "the console's visitor list must stay unreadable to visitors"
  );
});

test("preferences are owner-scoped in the database", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261024000000_user_preferences.sql"),
    "utf8"
  );
  assert.match(sql, /create table if not exists public\.user_preferences/);
  assert.match(sql, /owner uuid primary key default auth\.uid\(\)/);
  assert.match(sql, /alter table public\.user_preferences enable row level security/);
  assert.match(
    sql,
    /create policy user_preferences_owner on public\.user_preferences\s+for all to authenticated\s+using \(owner = auth\.uid\(\)\)\s+with check \(owner = auth\.uid\(\)\)/
  );
});

console.log("\nthe password recovery flow");

test("a recovery link returns to its own screen, not to the product", () => {
  assert.equal(RECOVERY_PATH, "/auth/reset-password");
  assert.equal(recoveryRedirectUrl("https://example.com"), "https://example.com/auth/reset-password");
  assert.equal(
    recoveryRedirectUrl("https://example.com/"),
    "https://example.com/auth/reset-password",
    "a trailing slash must not produce a double slash"
  );
});

test("a new password must be long enough and typed twice", () => {
  assert.match(passwordProblem("abc", "abc") ?? "", /six characters/);
  assert.match(passwordProblem("abcdef", "abcdeg") ?? "", /do not match/);
  assert.equal(passwordProblem("abcdef", "abcdef"), null);
});

test("the reset mail and the recovery screen are wired to each other", () => {
  // Redirecting to the product would sign the person in and leave the old
  // password working, which is the halfway state the screen exists to remove.
  const mail = code("lib/emailAuth.ts");
  assert.match(mail, /recoveryRedirectUrl/);
  assert.doesNotMatch(
    mail.slice(mail.indexOf("requestPasswordReset"), mail.indexOf("changePassword")),
    /redirectTo: returnUrl\(\)/,
    "the reset mail still returns to the bare origin"
  );

  const page = readFileSync(
    join(process.cwd(), "app/auth/reset-password/page.tsx"),
    "utf8"
  );
  assert.match(page, /PasswordRecoveryScreen/);

  const screen = code("components/PasswordRecoveryScreen.tsx");
  assert.match(screen, /changePassword/);
  assert.match(screen, /status === "expired"/);
  assert.match(screen, /Continue to Openmi/);
});

console.log(
  failures === 0
    ? `\n${passes} passed\n`
    : `\n${passes} passed, ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);

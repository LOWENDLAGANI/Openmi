import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISPOSABLE_EMAIL_DOMAINS,
  checkSignupEmail,
  emailDomain,
  isDisposableEmail,
} from "../lib/emailGuard";

// ── A temporary address cannot create an account ─────────────────────────────

assert.equal(isDisposableEmail("person@mailinator.com"), true);
assert.equal(isDisposableEmail("PERSON@MAILINATOR.COM"), true, "the check is case-insensitive");
assert.equal(isDisposableEmail("  person@yopmail.com  "), true, "surrounding space is ignored");
assert.equal(isDisposableEmail("person+tag@trashmail.de"), true, "a plus-alias does not launder the domain");
assert.equal(isDisposableEmail("person@inbox.mailinator.com"), true, "subdomains of a temp service are temp");
assert.equal(isDisposableEmail("person@deep.inbox.mailinator.com"), true);

assert.equal(isDisposableEmail("person@gmail.com"), false);
assert.equal(isDisposableEmail("person@fastmail.com"), false);
assert.equal(isDisposableEmail("person@example.com"), false);
assert.equal(isDisposableEmail("person@eng.example.com"), false, "a subdomain of a real domain is not a temp one");
assert.equal(isDisposableEmail(""), false, "an empty value is not a disposable address");

// ── Domain parsing ───────────────────────────────────────────────────────────

assert.equal(emailDomain(" Person@Example.COM. "), "example.com");
assert.equal(emailDomain("person"), null);
assert.equal(emailDomain("person@"), null);
assert.equal(emailDomain("@example.com"), null);
assert.equal(emailDomain("person@example"), null);
assert.equal(emailDomain("person@exa mple.com"), null);

// ── The verdict the form acts on ─────────────────────────────────────────────

const valid = checkSignupEmail("person@example.com");
assert.equal(valid.ok, true);
assert.equal(valid.message, null);
assert.equal(valid.domain, "example.com");

const temporary = checkSignupEmail("person@mailinator.com");
assert.equal(temporary.ok, false);
assert.equal(temporary.domain, "mailinator.com");
assert.ok(
  temporary.message && /temporary/i.test(temporary.message),
  "the refusal says the address is temporary, not that it is invalid"
);

const broken = checkSignupEmail("person@");
assert.equal(broken.ok, false);
assert.ok(broken.message, "a malformed address gets its own sentence");

// The list itself has to stay honest: long enough to matter, lowercase, unique.
assert.ok(DISPOSABLE_EMAIL_DOMAINS.length >= 60, "the block list is large enough to be useful");
assert.equal(
  new Set(DISPOSABLE_EMAIL_DOMAINS).size,
  DISPOSABLE_EMAIL_DOMAINS.length,
  "no duplicate domains"
);
assert.ok(
  DISPOSABLE_EMAIL_DOMAINS.every((domain) => domain === domain.toLowerCase()),
  "domains are stored lowercase"
);

// ── The database enforces the same list ──────────────────────────────────────
// The form is the sentence; the trigger is the rule. These read the migration
// so deleting the enforcement cannot pass unnoticed.

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261028000400_email_guard.sql"),
  "utf8"
);

const seeds = [...migration.matchAll(/\('([a-z0-9.-]+)'\)/g)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  seeds,
  [...DISPOSABLE_EMAIL_DOMAINS].sort(),
  "the SQL seed and the app list must be the same list, or one of them blocks what the other allows"
);

assert.match(
  migration,
  /before insert or update of email on auth\.users/,
  "the trigger must run on sign-up and on an address change"
);
assert.match(migration, /execute function public\.reject_disposable_signup\(\)/);
assert.match(migration, /raise exception/);
assert.match(
  migration,
  /alter table public\.blocked_email_domains enable row level security/
);
assert.match(
  migration,
  /revoke all on public\.blocked_email_domains from anon, authenticated/,
  "the list is readable only by the definer function, not by the API roles"
);
assert.match(migration, /security definer/, "the check needs to read a table the caller cannot");

// ── The form asks before it creates anything ─────────────────────────────────

const form = readFileSync(join(process.cwd(), "components/EmailAuthForm.tsx"), "utf8");
assert.match(form, /checkSignupEmail\(email\)/, "the form checks the address before creating the account");
assert.match(form, /mode === "register"[\s\S]{0,400}checkSignupEmail\(email\)/, "and only on the create-account path");

console.log("email guard: all checks passed");

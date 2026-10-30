// ── Disposable email addresses ───────────────────────────────────────────────
//
// A throwaway mailbox stops existing minutes after it is made. An account bound
// to one can never receive a password reset, so the chats, folders and Dew
// inside it are stranded and the person cannot get back in. Creating an account
// with such an address is therefore refused.
//
// Signing *in* with an existing account on one of these domains is deliberately
// untouched: this rule is about making an account, not about locking out anyone
// who already has one.
//
// The list is mirrored in `supabase/migrations/20261028000400_email_guard.sql`,
// where a trigger on `auth.users` enforces it even for a client that never loads
// this file. `tests/email-guard.test.ts` reads both and fails if they drift, so
// a domain added here is a domain blocked in the database.
//
// Matching is suffix-based: `mailinator.com` blocks `inbox.mailinator.com` too,
// because a temp service hands out subdomains freely. A plus-alias on a temp
// domain is still a temp address, so `person+tag@…` is caught as well.

export const DISPOSABLE_EMAIL_DOMAINS = [
  "0-mail.com",
  "10minutemail.com",
  "10minutemail.net",
  "1secmail.cc",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "1secmail.xyz",
  "20minutemail.com",
  "33mail.com",
  "burnermail.io",
  "discard.email",
  "discardmail.com",
  "discardmail.de",
  "dispostable.com",
  "email-temp.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "inboxkitten.com",
  "jetable.com",
  "jetable.fr.nf",
  "jetable.net",
  "jetable.org",
  "mail.gw",
  "mail.tm",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailinator.org",
  "mailinator2.com",
  "mailnesia.com",
  "mailmetrash.com",
  "mintemail.com",
  "mohmal.com",
  "mt2009.com",
  "mytrashmail.com",
  "nada.email",
  "one-time.email",
  "onetimeemail.net",
  "sharklasers.com",
  "sogetthis.com",
  "spam.la",
  "spam4.me",
  "spamavert.com",
  "spamdecoy.net",
  "spamex.com",
  "spamfree24.de",
  "spamfree24.eu",
  "spamfree24.info",
  "spamfree24.net",
  "spamfree24.org",
  "spamgourmet.com",
  "spamgourmet.net",
  "spamgourmet.org",
  "spamherelots.com",
  "spamify.com",
  "spammotel.com",
  "spamspot.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempemail.co",
  "tempemail.com",
  "tempemail.net",
  "tempemail.org",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.net",
  "tempmail.org",
  "tempmailo.com",
  "tempomail.fr",
  "tempr.email",
  "temporary-mail.net",
  "temporaryemail.net",
  "thankyou2010.com",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "trashmail.org",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
] as const;

const BLOCKED = new Set<string>(DISPOSABLE_EMAIL_DOMAINS);

/** The sentence the form shows. One sentence, and the two ways forward. */
export const DISPOSABLE_EMAIL_MESSAGE =
  "That address is from a temporary email service. Create the account with an address you keep, or sign in with Google or GitHub.";

/**
 * The domain of an address, lowercased and without a trailing dot, or null when
 * the address is not a complete one. This is a shape check, not a delivery
 * check: nothing here claims the mailbox exists.
 */
export function emailDomain(value: string): string | null {
  const cleaned = value.trim().toLowerCase();
  if (!cleaned || cleaned.length > 254) return null;
  if (/\s/.test(cleaned)) return null;
  const at = cleaned.lastIndexOf("@");
  if (at <= 0 || at === cleaned.length - 1) return null;
  const domain = cleaned.slice(at + 1).replace(/\.+$/, "");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) return null;
  return domain;
}

/** True when this address belongs to a service on the block list. */
export function isDisposableEmail(value: string): boolean {
  const domain = emailDomain(value);
  if (!domain) return false;
  const labels = domain.split(".");
  // Every suffix is checked, so `mailinator.com` covers `inbox.mailinator.com`
  // without a separate entry per subdomain.
  for (let index = 0; index < labels.length; index += 1) {
    if (BLOCKED.has(labels.slice(index).join("."))) return true;
  }
  return false;
}

export interface SignupEmailCheck {
  ok: boolean;
  /** The parsed domain, when there was one. */
  domain: string | null;
  /** The sentence to show, when the address cannot be used. */
  message: string | null;
}

/**
 * The one check the sign-up form asks before it creates an account.
 *
 * A missing or malformed address is refused with its own sentence so the form
 * does not blame a temporary provider for a typo. The database deliberately
 * checks only the domain: by the time a row reaches `auth.users`, Supabase has
 * already validated the address's shape.
 */
export function checkSignupEmail(value: string): SignupEmailCheck {
  const domain = emailDomain(value);
  if (!domain) {
    return {
      ok: false,
      domain: null,
      message: "Enter a complete email address, like you@example.com.",
    };
  }
  if (isDisposableEmail(value)) {
    return { ok: false, domain, message: DISPOSABLE_EMAIL_MESSAGE };
  }
  return { ok: true, domain, message: null };
}

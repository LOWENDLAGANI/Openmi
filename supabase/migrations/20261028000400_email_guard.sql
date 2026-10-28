-- ── Disposable email addresses cannot create an account ─────────────────────
--
-- A throwaway mailbox stops existing minutes after it is made. An account bound
-- to one can never receive a password reset, so the chats, folders and Dew
-- inside it are stranded and the person cannot get back in. Creating an account
-- with such an address is refused.
--
-- Signing *in* with an existing account on one of these domains is deliberately
-- untouched. This rule is about making an account, not about locking out anyone
-- who already has one.
--
-- The list is mirrored in `lib/emailGuard.ts`, which the sign-up form checks
-- first so the person gets an instant sentence. This file is the enforcement:
-- `signUp` runs in the browser, so a modified client can skip the form — but it
-- cannot skip a trigger on `auth.users`. Add a domain in both places;
-- `tests/email-guard.test.ts` reads this file and fails if the two lists differ.
--
-- Safe to run more than once: the table is `if not exists`, the seed conflicts
-- quietly, and the trigger is replaced rather than duplicated.

create table if not exists public.blocked_email_domains (
  domain text primary key
    check (domain = lower(domain) and length(domain) between 3 and 255)
);

-- Nobody signed in needs to read this list; the check runs inside a definer
-- function. No policies are added, so RLS denies everything to the API roles.
alter table public.blocked_email_domains enable row level security;
revoke all on public.blocked_email_domains from anon, authenticated;

insert into public.blocked_email_domains (domain) values
  ('0-mail.com'),
  ('10minutemail.com'),
  ('10minutemail.net'),
  ('1secmail.cc'),
  ('1secmail.com'),
  ('1secmail.net'),
  ('1secmail.org'),
  ('1secmail.xyz'),
  ('20minutemail.com'),
  ('33mail.com'),
  ('burnermail.io'),
  ('discard.email'),
  ('discardmail.com'),
  ('discardmail.de'),
  ('dispostable.com'),
  ('email-temp.com'),
  ('emailondeck.com'),
  ('fakeinbox.com'),
  ('getnada.com'),
  ('grr.la'),
  ('guerrillamail.biz'),
  ('guerrillamail.com'),
  ('guerrillamail.de'),
  ('guerrillamail.net'),
  ('guerrillamail.org'),
  ('inboxkitten.com'),
  ('jetable.com'),
  ('jetable.fr.nf'),
  ('jetable.net'),
  ('jetable.org'),
  ('mail.gw'),
  ('mail.tm'),
  ('mailcatch.com'),
  ('maildrop.cc'),
  ('mailinator.com'),
  ('mailinator.net'),
  ('mailinator.org'),
  ('mailinator2.com'),
  ('mailnesia.com'),
  ('mailmetrash.com'),
  ('mintemail.com'),
  ('mohmal.com'),
  ('mt2009.com'),
  ('mytrashmail.com'),
  ('nada.email'),
  ('one-time.email'),
  ('onetimeemail.net'),
  ('sharklasers.com'),
  ('sogetthis.com'),
  ('spam.la'),
  ('spam4.me'),
  ('spamavert.com'),
  ('spamdecoy.net'),
  ('spamex.com'),
  ('spamfree24.de'),
  ('spamfree24.eu'),
  ('spamfree24.info'),
  ('spamfree24.net'),
  ('spamfree24.org'),
  ('spamgourmet.com'),
  ('spamgourmet.net'),
  ('spamgourmet.org'),
  ('spamherelots.com'),
  ('spamify.com'),
  ('spammotel.com'),
  ('spamspot.com'),
  ('temp-mail.io'),
  ('temp-mail.org'),
  ('tempail.com'),
  ('tempemail.co'),
  ('tempemail.com'),
  ('tempemail.net'),
  ('tempemail.org'),
  ('tempinbox.com'),
  ('tempmail.com'),
  ('tempmail.net'),
  ('tempmail.org'),
  ('tempmailo.com'),
  ('tempomail.fr'),
  ('tempr.email'),
  ('temporary-mail.net'),
  ('temporaryemail.net'),
  ('thankyou2010.com'),
  ('throwawaymail.com'),
  ('trashmail.com'),
  ('trashmail.de'),
  ('trashmail.net'),
  ('trashmail.org'),
  ('yopmail.com'),
  ('yopmail.fr'),
  ('yopmail.net')
on conflict (domain) do nothing;

/**
 * Whether an address's domain is on the list.
 *
 * Suffix matching is deliberate: temp services hand out subdomains freely, so
 * `mailinator.com` must cover `inbox.mailinator.com`. SECURITY DEFINER so the
 * trigger can read a table the API roles cannot, and STABLE because the answer
 * does not change inside a statement.
 */
create or replace function public.email_domain_is_blocked(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.blocked_email_domains b
    where lower(split_part(btrim(coalesce(p_email, '')), '@', 2)) = b.domain
       or lower(split_part(btrim(coalesce(p_email, '')), '@', 2)) like '%.' || b.domain
  );
$$;

revoke all on function public.email_domain_is_blocked(text) from public;

/**
 * The trigger: refuse the insert that would create such an account.
 *
 * It fires on an address change as well, because moving an existing account onto
 * a throwaway domain has the same result — a mailbox that will not be there when
 * a reset is needed.
 *
 * The function keeps the default EXECUTE grant on purpose: a trigger function
 * cannot be called outside a trigger, and Supabase Auth's own role has to be able
 * to fire it while it inserts the user.
 */
create or replace function public.reject_disposable_signup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email is not null and public.email_domain_is_blocked(new.email) then
    raise exception 'Openmi does not accept disposable email addresses.'
      using errcode = '23514',
            hint = 'Use an address you keep, or sign in with Google or GitHub.';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_disposable_signup on auth.users;
create trigger reject_disposable_signup
  before insert or update of email on auth.users
  for each row
  execute function public.reject_disposable_signup();

-- The setup banner resolves each name through to_regclass / to_regprocedure, so
-- a deployment that skipped this file names it instead of silently allowing the
-- sign-up the owner thinks is blocked.
insert into public.schema_expected (object_name, kind, migration)
values
  ('blocked_email_domains', 'table', '20261028000400_email_guard'),
  ('email_domain_is_blocked(text)', 'function', '20261028000400_email_guard'),
  ('reject_disposable_signup()', 'function', '20261028000400_email_guard')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;

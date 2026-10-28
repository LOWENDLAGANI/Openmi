import type { ReactNode } from "react";
import Link from "next/link";
import MaintenanceGate from "@/components/MaintenanceGate";

// ── Privacy ──────────────────────────────────────────────────────────────────
// A plain, factual page. Two reasons it exists and is public: AdSense requires
// one, and a product that stores conversations and shows ads owes the reader an
// account of both. No marketing copy, no promises the code does not keep.
//
// Every statement below is a description of something the app actually does:
// the tables named in §3 and §8 are the ones in supabase/migrations, the
// thirty-day windows are TRASH_RETENTION_MS and SHARE_TTL_DAYS, the encryption
// is lib/github/crypto.ts, and the erased tables are the list in
// lib/privacy.ts. When one of those changes, this page changes with it.
//
// The theme tokens (text-text-*, border-line) are used rather than the inverted
// white/xx utilities: a legal page is read slowly, in whatever appearance the
// reader chose, and it should not depend on the light-mode overrides to stay
// legible.

/**
 * The operator's contact address.
 *
 * Deliberately a constant rather than a literal in the markup: the repository
 * has no public address anywhere else, so this is the one line to fill in. While
 * it is empty the contact section points at the About page instead of printing
 * a placeholder a reader cannot use.
 */
const CONTACT_EMAIL = "";

export const metadata = {
  title: "Privacy — Openmi",
  description:
    "What Openmi stores, what it sends to a model provider, what Google collects for advertising, how long each thing is kept, and how to delete it.",
};

const EFFECTIVE = "28 October 2026";

const CONTENTS: Array<{ id: string; title: string }> = [
  { id: "who", title: "Who we are" },
  { id: "summary", title: "The short version" },
  { id: "collect", title: "What we collect" },
  { id: "not-collected", title: "What we do not collect" },
  { id: "why", title: "Why we use it" },
  { id: "recipients", title: "Who receives your data" },
  { id: "storage", title: "Cookies and local storage" },
  { id: "ads", title: "Advertising and your choices" },
  { id: "retention", title: "How long we keep it" },
  { id: "security", title: "Security" },
  { id: "transfers", title: "International transfers" },
  { id: "rights", title: "Your rights and controls" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes to this policy" },
  { id: "contact", title: "Contact" },
];

function Section({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-7">
      <h2 className="flex items-baseline gap-2.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-text-hi">
        <span className="font-mono text-[10px] font-normal tracking-[0.08em] text-text-low">
          {number}
        </span>
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-text-body">{children}</div>
    </section>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="pt-1 text-[12.5px] font-semibold text-text-hi">{children}</h3>;
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5 pl-4">
      {items.map((item, index) => (
        <li key={index} className="relative pl-3">
          <span aria-hidden className="absolute left-0 text-text-low">
            ·
          </span>
          {item}
        </li>
      ))}
    </ul>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="-mx-1 overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[520px] border-collapse text-left text-[12.5px]">
        <thead>
          <tr>
            {head.map((cell) => (
              <th
                key={cell}
                scope="col"
                className="whitespace-nowrap border-b border-line bg-card px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-low"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="align-top">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-line px-3 py-2.5 leading-snug text-text-body last:border-r-0"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outbound({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  );
}

export default function PrivacyPage() {
  return (
    <MaintenanceGate>
      <div className="app-surface flex min-h-[100dvh] flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:px-8 sm:py-14">
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 text-[12px] text-text-mid transition-colors hover:text-text-hi"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Back to Openmi
          </Link>

          <header className="mt-7">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-low">
              Legal · Privacy
            </p>
            <h1 className="mt-2.5 text-[30px] font-semibold leading-[1.1] tracking-tight text-text-hi sm:text-[34px]">
              Privacy
            </h1>
            <p className="mt-3 text-[13px] leading-relaxed text-text-mid">
              What this deployment stores, where it is stored, what it sends to a model provider,
              what Google collects to show an ad, and how to get rid of it. Written to describe the
              code rather than to promise more than it does.
            </p>
            <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.1em] text-text-low">
              Effective {EFFECTIVE}
            </p>
          </header>

          <nav aria-label="Contents" className="mt-8 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {CONTENTS.map((entry, index) => (
              <a
                key={entry.id}
                href={`#${entry.id}`}
                className="group flex items-baseline gap-2 text-[12px] text-text-mid transition-colors hover:text-text-hi"
              >
                <span className="font-mono text-[10px] text-text-low">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="underline decoration-transparent underline-offset-2 group-hover:decoration-line-strong">
                  {entry.title}
                </span>
              </a>
            ))}
          </nav>

          <div className="mt-9 space-y-7">
            <Section id="who" number="01" title="Who we are">
              <p>
                Openmi (“Openmi”, “we”, “us”) is an AI assistant with a repository agent, built and
                operated by <span className="font-medium text-text-hi">Minetallest</span>. This
                policy explains what Openmi collects, where it is stored, who it is sent to, how
                long it is kept, and what you can do about it.
              </p>
              <p>
                It applies to this deployment of the Openmi web app, including the chat at{" "}
                <Link href="/chat" className="text-accent underline decoration-accent/30 underline-offset-2">
                  /chat
                </Link>
                , the repository workspace, and the{" "}
                <Link href="/plus" className="text-accent underline decoration-accent/30 underline-offset-2">
                  /plus
                </Link>
                ,{" "}
                <Link href="/activity" className="text-accent underline decoration-accent/30 underline-offset-2">
                  /activity
                </Link>
                ,{" "}
                <Link href="/shares" className="text-accent underline decoration-accent/30 underline-offset-2">
                  /shares
                </Link>{" "}
                and{" "}
                <Link href="/about" className="text-accent underline decoration-accent/30 underline-offset-2">
                  /about
                </Link>{" "}
                pages. It does not apply to GitHub, Google, or any other service you reach from
                Openmi; those have their own policies.
              </p>
            </Section>

            <Section id="summary" number="02" title="The short version">
              <Bullets
                items={[
                  "An account is required. There is no anonymous or guest mode.",
                  "Your conversations are stored in your browser first, then synced to your account so they follow you across devices.",
                  <>
                    <span className="text-text-hi">Temporary chats are never written down</span> —
                    not to the browser database, not to your account.
                  </>,
                  "Your messages are sent to the AI model provider serving the model you chose, so it can answer.",
                  "If you connect GitHub, an access token is stored encrypted and is never shown back to your browser. The agent can read repositories and propose changes; nothing is written to GitHub unless you approve it.",
                  "One small Google AdSense banner appears above the chat composer, except on the sign-in screen, in temporary chats and on the Focus home. If the operator has configured Adsterra, a popunder script may also open an advertisement in a background window. Both use cookies or device identifiers.",
                  "We do not sell your data. There is no analytics product and no advertising identifier of our own in this app.",
                  "You can export a backup, erase your synced data, revoke share links, disconnect GitHub and remove stored API keys at any time.",
                ]}
              />
            </Section>

            <Section id="collect" number="03" title="What we collect">
              <SubHeading>Account and identity</SubHeading>
              <p>Held by Supabase Auth for this deployment:</p>
              <Bullets
                items={[
                  "Email address, and the display name and avatar URL a provider returns if you sign in with Google, GitHub or Microsoft.",
                  "A password hash if you register with an email address and password — we never see the password itself.",
                  "Your account identifier, session tokens, and timestamps of account activity.",
                ]}
              />
              <p>In the app’s own database, in the <code className="font-mono text-[12px]">profiles</code> and <code className="font-mono text-[12px]">visitor_registry</code> tables:</p>
              <Bullets
                items={[
                  "A display name you choose, up to 40 characters.",
                  "The first and last time your account was seen.",
                  "Preferences you set: appearance, home layout, response length, reasoning effort, model choice and timezone.",
                ]}
              />

              <SubHeading>Your conversations</SubHeading>
              <p>
                Stored in this browser’s local database (IndexedDB, through Dexie) and synced to
                your account, in the <code className="font-mono text-[12px]">chats</code>,{" "}
                <code className="font-mono text-[12px]">chat_messages</code>,{" "}
                <code className="font-mono text-[12px]">folders</code> and{" "}
                <code className="font-mono text-[12px]">trash</code> tables:
              </p>
              <Bullets
                items={[
                  "The text of your messages and of the assistant’s answers.",
                  "Images you attach (compressed to JPEG in the browser) and the extracted text of documents you attach.",
                  "Web search queries, and the source links and excerpts a search returned.",
                  "Token counts, the product model label, and which tools the repository agent used.",
                  "Any change the agent proposed, and whether you approved, rejected or committed it.",
                  "Titles, folders, pins, and the thirty-day trash.",
                ]}
              />
              <p>
                <span className="text-text-hi">Temporary chats are the exception.</span> They exist
                only in the open page and are discarded when you close them.
              </p>

              <SubHeading>Your GitHub connection, if you add one</SubHeading>
              <p>
                Whether you paste a personal access token or authorize through GitHub’s own screen,
                we store:
              </p>
              <Bullets
                items={[
                  <>
                    The access token, <span className="text-text-hi">encrypted with AES-256-GCM</span>{" "}
                    under a server-side key.
                  </>,
                  "The GitHub login it belongs to, the scopes GitHub reports, a label, and the connection time.",
                  "Which connection is your default.",
                ]}
              />
              <p>
                When you use the repository workspace, the app reads the repository’s file tree and
                file contents through GitHub on your behalf. If you approve a proposed change, the
                app creates a branch, a commit and a pull request{" "}
                <span className="text-text-hi">in your repository</span>.
              </p>

              <SubHeading>API keys you bring yourself, if any</SubHeading>
              <p>
                A model provider key you add is validated with one lightweight request to that
                provider, then encrypted with AES-256-GCM before storage. Only a four-character hint
                and the update time are ever shown back to you. The key itself is never returned to
                a browser and never written to a log.
              </p>

              <SubHeading>Payments and credit</SubHeading>
              <p>
                Openmi uses an in-app currency (“Dew”). We store your balance, credits, spending and
                transaction history; redeemed codes, daily free-Dew counters and referral credits;
                and a paid pass if one is activated for you.
              </p>
              <p>
                Payment is by <span className="text-text-hi">manual bank transfer (DuitNow)</span>,
                and the operator activates the pass. We do not receive or store card numbers, bank
                credentials or any payment instrument details. Your bank’s own privacy policy
                covers the transfer.
              </p>

              <SubHeading>Advertising</SubHeading>
              <p>
                Two networks can serve this deployment, and which one is live is the operator’s
                choice. The banner above the composer is{" "}
                <span className="text-text-hi">Google AdSense</span>; Google and its partners may
                collect cookies, device identifiers, IP address, approximate location and ad
                interaction data under{" "}
                <Outbound href="https://policies.google.com/technologies/partner-sites">
                  Google’s partner-sites policy
                </Outbound>
                . The <span className="text-text-hi">Adsterra popunder</span>, when configured, is
                one script that may open an advertisement in a new window or a background tab,
                usually after a click; Adsterra and its partners may collect the same categories
                of ad data under their own privacy policy. We do not receive your conversation,
                and we do not pass conversation content to either network for advertising.
              </p>

              <SubHeading>Error reports, only if configured</SubHeading>
              <p>
                If the operator has configured error reporting, crash diagnostics are sent to
                Sentry. These contain the error, the stack trace and the route. The app is
                configured to strip request bodies, cookies, and any{" "}
                <code className="font-mono text-[12px]">messages</code>,{" "}
                <code className="font-mono text-[12px]">content</code> or{" "}
                <code className="font-mono text-[12px]">prompt</code> fields before sending;
                collection of personal data is off, and performance tracing is disabled.
              </p>
            </Section>

            <Section id="not-collected" number="04" title="What we do not collect">
              <Bullets
                items={[
                  "No third-party analytics or tracking pixels of our own.",
                  "No advertising profile built by us.",
                  "No camera, microphone or location data unless you actively use the attachment controls. Camera and microphone are permitted for this origin only, and geolocation is blocked by policy.",
                  "No conversation content in error reports.",
                ]}
              />
            </Section>

            <Section id="why" number="05" title="Why we use it">
              <Table
                head={["Purpose", "Data", "Basis"]}
                rows={[
                  [
                    "Provide the service: answer messages, run the repository agent",
                    "Account, conversations, attachments, GitHub reads",
                    "Performance of a contract",
                  ],
                  ["Sync your history across devices", "Conversations, folders, trash", "Performance of a contract"],
                  [
                    "Charge for usage and keep the ledger honest",
                    "Dew balance, transactions, passes",
                    "Performance of a contract",
                  ],
                  [
                    "Prevent abuse: rate limits, bans, spend caps",
                    "Account id, IP address, usage counters",
                    "Legitimate interests (security and cost control)",
                  ],
                  [
                    "Approve and record a commit you authorize",
                    "Change set, approval, commit record",
                    "Performance of a contract",
                  ],
                  [
                    "Show one advertisement",
                    "Ad slot; Google’s own identifiers",
                    "Legitimate interests, with an opt-out at Google (§8)",
                  ],
                  ["Diagnose crashes", "Error and stack trace, stripped of content", "Legitimate interests (reliability)"],
                  ["Meet legal obligations and respond to lawful requests", "As required", "Legal obligation"],
                ]}
              />
              <p>
                We do not use your conversations to train models, and we do not sell or rent
                personal data.
              </p>
            </Section>

            <Section id="recipients" number="06" title="Who receives your data">
              <Table
                head={["Recipient", "What is sent", "Why"]}
                rows={[
                  [
                    "Supabase",
                    "Account, profile, conversations, Dew ledger, encrypted credentials",
                    "Authentication and database hosting",
                  ],
                  [
                    "OpenRouter, Google (Gemini), Groq, DeepSeek",
                    "The messages in the conversation you are continuing, your response-length preference, and any web-search excerpts the turn used; attachments only with the message that carries them",
                    "Generating the answer or the agent’s next step",
                  ],
                  [
                    "GitHub",
                    "Repository reads; on your approval, a branch, commit and pull request in your repository",
                    "The repository feature you asked for",
                  ],
                  ["Tavily", "The text of a web search query, when search is used", "Retrieving search results"],
                  [
                    "Google AdSense",
                    "Standard ad-request data: page URL, device and cookie identifiers, IP address",
                    "The ad slot",
                  ],
                  [
                    "Adsterra",
                    "The same categories: page URL, IP address, device and cookie identifiers, ad interactions",
                    "The popunder, when configured",
                  ],
                  [
                    "Sentry, if configured",
                    "Error, stack trace, route, stripped of conversation content",
                    "Crash diagnosis",
                  ],
                  ["Our hosting provider", "All traffic to the app", "Serving the application"],
                  ["The deployment administrator", "See below", "Operating the service"],
                ]}
              />
              <p>
                If you use your own provider key, requests for your turns go to that provider under{" "}
                <span className="text-text-hi">your</span> account with them, not ours.
              </p>
              <SubHeading>The administrator console</SubHeading>
              <p>
                The operator has an administration console. It can list registered names and session
                counts, read chat titles, open the contents of an individual chat, adjust
                configuration, issue credit, apply bans and delete an account’s data. Access is
                enforced in the database by row-level security, not by hiding buttons. We use it for
                support, abuse handling and legal compliance.
              </p>
            </Section>

            <Section id="storage" number="07" title="Cookies and local storage">
              <p>We do not set advertising or analytics cookies of our own. The app uses:</p>
              <Bullets
                items={[
                  <>
                    <span className="text-text-hi">A local database (IndexedDB)</span> for chats,
                    messages, folders, trash, projects and change sets, so the app works before the
                    network does.
                  </>,
                  <>
                    <span className="text-text-hi">Local storage</span> for appearance and layout
                    settings, your pending invitation code, and the identifier of the account that
                    owns this browser’s history, so one account’s cache is never uploaded into
                    another’s.
                  </>,
                  <>
                    <span className="text-text-hi">Your sign-in session</span>, kept in this browser
                    by Supabase Auth.
                  </>,
                  <>
                    <span className="text-text-hi">A service worker</span> that caches the app’s
                    artwork only; the document and its scripts are always fetched fresh.
                  </>,
                  <>
                    <span className="text-text-hi">Google AdSense cookies</span>, when the banner
                    renders.
                  </>,
                ]}
              />
              <p>
                Clearing site data in your browser removes the local copies. Your synced copies
                remain until you erase them (§12).
              </p>
            </Section>

            <Section id="ads" number="08" title="Advertising and your choices">
              <Bullets
                items={[
                  <>
                    <span className="text-text-hi">Personalized ads:</span> turn them off at{" "}
                    <Outbound href="https://adssettings.google.com">Google Ad Settings</Outbound>.
                  </>,
                  <>
                    <span className="text-text-hi">How Google uses site data:</span>{" "}
                    <Outbound href="https://policies.google.com/technologies/partner-sites">
                      policies.google.com/technologies/partner-sites
                    </Outbound>
                    .
                  </>,
                  <>
                    <span className="text-text-hi">Regional consent:</span> this deployment does
                    not yet present a consent message for the EEA, the UK or Switzerland, so in
                    those regions an ad may be requested without a consent prompt. The Google Ad
                    Settings link above is the control available today, and the operator can switch
                    the ad slot off for the whole deployment.
                  </>,
                  <>
                    <span className="text-text-hi">No ad</span> is requested on the sign-in screen,
                    in a temporary chat, or on the Focus home.
                  </>,
                  <>
                    <span className="text-text-hi">Popunder:</span> where the operator has
                    configured Adsterra, one script may open an advertisement in a background
                    window or tab. Most ad blockers stop it, and blocking it does not affect the
                    app. The Google Ad Settings link above covers AdSense only; Adsterra’s own
                    privacy policy covers its cookies.
                  </>,
                  "The operator can switch advertising off for the whole deployment without a release.",
                ]}
              />
            </Section>

            <Section id="retention" number="09" title="How long we keep it">
              <Table
                head={["Data", "Retention"]}
                rows={[
                  ["Account, profile and preferences", "Until you delete them or ask us to close the account"],
                  ["Conversations, folders, projects, change sets", "Until you delete them"],
                  ["Deleted chats in the trash", "30 days, restorable, then purged"],
                  ["Temporary chats", "Not stored at all"],
                  ["Shared answer links", "30 days from creation, or until you revoke them"],
                  [
                    "Dew ledger, transactions and passes",
                    "Kept after a data erase, because paid credit belongs to you (§12)",
                  ],
                  [
                    "GitHub connection and stored API keys",
                    "Until you disconnect or remove them, or erase your data",
                  ],
                  [
                    "Rate-limit and usage counters",
                    "Burst counters reset within a minute; daily usage rows stay until you erase your data",
                  ],
                  ["Error reports", "Per the reporting service’s retention setting"],
                ]}
              />
              <p>
                Approved commits and pull requests live in <span className="text-text-hi">your</span>{" "}
                GitHub repository and are not deleted by erasing your Openmi data. They are yours to
                keep or revert.
              </p>
            </Section>

            <Section id="security" number="10" title="Security">
              <Bullets
                items={[
                  <>
                    Every table is protected by row-level security, and the application holds{" "}
                    <span className="text-text-hi">no service-role key</span>, so a request can only
                    ever reach the caller’s own rows.
                  </>,
                  "GitHub tokens and personal model keys are sealed with AES-256-GCM under a server-side key that never reaches the browser.",
                  "Provider and GitHub credentials are never returned by any response and never written to logs; the app shows a masked hint only.",
                  "Agent turn state is HMAC-signed, so a browser cannot raise its own step budget or claim a turn was already paid.",
                  "Traffic is served over HTTPS with HSTS, a restrictive content-security policy, frame denial and a strict referrer policy.",
                ]}
              />
              <p>
                No system is perfect. If you believe your account or a credential has been
                compromised, contact us immediately and revoke the credential at the provider.
              </p>
            </Section>

            <Section id="transfers" number="11" title="International transfers">
              <p>
                Openmi and the providers listed in §6 operate in multiple countries. Your data may
                be processed outside the country you live in, including in the United States. Where
                required, those transfers rely on the safeguards the providers publish, such as
                standard contractual clauses.
              </p>
            </Section>

            <Section id="rights" number="12" title="Your rights and controls">
              <p>
                Depending on where you live, you may have the right to access, correct, export,
                delete, restrict or object to the processing of your data, and to withdraw consent
                for advertising. You can exercise most of these directly:
              </p>
              <Bullets
                items={[
                  <>
                    <span className="text-text-hi">Export:</span> Settings → Your data → download a
                    JSON backup of this browser’s history.
                  </>,
                  <>
                    <span className="text-text-hi">Erase:</span> Settings → Your data → clear this
                    browser and delete your account’s synced conversations, folders, trashed chats,
                    change sets, GitHub connections and stored keys.
                  </>,
                  <>
                    <span className="text-text-hi">Revoke a share link:</span>{" "}
                    <Link href="/shares" className="text-accent underline decoration-accent/30 underline-offset-2">
                      the shares page
                    </Link>
                    , or Settings → Your data.
                  </>,
                  <>
                    <span className="text-text-hi">Disconnect GitHub:</span> Settings → GitHub →
                    remove the connection; the sealed token is deleted.
                  </>,
                  <>
                    <span className="text-text-hi">Remove a model key:</span> Settings → API keys.
                  </>,
                  <>
                    <span className="text-text-hi">Ad choices:</span> see §8.
                  </>,
                ]}
              />
              <p>Two things the in-app eraser deliberately does not do, and why:</p>
              <Bullets
                items={[
                  <>
                    <span className="text-text-hi">It keeps your Dew ledger.</span> Paid credit is
                    your property; silently destroying a top-up would be worse than keeping the
                    record.
                  </>,
                  <>
                    <span className="text-text-hi">It does not delete the account record itself.</span>{" "}
                    It removes your content and connections. To close the account entirely, including
                    the sign-in identity, contact us and we will remove it.
                  </>,
                ]}
              />
              <p>
                To make a request you cannot complete in the app, or to appeal a decision, contact
                us. We may need to verify that the account is yours. You also have the right to
                complain to your local data-protection authority.
              </p>
            </Section>

            <Section id="children" number="13" title="Children">
              <p>
                Openmi is not directed at children. You must be old enough to consent to data
                processing in your country — at least 13, or 16 in some places — to hold an account.
                If we learn that a child below that age has created one, we will remove it.
              </p>
            </Section>

            <Section id="changes" number="14" title="Changes to this policy">
              <p>
                We will update this page when what the app does changes, and change the date at the
                top. Material changes — a new recipient of your data, a new category of data, a
                longer retention period — will be announced in the app before they take effect.
              </p>
            </Section>

            <Section id="contact" number="15" title="Contact">
              <p>
                Questions, access or deletion requests, or a complaint:{" "}
                {CONTACT_EMAIL ? (
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
                  >
                    {CONTACT_EMAIL}
                  </a>
                ) : (
                  <>
                    this deployment does not publish a contact address yet. Requests that need a
                    person — closing the account, correcting data, withdrawing consent — should go
                    to whoever operates it. Everything that touches your content can be done
                    without one: <span className="text-text-hi">Settings → Your data</span> exports
                    a copy or erases it, and the{" "}
                    <Link href="/shares" className="text-accent underline decoration-accent/30 underline-offset-2">
                      shares page
                    </Link>{" "}
                    revokes a public link.
                  </>
                )}
              </p>
              <p className="text-text-mid">Openmi is built and operated by Minetallest.</p>
            </Section>
          </div>

          <footer className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5 text-[11px] text-text-low">
            <span className="font-mono uppercase tracking-[0.1em]">Openmi · Privacy</span>
            <span aria-hidden>·</span>
            <Link href="/about" className="transition-colors hover:text-text-hi">
              About
            </Link>
            <Link href="/plus" className="transition-colors hover:text-text-hi">
              Plans
            </Link>
            <Link href="/chat" className="transition-colors hover:text-text-hi">
              Open the app
            </Link>
          </footer>
        </div>
      </div>
    </MaintenanceGate>
  );
}

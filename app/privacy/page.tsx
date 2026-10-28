import Link from "next/link";
import MaintenanceGate from "@/components/MaintenanceGate";

// ── Privacy ──────────────────────────────────────────────────────────────────
// A plain, factual page. Two reasons it exists and is public: AdSense requires
// one, and a product that stores conversations and shows ads owes the reader an
// account of both. No marketing copy, no promises the code does not keep.

export const metadata = {
  title: "Privacy — Openmi",
  description: "What Openmi stores, what Google collects for advertising, and how to delete your data.",
};

export default function PrivacyPage() {
  return (
    <MaintenanceGate>
      <div className="app-surface flex min-h-[100dvh] flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-6 py-10 sm:px-8 sm:py-14">
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 text-[12px] text-white/45 transition-colors hover:text-white/80"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Back to Openmi
          </Link>

          <h1 className="mt-6 text-[28px] font-semibold leading-tight tracking-tight text-white/90">
            Privacy
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-white/50">
            What this deployment stores, what it sends to a model provider, and what Google collects
            to show an ad. Written to be read in a minute.
          </p>

          <h2 className="mt-8 text-[12px] font-semibold uppercase tracking-[0.12em] text-white/35">
            What Openmi stores
          </h2>
          <ul className="mt-2 space-y-2 text-[13px] leading-relaxed text-white/65">
            <li>
              <span className="text-white/85">Your account.</span> The address, display name and
              avatar you signed up with, held by Supabase Auth for this deployment.
            </li>
            <li>
              <span className="text-white/85">Your conversations.</span> Chats live in this
              browser&apos;s local database first and are synced to your account so they follow you
              to another browser. Temporary chats are never written down at all.
            </li>
            <li>
              <span className="text-white/85">Your Dew ledger.</span> Top-ups, spending, daily free
              Dew and referral credits, kept so the balance can be derived rather than trusted.
            </li>
            <li>
              <span className="text-white/85">Your GitHub connection, if you add one.</span> An
              access token sealed with a server-side key, never shown back to the browser. The agent
              reads repositories and proposes changes; it cannot commit without your approval.
            </li>
          </ul>

          <h2 className="mt-8 text-[12px] font-semibold uppercase tracking-[0.12em] text-white/35">
            What is sent to a model provider
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-white/65">
            The messages in the conversation you are continuing, plus your preferences and any web
            search results the turn used, are sent to the provider serving the model you picked so
            it can answer. Attachments are sent only with the message that carries them.
          </p>

          <h2 className="mt-8 text-[12px] font-semibold uppercase tracking-[0.12em] text-white/35">
            Advertising
          </h2>
          <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-white/65">
            <p>
              This site shows one small ad above the chat composer, served by Google AdSense.
              Google and its partners may use cookies or device identifiers to select and measure
              ads. Openmi does not receive your conversation, and does not share it with Google for
              advertising.
            </p>
            <p>
              You can control personalised advertising at{" "}
              <a
                href="https://adssettings.google.com"
                className="text-[#a9d8bb] underline decoration-[#a9d8bb]/30 underline-offset-2 hover:decoration-[#a9d8bb]"
                rel="noopener noreferrer"
                target="_blank"
              >
                Google Ad Settings
              </a>
              . How Google uses information from sites that use its services is described at{" "}
              <a
                href="https://policies.google.com/technologies/partner-sites"
                className="text-[#a9d8bb] underline decoration-[#a9d8bb]/30 underline-offset-2 hover:decoration-[#a9d8bb]"
                rel="noopener noreferrer"
                target="_blank"
              >
                policies.google.com
              </a>
              .
            </p>
            <p>
              Where consent is required by law (the EEA, the UK and Switzerland), Google&apos;s own
              consent message is shown before any ad is requested. No ad script is loaded on the
              sign-in screen, in a temporary chat, or on the Focus home.
            </p>
          </div>

          <h2 className="mt-8 text-[12px] font-semibold uppercase tracking-[0.12em] text-white/35">
            Deleting your data
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-white/65">
            Settings → Your data can clear this browser and delete your account&apos;s synced
            conversations. Deleting the account removes what is stored for it, including the sealed
            GitHub connection; any proposal you approved remains a commit in your own repository,
            which is yours to keep or revert. To have an account removed without signing in, contact
            the person who runs this deployment.
          </p>

          <p className="mt-8 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-white/35">
            Last updated 25 October 2026. Openmi is built by Minetallest. Questions or a deletion
            request: use the contact address on the {" "}
            <Link href="/about" className="text-[#a9d8bb]/80 hover:text-[#a9d8bb]">
              About page
            </Link>
            .
          </p>
        </div>
      </div>
    </MaintenanceGate>
  );
}

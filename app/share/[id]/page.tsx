import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "@/components/Markdown";
import { publicClient } from "@/lib/supabase";
import { isShareId, parseSharedMessages } from "@/lib/share";

// ── One answer, on its own ──────────────────────────────────────────────────
//
// This is the only page in the product that does not require an account. It
// reads `shared_public`, a projection with no owner column, filtered to links
// that are neither revoked nor expired. The snapshot is a copy taken when the
// link was made; the account, the rest of the chat and the attachments are not
// here and never were.
//
// Rendering is deliberately plain: a title, the question, the answer, and one
// way back into the product. Search engines are told not to index it — a share
// is for the people it was sent to, not a public post.

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Shared answer — Openmi",
  robots: { index: false, follow: false },
};

function formatDay(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(parsed));
}

export default async function SharedAnswerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isShareId(id)) notFound();

  const client = publicClient();
  if (!client) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0b1310] px-6 text-center text-white">
        <p className="max-w-sm text-[13px] leading-relaxed text-white/50">
          This deployment has no Supabase project configured, so shared answers cannot be read.
        </p>
      </main>
    );
  }

  const { data, error } = await client
    .from("shared_public")
    .select("title, messages, created_at, expires_at")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) notFound();

  const row = data as { title?: unknown; messages?: unknown; created_at?: unknown; expires_at?: unknown };
  const messages = parseSharedMessages(row.messages);
  if (messages.length === 0) notFound();

  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Shared answer";
  const expires = formatDay(row.expires_at);

  return (
    <main className="min-h-dvh bg-[#0b1310] px-5 pb-14 pt-[max(1.25rem,env(safe-area-inset-top))] text-white sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/chat" className="flex items-center gap-2 text-[12px] text-white/45 transition-colors hover:text-white/80">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Openmi
          </Link>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a9d8bb]/60">
            Shared answer
          </span>
        </header>

        <h1 className="mt-8 text-balance text-[clamp(1.5rem,5vw,2.1rem)] font-semibold leading-tight tracking-tight">
          {title}
        </h1>

        <article className="mt-6 space-y-5">
          {messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-white/[0.075] px-4 py-2.5 text-[14px] leading-relaxed text-white/85">
                  {message.content}
                </p>
              </div>
            ) : (
              <div key={index} className="rounded-[22px] border border-white/[0.06] bg-white/[0.02] px-4 py-3.5 text-[14.5px] sm:px-5">
                <Markdown content={message.content} />
              </div>
            )
          )}
        </article>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4 text-[11px] text-white/35">
          <p>
            Shared from Openmi{expires ? ` · this link expires ${expires}` : ""}. The conversation behind it is
            private.
          </p>
          <Link
            href="/chat"
            className="rounded-xl border border-[#a9d8bb]/25 px-3 py-1.5 text-[11.5px] font-medium text-[#a9d8bb] transition-colors hover:bg-[#a9d8bb]/10"
          >
            Ask Openmi →
          </Link>
        </footer>
      </div>
    </main>
  );
}

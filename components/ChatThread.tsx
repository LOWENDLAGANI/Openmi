"use client";

import type { ChatMessage } from "@/lib/types";
import { displayedContent, variantCount, variantPosition } from "@/lib/variants";
import { authHeader } from "@/lib/supabase";
import { isShareId, shareUrl, type ShareMessage, type ShareSnapshot } from "@/lib/share";
import Link from "next/link";
import Markdown from "./Markdown";
import OpenmiMark from "./OpenmiMark";
import ChangeReview from "./ChangeReview";
import { useSmoothText } from "@/lib/useSmoothText";
import { useEffect, useRef, useState } from "react";

interface ChatThreadProps {
  messages: ChatMessage[];
  streamingId: string | null;
  isEmpty: boolean;
  onRegenerate: (assistantId: string) => void;
  onEditMessage: (messageId: string, content: string) => void;
  onCopyConversation: () => void;
  /** Which answer is on screen for a message that has more than one. */
  onSwitchVariant: (messageId: string, index: number | null) => void;
  /**
   * What the agent is doing right now, when it is working on something that has
   * not produced text yet. The repository agent reports each read before it
   * runs, so a turn that takes half a minute never looks like it stopped.
   */
  activity?: string | null;
  /**
   * Asks the agent to stage the change it just described. This is a new Code
   * turn, not a free add-on: the button says so in its title.
   */
  onPropose: (assistantId: string) => void;
  /** The attached repository, so the empty state can say what the agent can do. */
  agentRepo?: string | null;
}

const STREAMING_MESSAGES = [
  "Extrapolating…",
  "Tokenizing…",
  "Synthesizing…",
  "Computing…",
  "Inference…",
] as const;

/**
 * An image in the thread, framed the way a gallery frames one.
 *
 * The card is a fixed square so a row of them stays a row, and the controls
 * float over the picture instead of adding a footer under it: a download pill
 * bottom-left in frosted glass, the Openmi AI mark bottom-right. Both are on
 * the dark glass, so they keep their white text in the light appearance too.
 */
function MediaCard({
  url,
  name,
  watermark = false,
}: {
  url: string;
  name?: string;
  watermark?: boolean;
}) {
  return (
    <figure className="media-card h-36 w-36 shrink-0 sm:h-40 sm:w-40">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name || "Attached image"}
        className="h-full w-full cursor-zoom-in object-cover"
        onClick={() => window.open(url, "_blank")}
      />
      <a
        href={url}
        download={name || "openmi-image"}
        className="frosted on-media absolute bottom-2 left-2 flex h-8 w-8 items-center justify-center rounded-full transition-transform active:scale-95"
        aria-label={`Download ${name || "image"}`}
        title="Download"
        onClick={(event) => event.stopPropagation()}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3.5v11" />
          <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
          <path d="M4.5 19.5h15" />
        </svg>
      </a>
      {watermark && (
        <figcaption className="media-watermark pointer-events-none absolute bottom-2.5 right-2.5 text-[10px] font-medium tracking-[0.02em]">
          Openmi AI
        </figcaption>
      )}
    </figure>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be unavailable in some browsers.
        }
      }}
      className="thread-tool w-7 justify-center px-0"
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy"}
      type="button"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden="true">
          <path d="m4.5 12.5 5 5 10-11" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5" />
        </svg>
      )}
    </button>
  );
}

// ── Sharing one answer ──────────────────────────────────────────────────────
//
// The button publishes a copy of the question and the answer that is on screen,
// copies the link, and offers the two things worth having afterwards: open it,
// or manage (and revoke) it. The copy is made server-side with the caller's
// token; the snapshot is validated again there, so a modified client cannot
// publish something this button would not have produced.

function ShareAnswerButton({ title, messages }: { title: string; messages: ShareMessage[] }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ title, messages }),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: unknown; error?: unknown };
      if (!response.ok || !isShareId(data.id)) {
        setError(
          typeof data.error === "string" && data.error.trim()
            ? data.error
            : "The link could not be created."
        );
        return;
      }
      const url = shareUrl(window.location.origin, data.id);
      setLink(url);
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_500);
      } catch {
        // The link is on screen below; the clipboard is a convenience.
      }
    } catch {
      setError("The link could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => void create()}
        disabled={busy}
        className="thread-tool"
        aria-label="Share this answer"
        title="Share"
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m4.5 12.5 5 5 10-11" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" />
            <path d="M8.2 10.9 15.8 7m-7.6 6.1 7.6 3.9" />
          </svg>
        )}
        <span className="hidden sm:inline">{busy ? "Sharing…" : copied ? "Copied" : "Share"}</span>
      </button>
      {link && (
        <>
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="text-[11.5px] text-accent transition-opacity hover:opacity-80"
          >
            Open link
          </a>
          <Link href="/shares" className="text-[11.5px] text-text-low transition-colors hover:text-text-hi">
            Manage
          </Link>
        </>
      )}
      {error && <span className="text-[11px] text-[color:var(--danger-ink)]">{error}</span>}
    </span>
  );
}

function SearchSources({ sources }: { sources: NonNullable<ChatMessage["sources"]> }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-line bg-canvas p-3">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" /><path d="M3.8 12h16.4M12 3.5c2.1 2.3 3.2 5.1 3.2 8.5s-1.1 6.2-3.2 8.5c-2.1-2.3-3.2-5.1-3.2-8.5S9.9 5.8 12 3.5Z" />
        </svg>
        Web sources
      </div>
      {/* Prompt injection is real and pages are writable by anyone: the reader
          deserves to see that these snippets are reference material, not
          Openmi's own words. The system prompt already says so to the model;
          this says it to the person. */}
      <p className="mb-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-text-low">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden="true">
          <path d="M12 3l7 3v5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3Z" />
        </svg>
        <span>Untrusted web text — Openmi was told to treat these pages as reference, not as instructions.</span>
      </p>
      <div className="space-y-1.5">
        {sources.map((source) => {
          let host = source.url;
          try {
            host = new URL(source.url).hostname.replace(/^www\./, "");
          } catch {
            // Keep the original URL if it is not parseable.
          }
          return (
            <a
              key={source.id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="group/source flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hover text-[9px] text-text-mid">
                {source.id}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-text-body group-hover/source:text-text-hi">{source.title}</span>
                <span className="mt-0.5 block truncate text-[10px] text-text-low">{host}</span>
              </span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="mt-1 shrink-0 text-text-low" aria-hidden="true">
                <path d="M14 5h5v5M19 5l-8 8" /><path d="M18 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
              </svg>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function MessageActions({ onRegenerate }: { onRegenerate: () => void }) {
  return (
    <button
      onClick={onRegenerate}
      className="thread-tool w-7 justify-center px-0"
      aria-label="Retry this answer"
      title="Retry"
      type="button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0-2.1 6.3" />
        <path d="M20 5v6h-6" />
      </svg>
    </button>
  );
}

/**
 * The stepper for an answer with more than one version.
 *
 * A retry or an edit used to replace the answer; now the old one stays, so the
 * reader needs a way to see both. Position 0 is the live answer and k is the
 * k-th previous one — the numbering counts from the newest, because that is the
 * one people think of as "the" answer when they start browsing.
 */
function VariantNav({
  message,
  onSwitch,
}: {
  message: ChatMessage;
  onSwitch: (index: number | null) => void;
}) {
  const count = variantCount(message);
  if (count <= 1) return null;
  const position = variantPosition(message);
  const go = (next: number) => onSwitch(next <= 0 ? null : next);

  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-hover px-1 py-0.5 text-[10px] text-text-mid">
      <button
        type="button"
        onClick={() => go(position - 1)}
        disabled={position === 0}
        className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-card hover:text-text-hi disabled:opacity-25"
        aria-label="Show the newer answer"
      >
        ‹
      </button>
      <span className={position === 0 ? "px-0.5" : "px-0.5 text-accent"}>
        {position + 1}/{count}
        {position === 0 ? " latest" : " earlier"}
      </span>
      <button
        type="button"
        onClick={() => go(position + 1)}
        disabled={position >= count - 1}
        className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-card hover:text-text-hi disabled:opacity-25"
        aria-label="Show the previous answer"
      >
        ›
      </button>
    </span>
  );
}

function MessageRow({ msg, streaming, onRegenerate, onEditMessage, onSwitchVariant, onPropose, canPropose, share }: {
  msg: ChatMessage;
  streaming: boolean;
  onRegenerate: () => void;
  onEditMessage: (content: string) => void;
  onSwitchVariant: (index: number | null) => void;
  onPropose: () => void;
  canPropose: boolean;
  share: ShareSnapshot;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  // What the reader is looking at: the live answer, or an earlier one they
  // stepped back to. Every display and copy below uses this, so the screen and
  // the clipboard can never disagree about which answer is being read.
  const displayText = displayedContent(msg);
  // While the answer is arriving, the text on screen trails the text already
  // received, revealed at a steady pace instead of landing in whatever size
  // chunks the provider happened to send. Finished answers are never held
  // back — only the streaming one is animated.
  const shownContent = useSmoothText(displayText, streaming);
  if (msg.role === "user") {
    return (
      <div className="group flex animate-rise flex-col items-end gap-1.5">
        <div className="flex max-w-[85%] flex-col items-end gap-2">
          {msg.images && msg.images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {msg.images.map((img, i) => (
                <MediaCard key={i} url={img.url} name={img.name} />
              ))}
            </div>
          )}
          {msg.documents && msg.documents.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              {msg.documents.map((document) => (
                <span key={document.name} className="rounded-lg border border-line bg-card px-2 py-1 text-[10px] text-text-mid flex items-center gap-1.5">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  {document.name}
                </span>
              ))}
            </div>
          )}
          {msg.content && !editing && (
            <div className="msg-user-bubble">
              <p className="whitespace-pre-wrap break-words">{msg.content}</p>
            </div>
          )}
          {editing ? (
            <div className="w-full rounded-2xl border border-line bg-card p-2">
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} className="w-full resize-none bg-transparent p-1 text-[14px] text-text-hi outline-none" autoFocus />
              <div className="flex justify-end gap-2 text-[11px]"><button type="button" onClick={() => { setEditing(false); setDraft(msg.content); }} className="px-2 py-1 text-text-mid transition-colors hover:text-text-hi">Cancel</button><button type="button" onClick={() => { const next = draft.trim(); if (!next) return; setEditing(false); onEditMessage(next); }} className="on-accent rounded-lg bg-accent px-2.5 py-1">Edit &amp; send</button></div>
            </div>
          ) : (
            <button type="button" onClick={() => setEditing(true)} className="thread-tool md:opacity-0 md:group-hover:opacity-100">Edit</button>
          )}
        </div>
        {msg.error && (
          <div role="alert" className="alert alert-danger w-full max-w-[85%]">
            <AlertIcon />
            <div className="min-w-0 flex-1">
              <span className="alert-title">This message was not sent</span>
              <span className="alert-body">{msg.error}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // A turn that never produced text is the failure itself, so it is drawn as
  // one alert rather than as an empty white card with a red box floating in it.
  if (!msg.content && msg.error) {
    return (
      <div className="animate-rise">
        <div role="alert" className="alert alert-danger alert-flush max-w-[92%] md:max-w-[85%]">
          <AlertIcon />
          <div className="min-w-0 flex-1">
            <span className="alert-title">Openmi could not answer</span>
            <span className="alert-body">{msg.error}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex animate-rise flex-col gap-1">
      {/* The answer is a card: white on the gray canvas, a hairline border and
          the softest shadow that still lifts it off the page. The model badge
          sits at the top of the card rather than floating above it, so the
          whole turn is one object. */}
      <div className="msg-ai-card max-w-[92%] md:max-w-[85%]">
        {/* Header only when there is an answer to head. A turn that produced
            no text has already returned above as a bare alert. */}
        {msg.content && (
          <div className="mb-2.5 flex items-center gap-2">
            <ModelBadge model={msg.model} />
            {msg.usage && (
              <span
                className="text-[10px] text-text-low"
                title={`${msg.usage.prompt.toLocaleString()} in · ${msg.usage.completion.toLocaleString()} out`}
              >
                {msg.usage.total.toLocaleString()} tok
              </span>
            )}
            <VariantNav message={msg} onSwitch={onSwitchVariant} />
          </div>
        )}

        {/* What the agent read to answer this. Kept to one line per read: a wall
            of tool JSON buries the answer, and the path is the part a reader
            needs. A failed read stays visible rather than being tidied away —
            it is the difference between "that file is empty" and "that file was
            never opened". */}
        {msg.steps && msg.steps.length > 0 && (
          <div className="mb-2 space-y-1 rounded-xl border border-line bg-canvas px-3 py-1.5">
            {msg.steps.map((step, index) => (
              <div
                key={`${step.tool}-${index}`}
                className="flex items-start gap-2 text-[11px] leading-relaxed text-text-mid"
              >
                <span
                  aria-hidden
                  className={`mt-[5px] h-1 w-1 shrink-0 rounded-full ${
                    step.running ? "animate-pulse bg-accent" : step.ok ? "bg-emerald-500/70" : "bg-red-400/70"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className={`block break-words ${step.running ? "text-text-hi" : ""}`}>
                    {step.label}
                  </span>
                  {/* Why a proposal staged nothing, in the server's words. A
                      refusal the reader cannot act on is noise, so only the
                      tool's own short reason is shown here. */}
                  {step.detail && !step.running && (
                    <span className="mt-0.5 block break-words text-[10px] leading-relaxed text-text-low">
                      {step.detail}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {msg.images && msg.images.length > 0 && (
          <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto pb-0.5">
            {msg.images.map((img, i) => (
              <MediaCard key={i} url={img.url} name={img.name} watermark />
            ))}
          </div>
        )}

        {shownContent && (
          <div className={streaming ? "stream-cursor" : ""}>
            <Markdown content={shownContent} />
          </div>
        )}

        {/* A proposal is the answer's subject, not an appendix, so the review sits
            directly under the text that explains it. It reads the stored change
            set rather than the step response, so a reload keeps a reviewable
            change instead of losing the only diff the browser ever held. */}
        {msg.changesetId && !streaming && <ChangeReview changesetId={msg.changesetId} />}

        {msg.sources && <SearchSources sources={msg.sources} />}

        {/* A cut-off answer, said out loud. A truncated file is the one failure
            mode here that is completely invisible: it renders as a clean code
            block, copies as a clean code block, and reads as finished. This only
            appears once every other model Openmi can reach has also failed to
            finish it, so the wording says as much. */}
        {msg.truncated && (
          <div role="status" className="alert alert-warn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 9v4.5M12 17h.01" />
              <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3.1L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
            <div className="min-w-0 flex-1">
              <span className="alert-title">This answer was cut off</span>
              <span className="alert-body">
                Openmi tried other models and this answer still stops partway, because
                it hit their length limit too. Ask it to continue and it will pick up
                from where it left off.
              </span>
            </div>
          </div>
        )}

        {msg.error && (
          <div role="alert" className="alert alert-danger">
            <AlertIcon />
            <div className="min-w-0 flex-1">
              <span className="alert-title">Openmi could not answer</span>
              <span className="alert-body">{msg.error}</span>
            </div>
          </div>
        )}
      </div>

      {/* The actions sit below the card rather than in its header, and they
          appear only once the answer is genuinely finished. That placement is
          the point: a truncated response is the one failure here that is
          otherwise invisible, rendering and copying as a clean block and
          reading as complete. With the controls underneath, their absence is
          the signal — nothing to press means nothing finished, and the
          explanation above says why. A header button could not carry that
          meaning, because it would be missing for unrelated reasons. */}
      {msg.content && !streaming && !msg.truncated && !msg.error && (
        <div className="flex flex-wrap items-center gap-1 pl-1">
          {canPropose && (
            <button
              type="button"
              onClick={onPropose}
              className="thread-tool gap-1.5"
              title="Ask Openmi to stage this change as a diff you review. Starts a new Code request; nothing is committed until you approve it."
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M4.5 20.5h15" />
              </svg>
              Propose this change
            </button>
          )}
          <MessageActions onRegenerate={onRegenerate} />
          <CopyMessageButton text={displayText} />
          <ShareAnswerButton title={share.title} messages={share.messages} />
        </div>
      )}
    </div>
  );
}

function TypingDots({ message }: { message: string }) {
  return (
    <div className="typing-waiter" role="status" aria-live="polite">
      {/* A soft glowing pill behind the words, blurred rather than shadowed so
          it does not repaint on every frame. The hue is the product accent, kept
          low so the typing indicator is a presence cue, not a glow that fights
          the message card above it. */}
      <span className="typing-waiter-glow" aria-hidden="true" />
      <div className="flex items-center gap-2 py-1">
        <span className="flex items-center gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1 w-1 rounded-full animate-blink bg-text-mid"
              style={{ animationDelay: `${i * 0.18}s` }}
            />
          ))}
        </span>
        <span className="text-[12px] leading-relaxed text-text-mid">{message}</span>
      </div>
    </div>
  );
}

// Empty-state headlines. They are walked in order and the cursor is persisted,
// so consecutive loads never repeat before the whole list has been seen.
const EMPTY_STATE_HEADLINES = [
  "What should we create?",
  "What are we building today?",
  "Where do you want to start?",
  "What is on your mind?",
  "Ask me anything at all.",
  "What are we figuring out?",
  "Bring me a problem.",
  "What would you like to know?",
  "Give me something to work with.",
  "What are we solving today?",
  "Let's make something useful.",
  "What is the first question?",
  "Drop it here, I will take it from there.",
  "What are you curious about?",
  "What deserves a second look?",
  "Start anywhere. I will keep up.",
  "What is the short version?",
  "Explain it to me and I will sharpen it.",
  "What are we untangling?",
  "Give me a rough idea and we will refine it.",
  "What is the best next step?",
  "What is worth exploring today?",
  "Point me at something.",
  "What should we think through?",
  "What is the real question here?",
  "Make a list, make a plan, or just talk.",
  "What do you want to understand better?",
  "Which rabbit hole are we going down?",
  "What needs a second brain?",
  "What is worth a few minutes of thought?",
  "Say it the messy way. I will organise it.",
  "What is the idea you cannot shake?",
  "What would you do with an extra hour?",
  "Tell me a story and I will keep straight.",
  "What should we stop overthinking?",
  "Which half-finished thing should we finish?",
  "What does good look like here?",
  "Paste the thing you do not want to read.",
  "What are you avoiding?",
  "Name the thing, I will find the angle.",
  "What would you ask a very patient expert?",
  "What is the version of this that actually ships?",
  "What is new since you last looked?",
  "Turn the messy notes into a plan.",
  "What is the smallest useful first step?",
  "What is worth keeping simple?",
  "What has been bothering you?",
  "What do you want to be careful about?",
  "Which trade-off are you weighing?",
  "What would you write if nobody read it?",
  "What is the one thing I should not forget?",
  "Show me the rough version, not the polished one.",
  "What is stuck?",
  "What would you do with unlimited time?",
  "What is the question behind the question?",
  "What deserves a proper explanation?",
  "What would you like to argue about?",
  "What is the best way to begin?",
  "What changed your mind recently?",
  "What would you fix if you could fix one thing?",
  "What should we make a list of?",
  "Where do you want more clarity?",
  "What is the thing you keep meaning to ask?",
  "What would make today feel productive?",
  "What is the whole idea in one line?",
  "What are we taking on next?",
  "What would you like a second opinion on?",
  "Which habit are you trying to build?",
  "What is the question you keep postponing?",
  "What should we make simpler?",
  "What is worth writing down properly?",
  "What are you hoping changes?",
  "Which idea deserves a rough draft today?",
  "What would a good outcome look like in a week?",
  "What is the part you already know the answer to?",
  "What do you want to be reminded of?",
  "What should we measure progress by?",
  "Where is the friction coming from?",
  "What would you do with a blank page?",
  "Which task has been quietly growing?",
  "What is the assumption worth testing?",
  "What would you tell a friend in this spot?",
  "What are you optimising for right now?",
  "What is the one thing to protect this week?",
  "What deserves a name before it becomes real?",
  "Which thread can we pull on?",
  "What is ready for a decision?",
  "What would make this feel finished?",
  "Where do you want a second set of eyes?",
  "What is the smallest thing that would help?",
  "What have you already tried?",
  "What should we leave alone?",
  "What is the part that is actually hard?",
  "What do you want to sound like?",
  "Which constraint is real and which is imagined?",
  "What would you regret not asking?",
  "What is the difference you want to see?",
  "What is the next honest step?",
  "What should we check before we commit?",
  "What are you avoiding saying out loud?",
  "What would make this conversation useful?",
  "Which idea has been sitting longest?",
  "What do you want to be different about tomorrow?",
  "What is worth keeping out of scope?",
  "What could we do in ten minutes?",
  "What is the shape of the problem?",
  "Which idea would be fun to test?",
  "What are you waiting on?",
  "What is worth writing a summary of?",
  "What would you change if you could?",
  "What is the second-order effect here?",
  "What should we ask the team?",
  "What has to be true for this to work?",
  "What is the kind of help you need?",
  "What is worth doing badly first?",
  "Which version of this would you actually use?",
  "What is the point of this, in one line?",
  "What should we stop, start, and continue?",
  "What is new in how you are thinking about it?",
  "What would you want remembered?",
  "What is the simplest honest answer?",
  "Which detail is doing all the work?",
  "What is worth another hour?",
  "What would change your mind?",
  "What are you optimising against?",
  "What is the thing underneath the thing?",
  "What should we do before Friday?",
  "What would you build if nobody was watching?",
  "What is the question behind the work?",
  "Which half of this is actually the task?",
  "What deserves a fresh pair of eyes?",
  "What is the most useful next reply?",
  "What would you like to be able to do?",
  "What is ready to be decided today?",
  "What are we avoiding by staying busy?",
  "What is the clearest way to say it?",
];

const HEADLINE_CURSOR_KEY = "openmi:empty-headline-cursor";

/**
 * The copy of one exchange that a share button publishes.
 *
 * The question is the nearest previous user message, and the answer is what is
 * on screen — the variant the reader chose, not necessarily the newest. Keeping
 * both together is what makes a link readable on its own; the rest of the
 * conversation is deliberately absent.
 */
function shareSnapshotAt(messages: ChatMessage[], index: number): ShareSnapshot {
  const msg = messages[index];
  const answer = msg ? displayedContent(msg) : "";
  const previous = [...messages.slice(0, index)]
    .reverse()
    .find((entry) => entry.role === "user" && entry.content.trim().length > 0);
  const shared: ShareMessage[] = [];
  if (previous) shared.push({ role: "user", content: previous.content });
  if (answer.trim()) shared.push({ role: "assistant", content: answer });
  const firstLine = previous?.content.trim().split("\n")[0]?.trim() ?? "";
  return { title: firstLine.slice(0, 100) || "Shared answer", messages: shared };
}

/** Walks the list in order so two refreshes in a row never show the same line. */
function nextHeadline(): string {
  let cursor = 0;
  try {
    const stored = Number(localStorage.getItem(HEADLINE_CURSOR_KEY));
    if (Number.isInteger(stored) && stored >= 0) cursor = stored;
  } catch {
    // localStorage can be unavailable in private mode; fall back to a plain pick.
    return EMPTY_STATE_HEADLINES[Math.floor(Math.random() * EMPTY_STATE_HEADLINES.length)] ?? EMPTY_STATE_HEADLINES[0];
  }

  const headline = EMPTY_STATE_HEADLINES[cursor % EMPTY_STATE_HEADLINES.length] ?? EMPTY_STATE_HEADLINES[0];
  try {
    localStorage.setItem(HEADLINE_CURSOR_KEY, String(cursor + 1));
  } catch {
    // Non-fatal: the headline still changes within this session.
  }
  return headline;
}

export default function ChatThread({  messages,
  streamingId,
  isEmpty,
  onRegenerate,
  onEditMessage,
  onCopyConversation,
  onSwitchVariant,
  activity = null,
  onPropose,
  agentRepo = null,
}: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [loadingMessage, setLoadingMessage] = useState<string>(STREAMING_MESSAGES[0]);
  const [showSourceHistory, setShowSourceHistory] = useState(false);
  // Seeded deterministically for SSR, then randomized after mount.
  const [headline, setHeadline] = useState(EMPTY_STATE_HEADLINES[0]);

  useEffect(() => {
    if (!isEmpty) return;
    setHeadline(nextHeadline());
  }, [isEmpty]);

  useEffect(() => {
    if (streamingId) {
      setLoadingMessage(STREAMING_MESSAGES[Math.floor(Math.random() * STREAMING_MESSAGES.length)]);
    }
  }, [streamingId]);

  useEffect(() => {
    if (stickRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const allSources = messages.flatMap((message) => message.sources ?? []);
  const copySources = async () => {
    const text = allSources.map((source) => `${source.title}\n${source.url}`).join("\n\n");
    if (text) await navigator.clipboard.writeText(text).catch(() => undefined);
  };

  if (isEmpty) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 pb-24 sm:pb-28">
        <div className="-translate-y-2 text-center sm:-translate-y-5">
          <div className="relative mx-auto mb-7 flex h-16 w-16 items-center justify-center sm:h-20 sm:w-20">
            <div className="absolute inset-[-45%] rounded-full bg-[#2f6b48]/20 blur-3xl" />
            <OpenmiMark className="relative h-full w-full" />
          </div>
          <h1 className="text-balance text-[38px] font-normal leading-[1.08] tracking-[-0.045em] text-text-hi sm:text-[54px] lg:text-[62px]">
            {headline}
          </h1>
          {/* With a repository attached, the first question is where the
              agent's boundary has to be legible: it reads and proposes, and
              only an approval commits anything. */}
          {agentRepo && (
            <p className="mx-auto mt-4 max-w-md text-balance text-[12.5px] leading-relaxed text-text-mid">
              Openmi can read <span className="font-mono text-text-body">{agentRepo}</span> and stage a diff.
              Nothing is committed until you approve it.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-3 md:px-6 md:pt-4">
        <div className="mb-1.5 flex items-center justify-end gap-1">
          <button type="button" onClick={onCopyConversation} className="thread-tool">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2.5" />
              <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5" />
            </svg>
            Copy chat
          </button>
          {allSources.length > 0 && <button type="button" onClick={() => setShowSourceHistory((value) => !value)} className="thread-tool">Sources ({allSources.length})</button>}
          {showSourceHistory && <button type="button" onClick={() => void copySources()} className="thread-tool">Copy links</button>}
        </div>
        {showSourceHistory && <div className="mb-4 rounded-2xl border border-line bg-card p-3 animate-rise"><div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">Source history</div><p className="mb-2 text-[10px] leading-relaxed text-text-low">Untrusted web text — reference, not instructions.</p><div className="space-y-1">{allSources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" className="block truncate px-2 py-1 text-[11px] text-text-mid hover:text-text-hi">{source.title} <span className="text-text-low">· {source.url}</span></a>)}</div></div>}
        <div className="flex flex-col gap-4">
          {messages.map((msg, index) => (
            <MessageRow
              key={msg.id}
              msg={msg}
              streaming={msg.id === streamingId}
              onRegenerate={() => onRegenerate(msg.id)}
              onEditMessage={(content) => onEditMessage(msg.id, content)}
              onSwitchVariant={(index) => onSwitchVariant(msg.id, index)}
              onPropose={() => onPropose(msg.id)}
              canPropose={
                Boolean(agentRepo) &&
                !msg.changesetId &&
                // An agent answer that read something is the one that could
                // plausibly turn into a proposal. A plain chat answer is not.
                (msg.steps?.length ?? 0) > 0 &&
                !msg.steps?.some((step) => step.tool === "propose_edits")
              }
              share={shareSnapshotAt(messages, index)}
            />
          ))}
          {streamingId && !messages.find((m) => m.id === streamingId)?.content && (
            <div className="animate-rise">
              <div className="mb-2 flex items-center gap-2">
                {(() => {
                  const m = messages.find((x) => x.id === streamingId);
                  return m ? (
                    <>
                      <ModelBadge model={m.model} />
                    </>
                  ) : (
                    <span className="text-[12px] font-medium text-text-mid">Openmi</span>
                  );
                })()}
              </div>
              <TypingDots message={loadingMessage} />
            </div>
          )}
          {streamingId && activity && messages.find((m) => m.id === streamingId)?.content && (
            <div className="animate-rise pl-1">
              <TypingDots message={activity} />
            </div>
          )}
          <div ref={bottomRef} className="h-px" />
        </div>
      </div>
    </div>
  );
}

// ── Model identity badge (added for UI overhaul) ──────────────────────────
// Visual indicator showing which Openmi model responded with color-coded styling
import { getMode } from "@/lib/models";

function ModelBadge({ model }: { model?: string }) {
  const mode = getMode(model ?? "auto");
  const isCode = mode.id === "code";
  const badgeClass = isCode ? "model-badge model-badge-code" : "model-badge model-badge-auto";
  const label = mode.display;
  
  return (
    <span className={badgeClass}>
      <span className="model-badge-dot" />
      {label}
    </span>
  );
}

/** The triangle every alert in the thread uses. */
function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13M12 16.5h.01" />
    </svg>
  );
}

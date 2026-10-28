"use client";

import type { DocumentAttachment, ImageAttachment } from "@/lib/types";
import { secondsRemaining } from "@/lib/rateLimit";
import { compressFiles, formatBytes } from "@/lib/imageUtils";
import type { ResponseLength } from "@/lib/settings";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import QuickActions from "./QuickActions";
import ContextRing from "./ContextRing";
import Spinner from "./Spinner";
import { estimateContextUsage } from "@/lib/contextBudget";

// ── ChatInput: floating composer with attachments — minimal, mobile-first ───

interface ChatInputProps {
  onSend: (text: string, images: ImageAttachment[], documents?: DocumentAttachment[]) => void;
  disabled: boolean;
  onStop?: () => void;
  /** Epoch ms until which the server has asked us to hold off; null when free. */
  rateLimitUntil: number | null;
  /** The Focus home's composer: one rounded card, a length picker along the
      bottom edge, and no suggestion row. Null keeps the classic capsule. */
  focusMode?: { responseLength: ResponseLength; onChange: (value: ResponseLength) => void } | null;
  /** Prompt tokens of the last completed answer, from the server's own usage. */
  contextUsed?: number;
  /** The per-request token budget the server enforces; never a model window. */
  contextBudget?: number;
  /** True while an answer streams, so the ring can show it is still counting. */
  streaming?: boolean;
  /** The escape hatch at the top of the budget. */
  onNewChat?: () => void;
  canStartNewChat?: boolean;
}

const LENGTH_LABELS: Record<ResponseLength, string> = {
  short: "Short",
  balanced: "Balanced",
  detailed: "Detailed",
};

const MAX_IMAGES = 4;
const MAX_DOCUMENTS = 3;
const MAX_DOCUMENT_SIZE = 100_000;
const DOCUMENT_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json", "application/javascript",
  "text/typescript", "text/x-python", "text/html", "text/css", "text/sql",
]);

type SpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechWindow = Window & { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition };

/** The tools sheet, shared by the classic capsule and the focus composer. */
function ToolsMenu({
  onCamera,
  onGallery,
  onFiles,
  onVoice,
  listening,
  onClose,
}: {
  onCamera: () => void;
  onGallery: () => void;
  onFiles: () => void;
  onVoice: () => void;
  listening: boolean;
  onClose: () => void;
}) {
  return (
    <div className="animate-pop absolute bottom-14 right-0 z-50 w-[286px] max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-card p-1.5 shadow-xl backdrop-blur-xl">
      <button
        type="button"
        onClick={onCamera}
        className="flex w-full items-center gap-3.5 rounded-[18px] px-2 py-2.5 text-left transition-colors hover:bg-hover active:bg-line"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-hover text-text-hi">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 8.5A2 2 0 0 1 5.5 6.5h1.7l1.2-2h7.2l1.2 2h1.7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
            <circle cx="12" cy="13" r="3.4" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text-hi">Camera</span>
      </button>
      <button
        type="button"
        onClick={onGallery}
        className="flex w-full items-center gap-3.5 rounded-[18px] px-2 py-2.5 text-left transition-colors hover:bg-hover active:bg-line"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-hover text-text-hi">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="4.5" /><circle cx="8.75" cy="8.75" r="1.6" /><path d="M21 15.5l-4.5-4.5L5 21" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text-hi">Gallery</span>
      </button>
      <button
        type="button"
        onClick={onFiles}
        className="flex w-full items-center gap-3.5 rounded-[18px] px-2 py-2.5 text-left transition-colors hover:bg-hover active:bg-line"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-hover text-text-hi">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3.5h8l4 4V20.5H6z" /><path d="M14 3.5v4h4M9 12h6M9 15.5h4" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text-hi">Files</span>
      </button>

      <button
        type="button"
        onClick={onVoice}
        className={`flex w-full items-center gap-3.5 rounded-[18px] px-2 py-2.5 text-left transition-colors hover:bg-hover active:bg-line ${listening ? "bg-red-500/10" : ""}`}
      >
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-hover text-text-hi ${listening ? "animate-pulse" : ""}`}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text-hi">{listening ? "Listening…" : "Voice input"}</span>
      </button>
    </div>
  );
}

/** The sliders glyph the focus composer's length picker uses. */
function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
    </svg>
  );
}

export default function ChatInput({
  onSend,
  disabled,
  onStop,
  rateLimitUntil,
  focusMode = null,
  contextUsed = 0,
  contextBudget,
  streaming = false,
  onNewChat,
  canStartNewChat = true,
}: ChatInputProps) {
  const focus = Boolean(focusMode);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [showTools, setShowTools] = useState(false);
  const [showModes, setShowModes] = useState(false);
  const modesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  // Ticks once a second while a rate limit is counting down, so the chip
  // loses a number rather than sitting frozen until the next render.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!rateLimitUntil || rateLimitUntil <= Date.now()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [rateLimitUntil]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const textRef = useRef(text);

  useEffect(() => {
    if (!showTools && !showModes) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!toolsRef.current?.contains(target)) setShowTools(false);
      if (!modesRef.current?.contains(target)) setShowModes(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showTools, showModes]);

  const hasContent = text.trim().length > 0 || attachments.length > 0 || documents.length > 0;
  // The ring counts what the server last sent plus what is sitting in the
  // composer. Attachments are estimated by size because they are not text.
  const contextUsage = estimateContextUsage({
    usedTokens: contextUsed,
    draftText: text,
    images: attachments.length,
    documentChars: documents.reduce((total, document) => total + document.text.length, 0),
    budget: contextBudget,
  });
  const rateRemaining = rateLimitUntil ? secondsRemaining(rateLimitUntil, now) : 0;
  const rateLimited = rateRemaining > 0;
  const canSend = hasContent && !compressing && !rateLimited;

  const addFiles = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) {
      setErrors([`Max ${MAX_IMAGES} images per message`]);
      return;
    }

    setCompressing(true);
    setErrors([]);
    try {
      const { results, errors: errs } = await compressFiles(imageFiles.slice(0, room));
      const next: ImageAttachment[] = results.map((r, i) => ({
        url: r.dataUrl,
        name: imageFiles[i]?.name ?? `image-${i + 1}`,
        size: r.size,
      }));
      setAttachments((prev) => [...prev, ...next]);
      if (errs.length) setErrors(errs);
    } finally {
      setCompressing(false);
    }
  };

  const addDocuments = async (files: File[]) => {
    const supported = files.filter((file) => DOCUMENT_TYPES.has(file.type) || /\.(txt|md|csv|json|js|jsx|ts|tsx|py|html|css|sql)$/i.test(file.name));
    if (supported.length === 0) {
      setErrors(["Text and code files are supported (up to 100 KB each)"]);
      return;
    }
    const room = MAX_DOCUMENTS - documents.length;
    if (room <= 0) {
      setErrors([`Max ${MAX_DOCUMENTS} documents per message`]);
      return;
    }
    const next: DocumentAttachment[] = [];
    for (const file of supported.slice(0, room)) {
      if (file.size > MAX_DOCUMENT_SIZE) {
        setErrors([`${file.name} is larger than 100 KB`]);
        continue;
      }
      const fullText = await file.text();
      next.push({ name: file.name, size: file.size, text: fullText.slice(0, MAX_DOCUMENT_SIZE), truncated: fullText.length > MAX_DOCUMENT_SIZE });
    }
    setDocuments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setErrors([]);
  };

  const removeDocument = (index: number) => setDocuments((prev) => prev.filter((_, i) => i !== index));

  const toggleVoice = () => {
    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setErrors(["Voice input is not supported in this browser"]);
      return;
    }
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (!transcript) return;
      // Append to whatever is in the box *now*: dictation can run for a while,
      // and the draft captured when listening started may be stale.
      const current = textRef.current;
      handleTextChange(current ? `${current} ${transcript}` : transcript);
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => {
      setIsListening(false);
      setErrors(["Voice input could not be started"]);
    };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  };

  const handleSend = () => {
    // While streaming the send button becomes Stop.
    if (disabled) {
      onStop?.();
      return;
    }
    if (!canSend) return;
    onSend(text.trim(), attachments, documents);
    clearComposer();
  };

  const clearComposer = () => {
    textRef.current = "";
    setText("");
    setAttachments([]);
    setDocuments([]);
    setErrors([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    // Enter while an answer streams belongs to the draft, not to the Stop
    // button: people type their follow-up during the answer, and pressing
    // Enter there used to cancel the very answer they were reading.
    if (disabled) return;
    if (canSend) handleSend();
  };

  // Images and documents are handled by different pipelines; passing the same
  // list to both made a pasted screenshot raise "text and code files are
  // supported" from the document reader that had nothing it could read.
  const addFilesByKind = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    const documents = files.filter((file) => !file.type.startsWith("image/"));
    if (images.length > 0) void addFiles(images);
    if (documents.length > 0) void addDocuments(documents);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    addFilesByKind(Array.from(e.dataTransfer.files));
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      addFilesByKind(files);
    }
  };

  const handleTextChange = (value: string) => {
    textRef.current = value;
    setText(value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }
  };

  return (
    <footer
      className={`composer-dock sticky bottom-0 z-20 shrink-0 pb-3 ${
        focus ? "border-0 pt-0" : "border-t border-line pt-2"
      }`}
    >
      {/* Same column and same gutter as the thread above, so the capsule's
          edges sit under the message cards rather than a few pixels off. */}
      <div className="mx-auto w-full max-w-3xl px-4 md:px-6">
        {/* Composer header — the context ring alone. Focus home has no header:
            its whole composition is the mark and the composer. */}
        {!focus && (
          <div className="mb-1 flex items-center justify-end">
            <ContextRing
              usage={contextUsage}
              streaming={streaming}
              onNewChat={onNewChat}
              canStartNewChat={canStartNewChat}
            />
          </div>
        )}

        {/* Errors */}
        {errors.length > 0 && (
          <div
            role="alert"
            className="mb-2 flex items-start gap-2 rounded-xl border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-3 py-2 text-[12px] leading-relaxed text-[color:var(--danger-ink)] animate-rise"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5V13M12 16.5h.01" />
            </svg>
            <span className="min-w-0 flex-1">{errors.join(" · ")}</span>
          </div>
        )}

        {/* Rate limit — a countdown, not a scolding. The queue button turns
            the refused message into a scheduled one, so the wait costs the
            writer nothing but time. */}
        {rateLimited && (
          <div
            role="status"
            className="mb-2 flex items-center gap-2 rounded-xl border border-amber-300/15 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-100/85 animate-rise"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span className="min-w-0 flex-1">Rate limited — you can send again in {rateRemaining}s.</span>
          </div>
        )}

        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 animate-rise">
            {attachments.map((img, i) => (
              <div key={i} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.name}
                  className="h-14 w-14 rounded-lg border border-line object-cover"
                />
                <button
                  onClick={() => removeAttachment(i)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-raised text-text-mid transition-colors hover:bg-red-500/20 hover:text-red-400"
                  aria-label={`Remove ${img.name}`}
                  type="button"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
                <span className="attachment-size pointer-events-none absolute inset-x-0 bottom-0 rounded-b-lg py-px text-center font-mono text-[8px]">
                  {formatBytes(img.size)}
                </span>
              </div>
            ))}
            {compressing && (
              <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-line-strong">
                <Spinner size={16} className="text-text-low" />
              </div>
            )}
          </div>
        )}

        {documents.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 animate-rise">
            {documents.map((document, i) => (
              <div key={`${document.name}-${i}`} className="flex max-w-full items-center gap-2 rounded-xl border border-line bg-hover px-3 py-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#a9d8bb]/10 text-[#a9d8bb]">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5h8l4 4V20.5H6z" /><path d="M14 3.5v4h4M9 12h6M9 15h6" /></svg>
                </span>
                <span className="min-w-0"><span className="block max-w-[150px] truncate text-[11px] text-text-body">{document.name}</span><span className="text-[9px] text-text-low">{formatBytes(document.size)}{document.truncated ? " · truncated" : ""}</span></span>
                <button type="button" onClick={() => removeDocument(i)} className="ml-1 text-text-low hover:text-[color:var(--danger-ink)]" aria-label={`Remove ${document.name}`}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
              </div>
            ))}
          </div>
        )}

        {/* The focus screen has no suggestion row — the empty space around the
            mark is the design. Its section label stands where the chips would
            be, so the composer still has a heading above it. */}
        {focus ? (
          <p className="mb-2 pl-2.5 text-[13px] leading-none text-text-hi">Skills</p>
        ) : (
          !hasContent &&
          !compressing && (
            <div className="pt-0.5">
              <QuickActions
                onPick={(prompt) => {
                  handleTextChange(prompt);
                  textareaRef.current?.focus();
                }}
              />
            </div>
          )
        )}

        {focus ? (
          /* Focus composer: a card rather than a capsule, with the message on
             top and the length picker, tools and send along its bottom edge. */
          <div className="focus-composer rounded-[26px] px-3.5 py-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
              placeholder={compressing ? "Compressing…" : "Ask Openmi…"}
              className="block max-h-[180px] w-full resize-none border-none bg-transparent px-0.5 py-0 text-[16px] leading-snug text-text-hi placeholder:text-text-low focus:outline-none"
            />

            <div className="mt-1 flex items-center gap-0.5">
              <div ref={modesRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setShowModes((value) => !value)}
                  className="flex items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-1 text-[13px] text-text-mid transition-colors hover:text-text-hi"
                  aria-label="Response length"
                  aria-expanded={showModes}
                >
                  <SlidersIcon />
                  <span className="text-text-body">{LENGTH_LABELS[focusMode?.responseLength ?? "balanced"]}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6.5 9.5 5.5 5 5.5-5" />
                  </svg>
                </button>
                {showModes && (
                  <div className="animate-pop absolute bottom-11 left-0 z-50 w-44 overflow-hidden rounded-2xl border border-line bg-card p-1 shadow-xl">
                    {(["short", "balanced", "detailed"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          focusMode?.onChange(value);
                          setShowModes(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-hover ${
                          focusMode?.responseLength === value ? "text-text-hi" : "text-text-mid"
                        }`}
                      >
                        {LENGTH_LABELS[value]}
                        {focusMode?.responseLength === value && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="m4.5 12.5 5 5 10-11" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-1" />

              <div ref={toolsRef} className="relative shrink-0">
                <button
                  onClick={() => setShowTools((value) => !value)}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-text-mid transition-colors hover:bg-card hover:text-text-hi"
                  aria-label="Open tools menu"
                  aria-expanded={showTools}
                  type="button"
                  title="Open message tools"
                >
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 5.5v13M5.5 12h13" />
                  </svg>
                </button>
                {showTools && (
                  <ToolsMenu
                    onCamera={() => {
                      setShowTools(false);
                      cameraInputRef.current?.click();
                    }}
                    onGallery={() => {
                      setShowTools(false);
                      fileInputRef.current?.click();
                    }}
                    onFiles={() => {
                      setShowTools(false);
                      document.getElementById("openmi-document-picker")?.click();
                    }}
                    onVoice={toggleVoice}
                    listening={isListening}
                    onClose={() => setShowTools(false)}
                  />
                )}
              </div>

              {disabled ? (
                <button
                  onClick={onStop}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-hover text-text-mid transition-colors hover:text-text-hi"
                  aria-label="Stop generating"
                  type="button"
                  title="Stop generating"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-white transition-opacity ${
                    canSend ? "focus-send" : "focus-send opacity-75"
                  }`}
                  aria-label="Send message"
                  type="button"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
        {/* Composer: one capsule, attachment on the left, the message in the
            middle, voice and tools on the right. */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`composer-capsule flex items-end gap-0.5 px-2 py-1.5 transition-all ${
            dragOver ? "ring-2 ring-blue-400/30" : ""
          }`}
        >
          {/* Camera / attachment — the first thing on the left of the capsule */}
          <button
            onClick={() => cameraInputRef.current?.click()}
            className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-mid transition-colors hover:bg-card hover:text-text-hi"
            aria-label="Take a photo or add an image"
            type="button"
            title="Camera"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 8.5A2 2 0 0 1 5.5 6.5h1.7l1.2-2h7.2l1.2 2h1.7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
              <circle cx="12" cy="13" r="3.4" />
            </svg>
          </button>

          {/* Textarea — 16px on mobile to prevent iOS zoom */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            placeholder={compressing ? "Compressing…" : "Message Openmi…"}
            className="max-h-[180px] flex-1 resize-none border-none bg-transparent px-1 py-2.5 text-[16px] leading-snug text-text-hi placeholder:text-text-low focus:outline-none md:text-[15px]"
          />

          {/* Voice */}
          <button
            onClick={toggleVoice}
            className={`mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${
              isListening ? "bg-red-500/10 text-red-500" : "text-text-mid hover:bg-card hover:text-text-hi"
            }`}
            aria-label={isListening ? "Stop voice input" : "Start voice input"}
            aria-pressed={isListening}
            type="button"
            title={isListening ? "Listening…" : "Voice input"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
            </svg>
          </button>

          {/* Tools: the + menu */}
          <div ref={toolsRef} className="relative shrink-0">
            <button
              onClick={() => setShowTools((value) => !value)}
              className="mb-0.5 flex h-10 w-10 items-center justify-center rounded-full text-text-mid transition-colors hover:bg-card hover:text-text-hi"
              aria-label="Open tools menu"
              aria-expanded={showTools}
              type="button"
              title="Open message tools"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5.5v13M5.5 12h13" />
              </svg>
            </button>
            {showTools && (
              <ToolsMenu
                onCamera={() => {
                  setShowTools(false);
                  cameraInputRef.current?.click();
                }}
                onGallery={() => {
                  setShowTools(false);
                  fileInputRef.current?.click();
                }}
                onFiles={() => {
                  setShowTools(false);
                  document.getElementById("openmi-document-picker")?.click();
                }}
                onVoice={toggleVoice}
                listening={isListening}
                onClose={() => setShowTools(false)}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            {/* capture="environment" opens the rear camera directly on phones;
                desktop browsers ignore it and fall back to a normal file picker. */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <input
              id="openmi-document-picker"
              type="file"
              accept=".txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.html,.css,.sql"
              multiple
              className="hidden"
              onChange={(e) => {
                void addDocuments(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>

          {/* Send / Stop — the one filled control in the capsule. */}
          {disabled ? (
            <button
              onClick={onStop}
              className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-hover text-text-mid transition-colors hover:text-text-hi"
              aria-label="Stop generating"
              type="button"
              title="Stop generating"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${
                canSend
                  ? "on-accent bg-accent shadow-sm hover:opacity-90"
                  : "send-idle"
              }`}
              aria-label="Send message"
              type="button"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
          </>
        )}

        {/* The one piece of small print the design asks for, directly under the
            capsule where it belongs. The Focus screen has no room for it — its
            whole composition is the mark and the composer — so it is only
            printed beneath the classic capsule. */}
        {!focus && (
          <p className="mt-1.5 text-center text-[10px] leading-relaxed text-text-low">
            Content generated by Openmi AI. Might not be accurate.
          </p>
        )}

        <p className="hidden pt-1 text-center text-[10px] text-text-low md:block">
          Created by Minetallest
        </p>
        <div className="safe-bottom md:hidden" />
      </div>
    </footer>
  );
}

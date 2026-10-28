"use client";

// ── The landing page ─────────────────────────────────────────────────────────
//
// The front door, rendered on the server at `/`. What a visitor meets before
// they have an account. It is deliberately the
// opposite of the product's dark chat shell: a warm paper canvas, one orange
// accent, oversized type and a lot of air — a page that reads as a statement
// rather than a form.
//
// The one piece of motion it buys is the statement that fills with ink as the
// page scrolls, word by word. It is driven by a single scroll listener and a
// requestAnimationFrame, and it only ever rewrites the words whose state
// actually changed: on a long paragraph that is a handful of attribute writes
// per frame instead of a style recalculation over every span.
//
// The palette lives in app/globals.css under `.lp`, so this component never
// depends on the chat theme (which can be dark, paper or ink) and the landing
// looks the same for everyone.

import { useEffect, useRef } from "react";
import Link from "next/link";

// The statement fills in as you scroll. One string per line so the rhythm of
// the page survives on a phone; the gaps between blocks are the pauses in the
// argument, which is why they are separate paragraphs rather than a list.
const STATEMENT: string[][] = [
  [
    "Every file read.",
    "Every diff reviewed.",
    "Every commit approved.",
    "Every decision still yours.",
  ],
  ["That’s Openmi."],
  ["An agent can write the code.", "You still have to answer for it."],
  ["Review is not a step in the way.", "Review is the product."],
  [
    "The more you hand to an agent,",
    "the more you need to see the diff first.",
  ],
];

const STEPS = [
  {
    label: "Connect",
    title: "Point it at a repository",
    body: "Choose a project you already work in. Openmi reads only the files the question needs, not the whole tree.",
  },
  {
    label: "Draft",
    title: "Ask for the change",
    body: "The agent stages an edit and hands it to you as a diff you can read line by line, in your own code.",
  },
  {
    label: "Approve",
    title: "You make the call",
    body: "Nothing reaches your branch without your click. Reject it, ask for another approach, or take the diff yourself.",
  },
];

const RULES = [
  ["A", "It reads before it writes — and says which files it read."],
  ["B", "It never commits behind your back. The decision stays yours."],
  ["C", "It shows the whole diff, not a summary of one."],
  ["D", "It works on an agent branch, so your main stays yours."],
];

function Arrow({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 12h13" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

/** The brand mark: the Openmi chevron, cut out of the orange tile. */
function Wordmark() {
  return (
    <span className="lp-logo">
      <span className="lp-mark" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.5 16V8.5L12 14l6.5-5.5V16" />
        </svg>
      </span>
      <span className="lp-logo-text">openmi</span>
    </span>
  );
}

/** The one call to action, in the header and at the foot of the page. */
function PrimaryCta({ label = "Open Openmi", className = "" }: { label?: string; className?: string }) {
  return (
    <Link href="/chat" className={`lp-btn ${className}`}>
      {label}
      <Arrow className="lp-btn-arrow" />
    </Link>
  );
}

/** The line of type that fills with ink, word by word, as the page scrolls. */
function ScrollStatement() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const words = Array.from(root.querySelectorAll<HTMLElement>("[data-lp-word]"));
    if (words.length === 0) return;

    // Reduced motion still gets the finished statement: the fill is decoration,
    // and a reader who asked for stillness should never be left with grey text.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      words.forEach((word) => {
        word.dataset.on = "1";
      });
      return;
    }

    let filled = 0;
    let frame = 0;

    const paint = (count: number) => {
      if (count === filled) return;
      if (count > filled) {
        for (let i = filled; i < count; i += 1) words[i].dataset.on = "1";
      } else {
        for (let i = count; i < filled; i += 1) words[i].dataset.on = "0";
      }
      filled = count;
    };

    const measure = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      // The word at the top of the block starts filling once the block is a
      // little way up the viewport, and the last word lands before the block
      // leaves it, so the sentence finishes while it is still being read.
      const travel = rect.height + viewport * 0.35;
      const progress = Math.min(1, Math.max(0, (viewport * 0.82 - rect.top) / travel));
      paint(Math.round(progress * words.length));
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  let index = 0;
  return (
    <div ref={ref} className="lp-fill">
      {STATEMENT.map((block, blockIndex) => (
        <p className="lp-block" key={blockIndex}>
          {block.map((line) => (
            <span className="lp-line" key={line}>
              {line.split(" ").map((word) => {
                const key = `${line}-${index}`;
                index += 1;
                return (
                  <span className="lp-word" data-lp-word data-on="0" key={key}>
                    {word}
                  </span>
                );
              })}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/** A slow marquee of the product's one-sentence promise, under the header. */
function Ticker() {
  const run = (
    <>
      {[
        "Read the repo",
        "Stage the diff",
        "Approve the commit",
        "Nothing ships until you say so",
      ].map((phrase) => (
        <span className="lp-ticker-item" key={phrase}>
          {phrase}
          <span className="lp-ticker-dot" aria-hidden />
        </span>
      ))}
    </>
  );
  return (
    <div className="lp-ticker" aria-hidden>
      <div className="lp-ticker-track">
        <div className="lp-ticker-run">{run}</div>
        <div className="lp-ticker-run">{run}</div>
      </div>
    </div>
  );
}

export default function OpenmiLanding() {
  return (
    <div className="lp">
      <header className="lp-header">
        <div className="lp-shell lp-header-inner">
          <Link href="/" className="lp-logo-link" aria-label="Openmi home">
            <Wordmark />
          </Link>
          <nav className="lp-nav" aria-label="Sections">
            <Link href="/about">About</Link>
            <Link href="/plus">Plans</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
          <PrimaryCta label="Sign in" className="lp-btn-small" />
        </div>
      </header>

      <Ticker />

      <main>
        {/* The claim, big and unadorned: the same job the mono line below the
            header does on the reference page, in Openmi's own words. */}
        <section className="lp-hero">
          <div className="lp-shell">
            <p className="lp-mono lp-eyebrow">
              <span className="lp-square" aria-hidden />
              Repo agent · review before commit
            </p>
            <h1 className="lp-display">
              Your repository,
              <br />
              with a reviewer
              <br />
              built in.
            </h1>
            <p className="lp-lede">
              Openmi reads the code you point it at, drafts the change, and stages it as a diff.
              Nothing reaches your branch until you approve it.
            </p>
            <div className="lp-actions">
              <PrimaryCta />
              <Link href="/about" className="lp-btn-ghost">
                See what shipped
              </Link>
            </div>
          </div>
        </section>

        <section className="lp-brief">
          <div className="lp-shell lp-brief-inner">
            <p className="lp-mono lp-brief-line">
              Building the repo agent that shows you the diff before it writes one
            </p>
            <Link href="/about" className="lp-more">
              Read more
              <span aria-hidden>&gt;</span>
            </Link>
          </div>
        </section>

        {/* The scroll statement. Every word starts as warm grey and takes ink
            as the reader moves it through the viewport. */}
        <section className="lp-statement" aria-label="What Openmi is">
          <div className="lp-shell">
            <ScrollStatement />
          </div>
        </section>

        <section className="lp-steps">
          <div className="lp-shell">
            <div className="lp-section-head">
              <p className="lp-mono lp-kicker">01 — How it works</p>
              <h2 className="lp-h2">Read. Stage. Approve.</h2>
            </div>
            <div className="lp-grid-3">
              {STEPS.map((step, stepIndex) => (
                <div className="lp-step" key={step.title}>
                  <p className="lp-mono lp-step-label">
                    {String(stepIndex + 1).padStart(2, "0")} — {step.label}
                  </p>
                  <h3>{step.title}</h3>
                  <p className="lp-step-body">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-rules">
          <div className="lp-shell lp-rules-grid">
            <div>
              <p className="lp-mono lp-kicker">02 — The rule</p>
              <h2 className="lp-h2">
                The agent does the reading.
                <br />
                You do the deciding.
              </h2>
            </div>
            <ul className="lp-rule-list">
              {RULES.map(([marker, rule]) => (
                <li key={marker}>
                  <span className="lp-mono lp-rule-mark">{marker}</span>
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lp-cta">
          <div className="lp-shell">
            <p className="lp-mono lp-kicker">03 — Start</p>
            <h2 className="lp-cta-title">
              Bring a repository.
              <br />
              See what it changes.
            </h2>
            <PrimaryCta />
            <p className="lp-mono lp-cta-note">Read the repo. Stage the diff. Approve the commit.</p>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-shell lp-footer-inner">
          <Wordmark />
          <nav className="lp-footer-links" aria-label="Footer">
            <Link href="/about">About</Link>
            <Link href="/plus">Plans</Link>
            <Link href="/privacy">Privacy</Link>
            {/* The product is behind the account gate at /chat, so this opens
                the sign-in screen for a signed-out reader instead of returning
                them to the page they just finished. */}
            <Link href="/chat">Open the app</Link>
          </nav>
          <p className="lp-mono lp-copyright">Openmi · 2026</p>
        </div>
      </footer>
    </div>
  );
}

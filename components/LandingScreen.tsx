"use client";

// ── The first page a visitor sees ────────────────────────────────────────────
//
// This is the marketing door, not the product: a visitor who is not signed in
// lands here and meets one idea before any form. It is deliberately typographic
// rather than illustrated — a monospace label band, a cream page, and a large
// statement whose ink arrives as the page is read.
//
// The ink is the whole interaction. Every line starts as a pale trace and is
// filled word by word once it reaches the reading zone, so scrolling writes the
// page. `prefers-reduced-motion` gets the finished page immediately rather than
// a slower version of the same effect.
//
// Nothing here talks to the account, the database or a model: the landing must
// render for a visitor whose deployment has no backend at all. Sign-in is one
// tap away and the parent owns that decision.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

interface LandingScreenProps {
  /** Opens the sign-in screen. The parent owns whether it is shown. */
  onStart: () => void;
}

const NAV_LINKS: Array<{ href: string; label: string }> = [
  { href: "/about", label: "About" },
  { href: "/plus", label: "Plans" },
  { href: "/privacy", label: "Privacy" },
];

/** The statement the page is built around, in reading order. */
const HERO_LINES = [
  "Every repository read.",
  "Every question grounded.",
  "Every change proposed.",
  "Every commit approved.",
];

const STORY_LINES = ["That's Openmi.", "Reading creates the possibility.", "Review creates the value."];

/** The last paragraph is its own block so its breathing room can be larger. */
const CLOSING_LINE = "The more you ask of a model, the more the review matters.";

/**
 * One line of the statement, split into words.
 *
 * The split is what makes the ink arrive left to right instead of the whole
 * line flipping at once: each word carries its own small delay. A non-breaking
 * space keeps the words of a wrapped line from running together, and the line
 * itself is only a block for layout — assistive technology reads the sentence.
 */
function InkLine({
  text,
  className = "",
  as: Tag = "span",
}: {
  text: string;
  className?: string;
  as?: "span" | "p";
}) {
  const words = text.split(" ");
  return (
    <Tag data-ink className={className}>
      {words.map((word, index) => (
        <span
          key={`${word}-${index}`}
          className="landing-word"
          style={{ transitionDelay: `${index * 26}ms` }}
        >
          {word}
          {index < words.length - 1 ? "\u00a0" : ""}
        </span>
      ))}
    </Tag>
  );
}

/** Fills each line with ink when it reaches the reading zone, once. */
function useInkOnScroll(container: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const lines = Array.from(root.querySelectorAll<HTMLElement>("[data-ink]"));
    if (lines.length === 0) return;

    // Motion is the effect here, so asking not to be moved means seeing the
    // finished page, not a flicker-free half-written one.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const line of lines) line.classList.add("is-inked");
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-inked");
          observer.unobserve(entry.target);
        }
      },
      // A line is "being read" when it has crossed into the upper two-thirds of
      // the viewport. The bottom margin is the ink front; the top margin keeps
      // a line from being filled before it is actually looked at.
      { rootMargin: "-8% 0px -30% 0px", threshold: 0.01 }
    );
    for (const line of lines) observer.observe(line);
    return () => observer.disconnect();
  }, [container]);
}

function SparkleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <path
        d="M24 3.5c2.3 9.3 4.7 11.7 14 14-9.3 2.3-11.7 4.7-14 14-2.3-9.3-4.7-11.7-14-14 9.3-2.3 11.7-4.7 14-14Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function LandingScreen({ onStart }: LandingScreenProps) {
  const heroRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useInkOnScroll(heroRef);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // A menu that stays open behind a click or an Escape is a menu that covers
  // the thing the person is trying to read.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const start = () => {
    setMenuOpen(false);
    onStart();
  };

  return (
    <div id="top" className="landing-root min-h-[100dvh] overflow-x-hidden">
      <header className="flex items-center justify-between border-b border-[#ddd8cb] px-5 py-3.5 sm:px-8">
        <a
          href="#top"
          className="flex items-center gap-2 text-[#f04e23]"
          aria-label={`${BRAND.name} home`}
        >
          <SparkleMark />
          <span className="text-[23px] font-bold leading-none tracking-[-0.055em] sm:text-[25px]">
            openmi
          </span>
        </a>

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex h-10 w-10 items-center justify-center rounded-full text-[#15150f] transition-colors hover:bg-black/[0.05]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              {[4, 10.5, 17].map((y) =>
                [4, 10.5, 17].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.55" />)
              )}
            </svg>
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label="Openmi"
              className="animate-rise absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-xl border border-[#ddd8cb] bg-[#f8f5ec] p-1 shadow-[0_18px_50px_rgba(21,21,15,0.18)]"
            >
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  role="menuitem"
                  onClick={closeMenu}
                  className="block rounded-lg px-3 py-2 text-[12.5px] text-[#3b3a31] transition-colors hover:bg-black/[0.06] hover:text-[#15150f]"
                >
                  {link.label}
                </Link>
              ))}
              <div className="my-1 h-px bg-black/[0.08]" />
              <button
                type="button"
                role="menuitem"
                onClick={start}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[12.5px] font-semibold text-[#c93f18] transition-colors hover:bg-[#f04e23]/10"
              >
                Sign in
                <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <section className="border-b border-[#ddd8cb] px-5 pb-5 pt-4 sm:px-8">
        <p className="landing-mono text-[10.5px] uppercase leading-[1.95] tracking-[0.2em] text-[#15150f] sm:text-[12px]">
          Building the world&apos;s most trusted
          <br />
          coding agent
        </p>
        <a
          href="#story"
          className="landing-mono mt-3 inline-block text-[10.5px] uppercase tracking-[0.2em] text-[#f04e23] hover:underline hover:underline-offset-4 sm:text-[12px]"
        >
          Read more &gt;
        </a>
      </section>

      <main>
        <section
          ref={heroRef}
          id="story"
          className="relative px-5 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-16"
        >
          {/* The two orange edges are the page's scroll furniture, taken from
              the reference: a mark at the start of the statement and one where
              the next chapter begins. Purely decorative. */}
          <span aria-hidden="true" className="absolute left-0 top-16 h-7 w-2.5 bg-[#f04e23]" />
          <span aria-hidden="true" className="absolute right-0 top-[38%] h-7 w-2.5 bg-[#f04e23]" />

          <h1 className="landing-display max-w-[16ch] text-[#15150f] sm:max-w-none">
            {HERO_LINES.map((line) => (
              <InkLine key={line} text={line} className="landing-line" />
            ))}
          </h1>

          <div className="landing-display mt-[1.35em] max-w-[18ch] text-[#15150f] sm:max-w-none">
            {STORY_LINES.map((line, index) => (
              <InkLine
                key={line}
                as="p"
                text={line}
                className={index === 0 ? "landing-line" : "landing-line mt-[1.15em]"}
              />
            ))}
            <InkLine as="p" text={CLOSING_LINE} className="landing-line mt-[2.4em]" />
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-x-5 gap-y-3 sm:mt-16">
            <button
              type="button"
              onClick={onStart}
              className="inline-flex items-center gap-2 rounded-full bg-[#f04e23] px-6 py-3 text-[13px] font-semibold text-[#fdfaf2] transition-colors hover:bg-[#d94319]"
            >
              Get started
              <span aria-hidden="true">→</span>
            </button>
            <p className="text-[12px] text-[#6d6a5f]">
              Already have an account?{" "}
              <button
                type="button"
                onClick={onStart}
                className="font-semibold text-[#c93f18] underline decoration-[#c93f18]/30 underline-offset-2 hover:text-[#f04e23]"
              >
                Sign in
              </button>
            </p>
          </div>

          <p className="landing-mono mt-10 text-[9.5px] uppercase tracking-[0.18em] text-[#8a867a] sm:mt-14">
            {BRAND.tagline}
          </p>
        </section>
      </main>

      <footer className="bg-[#111110] px-5 py-8 text-[#f3f0e8] sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-[#f04e23]">
            <SparkleMark />
            <span className="text-[18px] font-bold tracking-[-0.055em]">openmi</span>
          </span>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="landing-mono text-[9.5px] uppercase tracking-[0.16em] text-[#f3f0e8]/55 transition-colors hover:text-[#f3f0e8]"
              >
                {link.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={onStart}
              className="landing-mono text-[9.5px] uppercase tracking-[0.16em] text-[#f04e23] transition-colors hover:text-[#ff7a52]"
            >
              Sign in
            </button>
          </nav>
        </div>
        <p className="landing-mono mt-6 text-[9px] uppercase tracking-[0.14em] text-[#f3f0e8]/30">
          © {new Date().getFullYear()} {BRAND.name} · {BRAND.product}
        </p>
      </footer>
    </div>
  );
}

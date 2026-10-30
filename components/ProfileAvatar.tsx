"use client";

import { nameInitial } from "@/lib/visitorName";

// ── The profile picture ─────────────────────────────────────────────────────
//
// There is no upload any more. A picture was a settings screen the product did
// not need: the only place an avatar appears is a 32px circle in the sidebar and
// a 56px circle in Settings, and asking somebody to pick a file for that was
// more work than the feature was worth.
//
// What is left is generated, and it is the same picture every time because it is
// derived from the account rather than stored. A small hash of the seed picks
// one of a handful of plain two-tone fills, so two people in the same chat do
// not look alike while nobody has to choose anything. The initial is the one
// human part, and it follows a name change without any write.
//
// The seed is the account id when signed in and the display name otherwise. It
// is deliberately not random per render: an avatar that changed on every reload
// would read as a glitch, not as identity.

/** Plain, low-contrast pairs: the avatar is furniture, not a badge. */
const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["#4f7f66", "#27483a"],
  ["#5d6f8a", "#2c3a4d"],
  ["#7a6a8f", "#3a3149"],
  ["#8a7057", "#463526"],
  ["#5f7f86", "#2b4145"],
  ["#7d6b5a", "#3e332a"],
  ["#6b7a5c", "#333d2a"],
  ["#75657a", "#39303c"],
];

/** FNV-1a, small and stable: the same account gets the same colour everywhere. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

export default function ProfileAvatar({
  name,
  seed,
  size = 32,
  className = "",
}: {
  /** The name the question is about; its first letter is drawn. */
  name: string;
  /** What makes the picture this person's: the account id, or the name. */
  seed?: string | null;
  /** Pixel diameter. */
  size?: number;
  className?: string;
}) {
  const colours = PALETTE[hash(`${seed ?? ""}|${name}`) % PALETTE.length];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-white/10 ${className}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${colours[0]}, ${colours[1]})`,
      }}
    >
      <span
        className="font-semibold leading-none text-white/85"
        style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}
      >
        {nameInitial(name)}
      </span>
    </span>
  );
}

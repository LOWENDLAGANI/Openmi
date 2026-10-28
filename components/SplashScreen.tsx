"use client";

// ── The opening splash ─────────────────────────────────────────────────────
// Shown on top of the fully-rendered home page: the app mounts and loads in
// the background while this image sits over it, then blurs and dissolves away
// to reveal the ready app. Nothing about the app is blocked by this.
//
// It plays once per browser session, on a fresh visit to the app only. Returning
// to the page, reloading, or opening `/about` skips it — sessionStorage is the
// marker, so closing the tab gives the next visit its splash back.
//
// ── Two images, because a phone is not a small laptop ───────────────────────
// The splash fills the screen edge to edge, so the crop is driven entirely by
// the screen's shape. A 16:9 desktop image shown on a tall phone has to be
// cropped to roughly the middle third to cover it, and whatever is at the
// sides is simply gone — the branding is the first thing a visitor sees, so
// losing most of it is not acceptable. `object-position` can shift the crop
// but cannot invent the missing pixels.
//
// So the artwork is supplied twice: a portrait composition for narrow screens
// and the landscape one for everything wider. The swap is a `<source>` inside a
// `<picture>`, which the browser resolves from the media query before any of
// this paints — no measuring, no resize listener, no second render. Both files
// are asked for independently, so neither is downloaded unless it is chosen.

import { useEffect, useState } from "react";

/** Landscape artwork, used from 768px up. */
const DESKTOP_IMAGE = "/openmi-splash.jpg";

/** Portrait artwork, used below 768px. Falls back to the desktop one. */
const MOBILE_IMAGE = "/openmi-splash-mobile.jpg";

/** Shown if neither artwork is found, so a wrong filename never shows a gap. */
const FALLBACK_IMAGE = "/openmi-logo.png";

/** Where the `<picture>` element stops offering the portrait source. */
const WIDE_QUERY = "(min-width: 768px)";

const SESSION_KEY = "openmi:splash-seen";
const HOLD_MS = 1600; // image sits crisp while the app loads behind it
const FADE_MS = 1100; // blur + fade out

type Phase = "pending" | "hold" | "fade" | "gone";

/**
 * Which artwork to try next when one fails to load.
 *
 * A `<picture>` reports a failed `<source>` through the `<img>`'s error event,
 * but the event does not say which URL was attempted, so the fallback is a
 * fixed ladder rather than a comparison: the portrait source is simply dropped
 * from the markup, the browser re-resolves the media query against the desktop
 * file, and only after that does the logo come into play.
 */
function nextStage(stage: number): number {
  return Math.min(stage + 1, 2);
}


"use client";

import { useEffect, useRef } from "react";
import {
  AD_HEIGHT_DESKTOP,
  AD_HEIGHT_MOBILE,
  AD_MAX_WIDTH,
  ADSTERRA_BANNER_HEIGHT,
  ADSTERRA_BANNER_WIDTH,
  adsterraBannerKey,
  adsterraBannerSrc,
} from "@/lib/ads";

// ── The ad slot above the composer ───────────────────────────────────────────
// One tag, one reserved height, one network. The rules that keep it from being
// a nuisance are deliberate and belong next to the code that implements them:
//
//   • Nothing renders without a valid tag, so an unconfigured deployment shows
//     no gap rather than an empty box.
//   • The administrator's `adsEnabled` flag switches it off without a deploy.
//   • The height is reserved before the ad arrives. A late banner that shoves
//     the composer down is worse than no banner, so the box is the same size
//     whether the network fills it or not.
//   • No auto ads, no refresh on send, no second unit. This is the whole
//     placement.
//
// The screens it must not appear on — sign-in, temporary chats, Focus home —
// are conditions at the call site rather than here, because this component
// cannot know which screen it was dropped into.

interface AdBannerProps {
  /** The administrator's kill switch. False renders nothing, height included. */
  enabled?: boolean;
}

export default function AdBanner({ enabled = true }: AdBannerProps) {
  const src = adsterraBannerSrc();
  const key = adsterraBannerKey(src);
  const ready = enabled && Boolean(src) && Boolean(key);
  const holder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ready || !src || !key) return;
    const node = holder.current;
    if (!node || node.dataset.loaded === "true") return;
    node.dataset.loaded = "true";
    // invoke.js reads its configuration from the global below and injects the
    // iframe into the script's own parent, so the tag must live inside the
    // reserved box and nowhere else.
    const win = window as Window & { atOptions?: Record<string, unknown> };
    win.atOptions = {
      key,
      format: "iframe",
      height: ADSTERRA_BANNER_HEIGHT,
      width: ADSTERRA_BANNER_WIDTH,
      params: {},
    };
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.setAttribute("data-cfasync", "false");
    node.appendChild(script);
  }, [ready, src, key]);

  if (!ready) return null;

  return (
    <>
      {/* The two heights live in lib/ads.ts; this tag is the only bridge
          between them and the stylesheet, so they cannot drift. */}
      <style>{`@media (min-width: 768px) { .openmi-ad-slot { height: ${AD_HEIGHT_DESKTOP}px !important; } }`}</style>
      <div className="mx-auto w-full px-4 md:px-6" style={{ maxWidth: AD_MAX_WIDTH }}>
        <div
          className="openmi-ad-slot relative overflow-hidden rounded-lg border border-line/70 bg-card/40"
          style={{ height: AD_HEIGHT_MOBILE }}
          aria-label="Advertisement"
        >
          <span className="pointer-events-none absolute left-1 top-0.5 z-10 rounded bg-black/30 px-1 py-px font-mono text-[8px] uppercase leading-normal tracking-[0.1em] text-white/35">
            Ad
          </span>
          <div
            ref={holder}
            className="flex h-full w-full items-center justify-center"
            data-adsterra-banner="true"
          />
        </div>
      </div>
    </>
  );
}

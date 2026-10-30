"use client";

import { useCallback, useEffect, useRef } from "react";
import Script from "next/script";
import {
  AD_HEIGHT_DESKTOP,
  AD_HEIGHT_MOBILE,
  AD_MAX_WIDTH,
  ADSENSE_SCRIPT,
  adsenseClientId,
  adsenseSlotId,
} from "@/lib/ads";

// ── The ad slot above the composer ───────────────────────────────────────────
// One unit, one push, one reserved height. The rules that keep it from being a
// nuisance are deliberate and belong next to the code that implements them:
//
//   • Nothing renders without both env ids, so a deployment that has not
//     configured ads shows no gap at all.
//   • The administrator's `adsEnabled` flag can switch it off without a deploy.
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
  const client = adsenseClientId(process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID);
  const slot = adsenseSlotId(process.env.NEXT_PUBLIC_ADSENSE_SLOT_ID);
  const ready = enabled && Boolean(client) && Boolean(slot);
  const pushed = useRef(false);

  // One push per mount, whichever of the two paths below gets there first.
  const pushOnce = useCallback(() => {
    if (!ready || pushed.current) return;
    const win = window as Window & { adsbygoogle?: unknown[] };
    win.adsbygoogle = win.adsbygoogle ?? [];
    win.adsbygoogle.push({});
    pushed.current = true;
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    // A previous mount may have loaded the script already. If it did, its
    // onLoad will not fire again, so the unit is filled here instead.
    const win = window as Window & { adsbygoogle?: unknown[] };
    if (win.adsbygoogle) pushOnce();
  }, [ready, pushOnce]);

  if (!ready) return null;

  return (
    <>
      {/* The two heights live in lib/ads.ts; this tag is the only bridge
          between them and the stylesheet, so they cannot drift. */}
      <style>{`@media (min-width: 768px) { .openmi-ad-slot { height: ${AD_HEIGHT_DESKTOP}px !important; } }`}</style>
      <Script
        id="adsbygoogle-loader"
        src={`${ADSENSE_SCRIPT}?client=${client}`}
        strategy="afterInteractive"
        crossOrigin="anonymous"
        onLoad={pushOnce}
      />
      <div className="mx-auto w-full px-4 md:px-6" style={{ maxWidth: AD_MAX_WIDTH }}>
        <div
          className="openmi-ad-slot relative overflow-hidden rounded-lg border border-line/70 bg-card/40"
          style={{ height: AD_HEIGHT_MOBILE }}
          aria-label="Advertisement"
        >
          <span className="pointer-events-none absolute left-1 top-0.5 z-10 rounded bg-black/30 px-1 py-px font-mono text-[8px] uppercase leading-normal tracking-[0.1em] text-white/35">
            Ad
          </span>
          <ins
            className="adsbygoogle block h-full w-full"
            style={{ display: "block" }}
            data-ad-client={client ?? undefined}
            data-ad-slot={slot ?? undefined}
            data-ad-format="horizontal"
            data-full-width-responsive="false"
          />
        </div>
      </div>
    </>
  );
}

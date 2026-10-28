"use client";

import Script from "next/script";
import { adsterraPopunderSrc } from "@/lib/ads";

// ── The Adsterra popunder ────────────────────────────────────────────────────
// A popunder is not a banner and has no slot: the network opens an advertisement
// in a background window on its own schedule, usually after a click. So there is
// nothing to size, reserve or push here — only one script to load, and a
// decision about where it may load.
//
// That decision is the same one the banner obeys: the administrator's Ads switch,
// and the screens where an advertisement would contradict what the screen is
// for. The second half lives at the call site, because a component cannot know
// which screen it was dropped into.
//
// The tag URL comes whole from the Adsterra dashboard. Each zone gets its own
// host, so `NEXT_PUBLIC_ADSTERRA_POPUNDER_SRC` is the `src` attribute of the tag
// it prints, protocol-relative or absolute.

interface AdPopunderProps {
  /** The administrator's kill switch, shared with the banner. */
  enabled?: boolean;
}

export default function AdPopunder({ enabled = true }: AdPopunderProps) {
  const src = adsterraPopunderSrc();

  // No tag, or the switch is off: nothing is added to the document at all.
  // A popunder that loads "just in case" is the worst version of this ad.
  if (!enabled || !src) return null;

  return (
    <Script
      id="adsterra-popunder"
      src={src}
      // After the page is interactive, never before: the composer is the reason
      // someone is here, and it must not wait on an ad network.
      strategy="afterInteractive"
    />
  );
}

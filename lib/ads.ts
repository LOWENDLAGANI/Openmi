// ── Advertising ──────────────────────────────────────────────────────────────
// One small AdSense unit above the composer, and nothing else: no auto ads, no
// second placement, no other network, no refresh on send. The decisions that keep it
// from damaging the product live here as numbers, so the banner and the tests
// cannot disagree about the space it reserves.
//
// Nothing in this module is a secret. A publisher id is printed in every page
// that shows an ad, so it is public by design; the ad unit's slot id is equally
// public. A deployment with neither renders no banner at all rather than an
// empty box asking to be filled.

/** The AdSense loader. Loaded once, lazily, and only when a unit will render. */
export const ADSENSE_SCRIPT = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";

/**
 * The height reserved for the slot, in CSS pixels.
 *
 * Reserved up front, not measured after the ad arrives: a banner that loads
 * late and pushes the composer is worse than no banner. These two numbers are
 * the only place the height is written down.
 */
export const AD_HEIGHT_MOBILE = 50;
export const AD_HEIGHT_DESKTOP = 60;

/** An AdSense horizontal unit's comfortable width. Centered inside a wider column. */
export const AD_MAX_WIDTH = 728;

/** A publisher id, as the account prints it, or null. */
export function adsenseClientId(value: string | null | undefined = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID): string | null {
  const id = (value ?? "").trim();
  return /^ca-pub-\d{10,20}$/.test(id) ? id : null;
}

/** An ad unit's slot id, as the console prints it, or null. */
export function adsenseSlotId(value: string | null | undefined = process.env.NEXT_PUBLIC_ADSENSE_SLOT_ID): string | null {
  const id = (value ?? "").trim();
  return /^\d{8,20}$/.test(id) ? id : null;
}

/** Both ids present is the only condition under which a unit can render. */
export function adsenseConfigured(
  clientId: string | null | undefined = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID,
  slotId: string | null | undefined = process.env.NEXT_PUBLIC_ADSENSE_SLOT_ID
): boolean {
  return Boolean(adsenseClientId(clientId) && adsenseSlotId(slotId));
}

/**
 * The body of `/ads.txt`, derived from the client id.
 *
 * AdSense verifies the domain by reading this file. It is generated rather than
 * committed so a deployment cannot advertise a publisher it does not use, and
 * the account id appears in exactly one variable. Google's certification
 * authority id (`f08c47fec0942fa0`) is fixed for AdSense.
 */
export function adsTxt(clientId: string | null | undefined): string | null {
  const id = adsenseClientId(clientId);
  if (!id) return null;
  const publisher = id.replace(/^ca-/, "");
  return `google.com, ${publisher}, DIRECT, f08c47fec0942fa0\n`;
}

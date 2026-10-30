// ── Advertising ──────────────────────────────────────────────────────────────
// One small AdSense unit above the composer, and nothing else: no auto ads, no
// second placement, no refresh on send. The decisions that keep it from
// damaging the product live here as numbers, so the banner and the tests cannot
// disagree about the space it reserves.
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
// ── Adsterra popunder ────────────────────────────────────────────────────────
// A popunder is not a slot. There is no box to size and nothing to reserve: the
// network loads one script and decides for itself when to open an advertisement
// in a background window. What this module can still decide is whether that
// script is allowed to exist at all, and which host the security policy must
// name for it.
//
// The URL is taken whole from the Adsterra dashboard rather than assembled from
// parts, because each zone is assigned its own host. A hard-coded host would
// work for exactly one account.

/**
 * The popunder tag's `src`, normalised, or null when it is not a script URL.
 *
 * Adsterra prints the tag protocol-relative (`//pl….com/….js`), which is
 * correct in an HTML document and ambiguous in a `next/script` src, so it is
 * made absolute here. A value that is not a JavaScript URL is refused rather
 * than loaded: this string ends up in a script tag and in the CSP, so it is
 * validated the way any other untrusted input is.
 */
export function adsterraPopunderSrc(
  value: string | null | undefined = process.env.NEXT_PUBLIC_ADSTERRA_POPUNDER_SRC
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!/\.js$/i.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The origin the CSP has to allow for that script, e.g. https://pl1….com. */
export function adsterraPopunderOrigin(
  src: string | null | undefined = adsterraPopunderSrc()
): string | null {
  if (!src) return null;
  try {
    return new URL(src).origin;
  } catch {
    return null;
  }
}

/** True when this deployment has a popunder tag to load. */
export function adPopunderConfigured(
  src: string | null | undefined = process.env.NEXT_PUBLIC_ADSTERRA_POPUNDER_SRC
): boolean {
  return adsterraPopunderSrc(src) !== null;
}

export function adsTxt(clientId: string | null | undefined): string | null {
  const id = adsenseClientId(clientId);
  if (!id) return null;
  const publisher = id.replace(/^ca-/, "");
  return `google.com, ${publisher}, DIRECT, f08c47fec0942fa0\n`;
}

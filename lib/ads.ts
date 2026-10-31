// ── Advertising ──────────────────────────────────────────────────────────────
// One small banner above the composer, and nothing else: no auto ads, no second
// placement, no other network, no refresh on send. The decisions that keep it
// from damaging the product live here as numbers, so the banner and the tests
// cannot disagree about the space it reserves.
//
// Nothing in this module is a secret. An Adsterra zone key is printed in the
// page that shows the ad, so it is public by design. A deployment with no tag
// renders no banner at all rather than an empty box.

/**
 * The height reserved for the slot, in CSS pixels.
 *
 * Reserved up front, not measured after the ad arrives: a banner that loads
 * late and pushes the composer is worse than no banner. These two numbers are
 * the only place the height is written down.
 */
export const AD_HEIGHT_MOBILE = 50;
export const AD_HEIGHT_DESKTOP = 60;

/** The widest the slot ever gets. Centered inside a wider column. */
export const AD_MAX_WIDTH = 728;

// ── The Adsterra banner ──────────────────────────────────────────────────────
// The tag is the `src` Adsterra prints (`//host/<key>/invoke.js`), taken whole,
// and the zone key is read back out of the path rather than kept in a second
// variable that could disagree with it. The size is fixed at 320×50 because the
// reserved slot is 50 px tall: a taller unit would be clipped, and a wider one
// would overflow a phone. A 320×50 zone is one Adsterra offers.
export const ADSTERRA_BANNER_WIDTH = 320;
export const ADSTERRA_BANNER_HEIGHT = 50;

/**
 * The banner tag's `src`, normalised, or null when it is not a usable script.
 *
 * Adsterra prints the tag protocol-relative (`//host/…/invoke.js`), which is
 * correct in an HTML document and ambiguous in a script `src`, so it is made
 * absolute here. This string ends up in a script tag and in the CSP, so it is
 * validated the way any other untrusted input is: http(s) only, a `.js` path,
 * and a key that looks like a zone key.
 */
export function adsterraBannerSrc(
  value: string | null | undefined = process.env.NEXT_PUBLIC_ADSTERRA_BANNER_SRC
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!/\.js$/i.test(url.pathname)) return null;
    if (!adsterraBannerKey(url.toString())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The zone key, taken from the tag's own path (`…/<key>/invoke.js`), or null.
 *
 * Deriving it means one variable cannot disagree with another: pasting the tag
 * Adsterra prints is the whole configuration.
 */
export function adsterraBannerKey(src: string | null | undefined = adsterraBannerSrc()): string | null {
  if (!src) return null;
  try {
    const segments = new URL(src).pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const key = segments[segments.length - 2];
    return /^[a-z0-9]{8,64}$/i.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** The origin the CSP has to allow for that tag, e.g. https://host. */
export function adsterraBannerOrigin(src: string | null | undefined = adsterraBannerSrc()): string | null {
  if (!src) return null;
  try {
    return new URL(src).origin;
  } catch {
    return null;
  }
}

/** True when this deployment has a banner tag to load. */
export function adsterraBannerConfigured(
  src: string | null | undefined = process.env.NEXT_PUBLIC_ADSTERRA_BANNER_SRC
): boolean {
  return adsterraBannerSrc(src) !== null;
}

// ── Reading the Realtime Database as the caller ──────────────────────────────
//
// The deployment holds no service account, so every privileged read is made
// with the caller's own verified Firebase token and judged by
// database.rules.json exactly as the browser would be. `writeAsCaller` in
// lib/serverControl.ts is the other half of this; this module exists so a
// read does not have to be re-implemented in every route.
//
// A failed read is `null`, never an empty object: the difference between
// "there is nothing here" and "I could not look" matters to the caller, and an
// empty object would quietly turn a permissions failure into a missing
// project.

const databaseUrl = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL?.trim() ?? "";

function restBase(): string | null {
  return databaseUrl ? databaseUrl.replace(/\/+$/, "") : null;
}

/** True when the deployment has a database configured at all. */
export const rtdbConfigured = Boolean(restBase());

/** Reads one path with the caller's token. Null on any refusal or failure. */
export async function readAsCaller<T = unknown>(
  authorization: string | null,
  path: string
): Promise<T | null> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  const base = restBase();
  if (!token || !base) return null;

  try {
    const response = await fetch(`${base}/${path}.json?auth=${encodeURIComponent(token)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as T | null;
  } catch {
    return null;
  }
}

/** Deletes one path with the caller's token. */
export async function deleteAsCaller(authorization: string | null, path: string): Promise<boolean> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  const base = restBase();
  if (!token || !base) return false;

  try {
    const response = await fetch(`${base}/${path}.json?auth=${encodeURIComponent(token)}`, {
      method: "DELETE",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

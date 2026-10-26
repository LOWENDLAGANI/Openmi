import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, rateLimitRefusal, verifyCaller } from "@/lib/serverControl";
import { isUserKeyProvider, keyHint, keyProblem } from "@/lib/providerKeyState";
import {
  deleteUserKey,
  listUserKeys,
  providerKeyStoreConfigured,
  saveUserKey,
  validateProviderKey,
} from "@/lib/providerKeys";

// ── The model keys this account brought itself ──────────────────────────────
//
// A key in, a hint out. The response never contains a key, not even the one
// that was just saved: the browser has no use for it after the round trip, and a
// value that never travels cannot be read out of a page, a log or a screenshot.
//
// Saving is three steps and each one can refuse: the shape (a prefix and a
// length, so a GitHub token pasted into the Gemini field is caught before a
// request), the vendor (one list call, so a key that does not work is not stored
// as if it did), and the database. The order matters — nothing sealed is
// written until the vendor has said the key works.
//
// Every handler is scoped to the verified caller. There is no route here that
// takes a uid from the request, and no administrative branch: the only person
// who may change a key is the person whose key it is.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to see your keys." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "keys");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many requests. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const keys = await listUserKeys(authorization, identity.uid);
  return Response.json(
    {
      keys,
      storeReady: providerKeyStoreConfigured(),
      // Which providers the deployment itself can reach. Presence only: a key
      // is never named here, and the account uses this to know whether removing
      // its own key leaves the mode working or not.
      deployment: {
        openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
        gemini: Boolean(process.env.GEMINI_API_KEY?.trim()),
        groq: Boolean(process.env.GROQ_API_KEY?.trim()),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to save a key." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "keys");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many key changes. Try again in ${limit.retryAfterSeconds}s.`);
  }

  let body: { provider?: unknown; key?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown; key?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isUserKeyProvider(body.provider)) {
    return Response.json({ error: "That is not a provider this deployment can use." }, { status: 400 });
  }
  if (typeof body.key !== "string") {
    return Response.json({ error: "Paste the key first." }, { status: 400 });
  }

  const key = body.key.trim();
  const problem = keyProblem(body.provider, key);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  if (!providerKeyStoreConfigured()) {
    return Response.json(
      {
        error:
          "This deployment cannot store a key: set GITHUB_TOKEN_KEY (32 bytes of hex) and redeploy. The same key seals stored credentials.",
      },
      { status: 503 }
    );
  }

  const checked = await validateProviderKey(body.provider, key);
  if (!checked.ok) return Response.json({ error: checked.message }, { status: 400 });

  const saved = await saveUserKey(authorization, identity.uid, body.provider, key);
  if (!saved) {
    return Response.json(
      {
        error:
          "The key could not be saved. Check the `provider_keys` policies in the Supabase project — migration 20261026000000_provider_keys.sql creates them.",
      },
      { status: 503 }
    );
  }

  return Response.json(
    {
      key: { provider: body.provider, hint: keyHint(key), updatedAt: Date.now() },
      message: checked.message,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function DELETE(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to remove a key." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "keys");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many key changes. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const provider = new URL(req.url).searchParams.get("provider");
  if (!isUserKeyProvider(provider)) {
    return Response.json({ error: "That is not a provider this deployment can use." }, { status: 400 });
  }

  const removed = await deleteUserKey(authorization, identity.uid, provider);
  if (!removed) {
    return Response.json(
      { error: "The key could not be removed. Try again in a moment." },
      { status: 503 }
    );
  }

  return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
}

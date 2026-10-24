import { NextRequest } from "next/server";
import { checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { clientForToken } from "@/lib/supabase";
import { isShareId, shareErrorMessage } from "@/lib/share";

// ── Taking a link back ──────────────────────────────────────────────────────
//
// Revoking is an update, not a delete: the row stays for the owner's history and
// for the audit, while `shared_public` stops answering it on the next read. Only
// the owner's token is used, and the policy repeats the ownership check, so a
// guessed id cannot be revoked by somebody else.
//
// The reader's route is deliberately not here. `/share/[id]` is a public page
// that reads the projection; this file only answers the person who owns the
// link.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to revoke a link." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 60, "share-revoke");
  if (!limit.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const { id } = await context.params;
  if (!isShareId(id)) {
    return Response.json({ error: "That link does not exist." }, { status: 404 });
  }

  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = clientForToken(token);
  if (!client) {
    return Response.json({ error: "Sharing needs a configured Supabase project." }, { status: 503 });
  }

  try {
    const { data, error } = await client
      .from("shared_chats")
      .update({ revoked: true })
      .eq("id", id)
      .eq("owner", identity.uid)
      .select("id");
    if (error) {
      return Response.json({ error: shareErrorMessage(error) }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return Response.json({ error: "That link does not exist." }, { status: 404 });
    }
    return Response.json({ revoked: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return Response.json({ error: shareErrorMessage(cause) }, { status: 500 });
  }
}

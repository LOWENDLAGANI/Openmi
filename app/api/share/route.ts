import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { checkRateLimit, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { clientForToken } from "@/lib/supabase";
import {
  SHARE_TTL_DAYS,
  buildShareSnapshot,
  isShareId,
  shareErrorMessage,
  type ShareSummary,
} from "@/lib/share";

// ── Publishing one answer ────────────────────────────────────────────────────
//
// POST is the only way a share is created: the server reads the caller's
// verified identity, takes the snapshot, generates an unguessable id and writes
// it with the caller's own token. The RLS policy still checks that the owner is
// the caller, so a modified client cannot write a share under another account.
//
// GET lists only the caller's own shares, for the management screen. A reader
// never comes through here — they use /share/[id] and the public view, which has
// no owner column at all.
//
// The body is a snapshot, not a chat id. A live chat would silently change what
// a link shows; a copy is fixed at the moment it is shared, which is what makes
// revocation meaningful.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

function epoch(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export async function POST(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to share an answer." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "share-create");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, "Too many links created. Try again later.");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "The share could not be read." }, { status: 400 });
  }

  const snapshot = buildShareSnapshot(body);
  if (!snapshot) {
    return Response.json(
      { error: "A share needs one to forty messages of text." },
      { status: 400 }
    );
  }

  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = clientForToken(token);
  if (!client) {
    return Response.json({ error: "Sharing needs a configured Supabase project." }, { status: 503 });
  }

  const id = randomUUID().replace(/-/g, "");
  if (!isShareId(id)) {
    return Response.json({ error: "The link could not be generated." }, { status: 500 });
  }
  const expiresAt = new Date(Date.now() + SHARE_TTL_DAYS * DAY_MS).toISOString();

  try {
    const { error } = await client.from("shared_chats").insert({
      id,
      owner: identity.uid,
      title: snapshot.title,
      messages: snapshot.messages,
      expires_at: expiresAt,
    });
    if (error) {
      return Response.json(
        { error: shareErrorMessage(error) },
        { status: error.code === "PGRST205" || error.code === "42P01" ? 503 : 500 }
      );
    }
  } catch (cause) {
    return Response.json({ error: shareErrorMessage(cause) }, { status: 500 });
  }

  return Response.json({ id, expiresAt }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to manage your shared links." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "share-list");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, "Too many requests. Try again shortly.");
  }

  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = clientForToken(token);
  if (!client) {
    return Response.json({ shares: [] as ShareSummary[] });
  }

  try {
    const { data, error } = await client
      .from("shared_chats")
      .select("id, title, created_at, expires_at, revoked")
      .eq("owner", identity.uid)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      return Response.json(
        { error: shareErrorMessage(error), shares: [] as ShareSummary[] },
        { status: error.code === "PGRST205" || error.code === "42P01" ? 503 : 500 }
      );
    }

    const shares: ShareSummary[] = ((data ?? []) as Record<string, unknown>[])
      .filter((row) => isShareId(row.id))
      .map((row) => ({
        id: String(row.id),
        title: typeof row.title === "string" ? row.title : "Shared answer",
        createdAt: epoch(row.created_at),
        expiresAt: epoch(row.expires_at),
        revoked: row.revoked === true,
      }));

    return Response.json({ shares }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return Response.json({ error: shareErrorMessage(cause), shares: [] }, { status: 500 });
  }
}

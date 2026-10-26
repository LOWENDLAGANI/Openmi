import { NextRequest } from "next/server";
import { normalizeConfig, type AppConfig } from "@/lib/appConfig";
import {
  checkRateLimit,
  invalidateConfig,
  isAdmin,
  rateLimitRefusal,
  requireAdmin,
  serverControlsConfigured,
  verifyCaller,
  writeAppConfig,
} from "@/lib/serverControl";

// ── Administrator-only control surface ──────────────────────────────────────
// Read by anyone, because the public policy allows it and the server needs it to
// enforce. Written only by the administrator: the request must carry a Supabase
// access token, the token is verified against the project, and the write is then
// performed with that same token so the row-level security policies make the
// final decision rather than this file.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The administrator's address, as the server sees it.
 *
 * The policies remain the source of truth: the write below is made with the
 * caller's own token, so Postgres compares the address itself. This value only
 * lets the route refuse early with a clear message, and a mismatch between the
 * two shows up as a refused write rather than a silent success.
 */
function configuredAdminEmail(): string {
  return process.env.OPENMI_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!serverControlsConfigured) {
    return Response.json({ error: "Controls are not configured in this deployment." }, { status: 503 });
  }

  // The client needs to know whether *this* browser is the administrator,
  // because maintenance mode has to let the administrator in while refusing
  // everyone else. The answer is the server's, never the page's.
  const identity = await verifyCaller(req.headers.get("authorization"));
  // The one row every control reads, and a route that answers anyone. A
  // signed-in caller spends their own bucket; a stranger spends their IP's.
  const limit = await checkRateLimit(req, identity, "admin");
  if (!limit.allowed) return rateLimitRefusal(limit);

  return Response.json({
    adminEmailConfigured: Boolean(configuredAdminEmail()),
    isAdmin: isAdmin(identity),
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  if (!serverControlsConfigured) {
    return Response.json({ error: "Controls are not configured in this deployment." }, { status: 503 });
  }

  // The same gate every admin-only route uses, so the console behaves the same
  // way whichever control it reaches for.
  const admin = await requireAdmin(req.headers);
  if (!admin.allowed) {
    return Response.json({ error: admin.error }, { status: admin.status });
  }
  const authorization = req.headers.get("authorization");

  // A write to the controls table: no browser tab needs to do this in a loop.
  // The identity was verified above, so this spends the administrator's own
  // bucket rather than their address's.
  const limit = await checkRateLimit(req, admin.identity ?? null, "admin");
  if (!limit.allowed) return rateLimitRefusal(limit);

  let body: Partial<AppConfig>;
  try {
    body = (await req.json()) as Partial<AppConfig>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Normalise before writing so a bad value is corrected rather than stored and
  // then trusted by the enforcement path.
  const next: AppConfig = { ...normalizeConfig(body), updatedAt: Date.now() };
  // The console knows what it meant to ban; the server records who actually
  // did it and when, from the token it just verified. The metadata in the ban
  // list is therefore the server's, not a stale or edited client value.
  const now = Date.now();
  next.bans = next.bans.map((ban) => ({
    ...ban,
    bannedAt: ban.bannedAt > 0 ? ban.bannedAt : now,
    bannedBy: ban.bannedBy || admin.identity.email || "unknown",
  }));
  const written = await writeAppConfig(authorization, next);
  if (!written) {
    return Response.json(
      {
        error:
          "The database refused the write. Check that the address seeded in `app_admin` matches `OPENMI_ADMIN_EMAIL`.",
      },
      { status: 403 }
    );
  }

  invalidateConfig();
  return Response.json({ ok: true, config: next });
}

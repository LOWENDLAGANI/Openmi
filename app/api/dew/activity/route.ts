import { NextRequest } from "next/server";
import { checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { resolveDew } from "@/lib/serverRedeem";
import { readDewCredits, readDewTransactions } from "@/lib/serverDew";
import { summarizeDewActivity } from "@/lib/dewActivity";

// ── Why the balance moved ────────────────────────────────────────────────────
//
// The balance route answers "how much". This one answers "where did it go" from
// the rows the ledger already keeps, with the caller's own token: the policies
// decide which rows those are, and the aggregation is pure code shared with the
// tests.
//
// The same 30-day window is applied to charges and credits, and the account's
// own timezone decides where a day starts — the same midnight that refills the
// free bucket. A browser in another country therefore sees the days the account
// actually lived in, not the ones its current clock happens to be in.
//
// Read only. Nothing here can move a balance; a response is a report.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to see your Dew activity." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 30, "dew-activity");
  if (!limit.allowed) {
    return Response.json({ error: "Too many activity checks. Try again shortly." }, { status: 429 });
  }

  const now = Date.now();
  const since = now - WINDOW_DAYS * DAY_MS;
  const [state, charges, credits] = await Promise.all([
    resolveDew(authorization, identity.uid),
    readDewTransactions(authorization, identity.uid, since),
    readDewCredits(authorization, identity.uid, since),
  ]);

  return Response.json(
    {
      balance: state.balance,
      dailyRemaining: state.dailyRemaining,
      timeZone: state.timeZone,
      activity: summarizeDewActivity(charges, credits, {
        now,
        timeZone: state.timeZone,
        windowDays: WINDOW_DAYS,
      }),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

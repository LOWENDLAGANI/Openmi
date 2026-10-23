// ── Delete my data ───────────────────────────────────────────────────────────
// The visitor's own eraser. It clears every local table, tells the account
// sync that these chats are gone so the next pull cannot hand them back, and
// removes this identity's rows from the database with the visitor's own token —
// the policies already allow an owner to write their own rows, so this needs no
// credential and no admin involvement.
//
// One thing it deliberately keeps: the Dew ledger. Paid-for credits belong to the
// person, not to the chat history, and an eraser that silently ate a top-up would
// be the kind of "privacy" feature that generates support mail — which is why
// `dew_credits` and `dew_wallets` are simply not on the list of tables below.

import { db } from "./db";
import { syncChatWipe } from "./cloudHistory";
import { ensureUser, getSupabase } from "./supabase";

export interface DeleteDataResult {
  /** The local wipe always runs; false only if Dexie itself refused. */
  local: boolean;
  /** How many remote paths were removed, for the sentence in Settings. */
  remote: number;
}

export async function deleteAllMyData(): Promise<DeleteDataResult> {
  // The deletion marker goes down before the local rows vanish: if the clear
  // is interrupted halfway, the next sync must not restore what was being
  // deleted into a browser that just asked for it to be gone.
  await syncChatWipe().catch(() => undefined);

  // Dexie's transaction type takes at most five tables, so the wipe is two
  // transactions rather than one. The conversations go first — they are the
  // thing being deleted — and the trash follows.
  await db.transaction("rw", db.chats, db.messages, db.folders, async () => {
    await db.messages.clear();
    await db.chats.clear();
    await db.folders.clear();
  });
  await db.transaction("rw", db.trash, async () => {
    await db.trash.clear();
  });

  let remote = 0;
  const client = getSupabase();
  // Anonymous or signed in, the data lives under whatever id this browser
  // holds — and the policies let that id clear exactly its own rows.
  const user = client ? await ensureUser() : null;
  if (client && user) {
    // The registry row has no SELECT grant, so a direct delete would silently
    // match nothing — the one door is the function that scopes itself.
    try {
      const { error } = await client.rpc("forget_visitor");
      if (!error) remote += 1;
    } catch {
      // See below: the local wipe stands on its own.
    }

    // Chat messages first: a chat row that outlives its messages opens as an
    // empty thread, which reads as data loss. The rest is order-independent.
    for (const table of [
      "chat_messages",
      "chats",
      "memories",
      "github_connections",
      "github_default",
      "github_links",
      "projects",
      "changesets",
      "approvals",
      "commits",
      "usage_daily",
      "push_subscriptions",
    ]) {
      try {
        const { error } = await client.from(table).delete().eq("owner", user.id);
        if (!error) remote += 1;
      } catch {
        // Offline, or the table is not there. The local wipe stands on its own;
        // a partial remote removal is reported as such.
      }
    }
  }

  return { local: true, remote };
}

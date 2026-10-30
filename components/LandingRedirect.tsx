"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import OpenmiLanding from "./OpenmiLanding";
import { getSupabase, currentUser } from "@/lib/supabase";

// ── The front door, for a browser that already has an account ────────────────
//
// Openmi has no guest mode: the product is the chat, and it lives at /chat
// behind its own account gate. `/` is the marketing page, which is right for a
// first visit and wrong for everybody who already signed in — they were being
// shown a pitch for a product they were already using, with the chat one click
// away.
//
// The decision has to be made in the browser: the session lives in this tab's
// storage, so the server render that makes `/` crawlable cannot know it. The
// page therefore still renders the landing markup on the server, and this
// wrapper replaces it the moment a session is found. Two sources are watched,
// because there are two ways to become signed in while standing here:
//
//   * the stored session a returning visitor arrives with (the initial read);
//   * a round trip that finishes in this tab — `detectSessionInUrl` exchanges
//     the provider's code on mount, and `SIGNED_IN` fires after it.
//
// While the redirect is in flight nothing of the landing page is left
// interactive: a signed-in person should not be able to press a "Get started"
// button that signs them up for the account they already have.

export default function LandingRedirect() {
  const router = useRouter();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // `replace`, not `push`: Back from the chat should leave Openmi or return to
    // wherever the person came from, not bounce them into a page they were
    // redirected away from a moment ago.
    const go = () => {
      if (cancelled) return;
      setRedirecting(true);
      router.replace("/chat");
    };

    void currentUser()
      .then((user) => {
        if (user) go();
      })
      .catch(() => {
        // No answer is not a session: the landing page stays, and the chat's
        // own gate will ask again if they follow a link to it.
      });

    const client = getSupabase();
    const { data } = client?.auth.onAuthStateChange((event, session) => {
      if (session?.user && event !== "SIGNED_OUT") go();
    }) ?? { data: null };

    return () => {
      cancelled = true;
      data?.subscription.unsubscribe();
    };
  }, [router]);

  if (redirecting) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#060a08] px-6 text-white">
        <div className="flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden="true"
            className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-[#a9d8bb]"
          />
          <p className="text-[13px] text-white/55">Opening Openmi…</p>
          <p className="text-[11.5px] text-white/30">You are signed in, so this goes straight to your chats.</p>
        </div>
      </div>
    );
  }

  return <OpenmiLanding />;
}

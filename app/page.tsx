import type { Metadata } from "next";
import LandingRedirect from "@/components/LandingRedirect";

// ── The front door ──────────────────────────────────────────────────────────
// The marketing page is the root route and is rendered on the server, so a
// crawler and a cold visitor both get the real page in the first response
// instead of a client-side gate that paints a splash first. The product lives
// at /chat, behind its own account check.
//
// The landing markup is still what the server sends, but a browser that already
// holds a session is replaced with the chat by LandingRedirect. Marketing is for
// people who have not signed in; showing it to somebody who has is a page
// between them and the thing they came back for.

const TITLE = "Openmi — Your repository, with a reviewer built in.";
const DESCRIPTION =
  "Openmi reads a repository and proposes the change. You review the diff, then approve the commit on an agent branch.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Openmi",
    title: TITLE,
    description: DESCRIPTION,
},
};

export default function LandingPage() {
  return <LandingRedirect />;
}

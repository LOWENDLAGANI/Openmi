import type { Metadata } from "next";
import OpenmiLanding from "@/components/OpenmiLanding";

// ── The front door ──────────────────────────────────────────────────────────
// The marketing page is the root route and is rendered on the server, so a
// crawler and a cold visitor both get the real page in the first response
// instead of a client-side gate that paints a splash first. The product lives
// at /chat, behind its own account check.

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
    images: [{ url: "/openmi-splash.jpg", alt: "Openmi" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/openmi-splash.jpg"],
  },
};

export default function LandingPage() {
  return <OpenmiLanding />;
}

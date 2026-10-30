import type { Metadata } from "next";
import type { ReactNode } from "react";

// The product is behind the account gate, so it is deliberately not indexed:
// `/` is the page a crawler should read, and a search result that lands on a
// sign-in form is a bad result.
export const metadata: Metadata = {
  title: "Openmi",
  robots: { index: false, follow: false },
};

export default function ChatLayout({ children }: { children: ReactNode }) {
  return children;
}

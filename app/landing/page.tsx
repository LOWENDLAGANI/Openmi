import { Metadata } from "next";
import LandingEntry from "@/components/LandingEntry";

export const metadata: Metadata = {
  title: "Openmi — Your repository, with a reviewer built in.",
  description:
    "Openmi reads a repository and proposes the change. You review the diff, then approve the commit on an agent branch.",
};

export default function LandingPage() {
  return <LandingEntry />;
}

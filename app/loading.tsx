// ── Route loading ────────────────────────────────────────────────────────────
// Shown while a route's own JS and data are still arriving. It uses the
// full-screen spinner — the droplet with its orbiting bead — so a page change
// reads as one continuous product rather than handing off to a generic
// browser spinner.

import Spinner from "@/components/Spinner";

export default function Loading() {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-[#060a08]">
      <Spinner variant="dew" size={34} label="Loading" className="text-[#a9d8bb]" />
    </div>
  );
}

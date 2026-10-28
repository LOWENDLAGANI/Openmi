import type { ReactNode } from "react";
import "../../app/globals.css";

export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      {children}
    </div>
  );
}

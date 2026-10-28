// ── The spinner ──────────────────────────────────────────────────────────────
// One shape per level of the product, so a wait looks like the thing that is
// waiting:
//
//   "arc"   — the default. A thin hour hand sweeping with a gap, legible at 14px
//             inside a button and at 40px on its own.
//   "pulse" — the thread's three breathing dots, the language the conversation
//             already speaks while an answer is being written.
//   "dew"   — the droplet with an orbiting bead, for a whole screen: the route
//             loader and the boot states.
//
// It is deliberately not a client component: `app/loading.tsx` is a server
// component, and marking this file "use client" would make the route's loading
// UI a separate client boundary for no reason. The animation lives in
// globals.css with the rest of the motion system, draws in `currentColor` so a
// themed control colours it for free, and stops under `prefers-reduced-motion`.

export type SpinnerVariant = "arc" | "pulse" | "dew";

export interface SpinnerProps {
  variant?: SpinnerVariant;
  /** Side length in pixels; also the em base for the shapes inside it. */
  size?: number;
  /** Announced to assistive technology. Without it the spinner is decorative. */
  label?: string;
  className?: string;
}

export default function Spinner({ variant = "arc", size = 16, label, className = "" }: SpinnerProps) {
  const classes = ["spinner", `spinner-${variant}`, className].filter(Boolean).join(" ");
  const style = { width: size, height: size, fontSize: size };
  const a11y = {
    role: label ? ("status" as const) : undefined,
    "aria-label": label,
    "aria-hidden": label ? undefined : true,
  };

  if (variant === "pulse") {
    return (
      <span className={classes} style={style} {...a11y}>
        <i />
        <i />
        <i />
      </span>
    );
  }

  if (variant === "dew") {
    return (
      <span className={classes} style={style} {...a11y}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3c0 0-6.5 7.2-6.5 11.5a6.5 6.5 0 0 0 13 0C18.5 10.2 12 3 12 3Z" />
        </svg>
        <span className="spinner-dew-orbit" aria-hidden="true">
          <i />
        </span>
      </span>
    );
  }

  return <span className={classes} style={style} {...a11y} />;
}

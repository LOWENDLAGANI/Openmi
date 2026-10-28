"use client";

import { useEffect, useRef } from "react";

function LandingMarkSvg() {
  return (
    <svg
      viewBox="0 0 48 48"
      className="relative h-full w-full overflow-visible will-change-transform"
      aria-hidden
    >
      <defs>
        <linearGradient id="landing-mark" x1="8" y1="6" x2="40" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d7f0e1" />
          <stop offset="0.5" stopColor="#6ec294" />
          <stop offset="1" stopColor="#1f4a33" />
        </linearGradient>
      </defs>
      <path
        d="M24 3.5c2.3 9.3 4.7 11.7 14 14-9.3 2.3-11.7 4.7-14 14-2.3-9.3-4.7-11.7-14-14 9.3-2.3 11.7-4.7 14-14Z"
        fill="url(#landing-mark)"
      />
      <path
        d="M15.5 29.5V18l8.5 7 8.5-7v11.5"
        fill="none"
        stroke="#0b1310"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.2"
      />
    </svg>
  );
}

export default function LandingMark() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onEnter = () => el.setAttribute("data-reveal", "1");
    if (el.getBoundingClientRect().top < window.innerHeight) {
      onEnter();
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onEnter();
          observer.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-reveal="0"
      className="animate-stagger flex flex-col items-center gap-2"
      style={{ "--delay": 0 } as React.CSSProperties & { "--delay"?: number }}
    >
      <div className="animate-fade-block h-16 w-16 animate-mark-bounce">
        <LandingMarkSvg />
      </div>
    </div>
  );
}

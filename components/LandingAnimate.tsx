"use client";

import { useEffect, useRef } from "react";

type StaggerStyle = React.CSSProperties & { "--delay"?: number };

/** A thin wrapper for landing/marketing sections that reveals themselves on
 * first visibility.
 *
 * Used sparingly. Premium sites feel expensive because a few sections move
 * well, not because every block is animated.
 */
export function LandingSection({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: StaggerStyle;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inlineStyle: React.CSSProperties & { "--delay"?: number } = {
    ...style,
    "--delay": style?.["--delay"] ?? 0,
  };

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
      { threshold: 0.2 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-reveal="0"
      className={`animate-fade-block ${className}`}
      style={inlineStyle}
    >
      {children}
    </div>
  );
}

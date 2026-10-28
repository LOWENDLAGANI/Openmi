"use client";

// ── Service worker registration ─────────────────────────────────────────────
// The worker is what lets the site open something sensible when the network is
// gone: it caches the manifest, the icons and a navigation fallback, and it
// deliberately never caches build output (public/sw.js explains why).
//
// Openmi no longer offers to install itself, so nothing here waits for the
// worker to take control or announces when it does. Registering it is the whole
// job.
//
// Registration is skipped in development. A cached worker would serve stale
// modules to a dev server that is actively recompiling, which looks exactly
// like a broken change and costs far more time than it saves.

import { useEffect } from "react";

export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // Registering after load keeps the worker off the critical path, so it can
    // never delay the first paint of the chat.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
        // A failed registration costs the offline fallback, nothing else. The
        // app is fully usable in a browser tab without it.
        console.error("[Openmi] Service worker registration failed", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}

// ── What this deployment is missing ──────────────────────────────────────────
//
// Every feature in Openmi is optional: with no key the app shows a setup notice
// rather than crashing, which is what makes it possible for one build to be
// complete and another empty. The cost of that is that a half-configured
// deployment fails quietly — a mode that cannot answer, a search that is
// silently off, a GitHub button that opens a panel which says nothing useful.
//
// This module is the answer to "what did I forget?". It names each key, says
// what stops working without it, and says where the value comes from. Two rules
// it holds to:
//
//   1. **Presence only.** A key is reported as set or unset and never as a
//      value, a length, a prefix or a hint. The report goes to a public page,
//      and "the first four characters are sk-" is a leak even when the rest is
//      hidden.
//   2. **A missing thing is a decision, not always a mistake.** A deployment
//      that runs without web search chose that. So each item says whether it is
//      required — the product does not work without it — or optional, which
//      takes a feature away and nothing more.
//
// The endpoint built on this is `GET /api/setup`, and the banner that reads it
// is components/SetupStatus.tsx, shown on the About page.

export interface SetupItem {
  /** The environment variable name, or the pair that has to be set together. */
  keys: string[];
  /** What the feature is called in the product. */
  label: string;
  /** What stops working when it is absent, in one sentence. */
  missing: string;
  /** Where the value comes from — a console page, a command, a dashboard. */
  where: string;
  /** Required means the product cannot serve; optional means a feature is off. */
  severity: "required" | "optional";
  /** Whether this deployment holds it. Computed, never configured by hand. */
  configured: boolean;
}

export interface SetupReport {
  /** How many items were considered, so the banner can say "3 of 11". */
  checked: number;
  configured: number;
  /** Only the items that are not configured. Everything else is not shown. */
  missing: SetupItem[];
}

/** True when the variable holds something other than whitespace. */
function present(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Every check, in the order the banner shows them.
 *
 * Read at call time rather than at import: `next build` inlines `NEXT_PUBLIC_*`
 * into the client bundle, but this module runs on the server, and a module-level
 * constant would freeze the answer for the lifetime of a warm serverless
 * instance started before the variable was set.
 */
function items(): SetupItem[] {
  const supabase =
    present(process.env.NEXT_PUBLIC_SUPABASE_URL) && present(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const tokenKey = present(process.env.GITHUB_TOKEN_KEY);
  // Agent turns fall back to the GitHub token key, so a deployment with either
  // one is stable across instances. Neither means a per-process key, which is
  // the difference between a turn that survives a restart and one that does not.
  const turnSecret = present(process.env.AGENT_TURN_SECRET) || tokenKey;
  const oauthId = present(process.env.GITHUB_CLIENT_ID);
  const oauthSecret = present(process.env.GITHUB_CLIENT_SECRET);
  const pushPublic = present(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const pushPrivate = present(process.env.WEB_PUSH_PRIVATE_KEY);
  const redis =
    present(process.env.UPSTASH_REDIS_REST_URL) && present(process.env.UPSTASH_REDIS_REST_TOKEN);

  const list: SetupItem[] = [
    {
      keys: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
      label: "Supabase project",
      missing:
        "History stays in this browser. There is no account, no cloud sync, no admin console and no Dew ledger.",
      where: "Supabase dashboard → Project Settings → API, then push supabase/migrations/ into the project.",
      severity: "required",
      configured: supabase,
    },
    {
      keys: ["OPENROUTER_API_KEY"],
      label: "Auto mode",
      missing: "Auto cannot answer: it is the model Auto routes every message through.",
      where: "openrouter.ai/keys — create a key in the OpenRouter dashboard.",
      severity: "required",
      configured: present(process.env.OPENROUTER_API_KEY),
    },
    {
      keys: ["GEMINI_API_KEY"],
      label: "Code mode",
      missing: "Code cannot answer: it is the only family Code is allowed to use.",
      where: "aistudio.google.com → API keys",
      severity: "required",
      configured: present(process.env.GEMINI_API_KEY),
    },
    {
      keys: ["OPENMI_ADMIN_EMAIL"],
      label: "Admin console",
      missing:
        "Nobody can open the console, and the address is not exempt from paying Dew. Must match the address seeded in app_admin.",
      where: "Set it to the address you signed up with in Supabase Auth.",
      severity: "optional",
      configured: present(process.env.OPENMI_ADMIN_EMAIL),
    },
    {
      keys: ["GITHUB_TOKEN_KEY"],
      label: "GitHub connections",
      missing:
        "A GitHub token cannot be sealed, so the repository agent has nothing to read and the repo panel says so.",
      where: "openssl rand -hex 32 — any 32-byte hex value; rotating it forces every user to reconnect.",
      severity: "optional",
      configured: tokenKey,
    },
    {
      keys: ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY"],
      label: "Push notifications",
      missing: "Nobody can be notified; the settings toggle for it does nothing.",
      where: "npx web-push generate-vapid-keys, then put the public half in NEXT_PUBLIC_ and the private half server-side.",
      severity: "optional",
      configured: pushPublic && pushPrivate,
    },
    {
      keys: ["TAVILY_API_KEY"],
      label: "Web search",
      missing: "The composer's search modes are unavailable and answers cannot cite sources.",
      where: "tavily.com → dashboard → API keys. The free tier is enough to start.",
      severity: "optional",
      configured: present(process.env.TAVILY_API_KEY),
    },
    {
      keys: ["GROQ_API_KEY"],
      label: "Auto fallback",
      missing:
        "Auto keeps working, but has no last-resort model when OpenRouter is down — the request fails instead of degrading.",
      where: "console.groq.com/keys",
      severity: "optional",
      configured: present(process.env.GROQ_API_KEY),
    },
    {
      keys: ["AGENT_TURN_SECRET"],
      label: "Agent turn signing",
      missing:
        "Turns fall back to a per-process key, so a turn cannot continue on another instance. Fine on one long-lived server; wrong behind a autoscaler.",
      where: "openssl rand -hex 32. Falls back to GITHUB_TOKEN_KEY when unset.",
      severity: "optional",
      configured: turnSecret,
    },
    {
      keys: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
      label: "Shared rate limits",
      missing:
        "Rate limits are counted in this process's memory, so they do not hold across instances or restarts.",
      where: "upstash.com → create a Redis database.",
      severity: "optional",
      configured: redis,
    },
    {
      keys: ["NEXT_PUBLIC_SITE_URL"],
      label: "Public address",
      missing:
        "Share previews, the sitemap and the robots file point at example.com, and GitHub's OAuth callback cannot be built.",
      where: "The exact public origin of the deployment, with no trailing slash.",
      severity: "optional",
      configured: present(process.env.NEXT_PUBLIC_SITE_URL),
    },
  ];

  // A GitHub OAuth App is a pair. One half set is a mistake worth naming;
  // neither half is a deployment that chose the pasted-token door, which needs
  // no warning at all — so this item only exists when the pair disagrees.
  if (oauthId !== oauthSecret) {
    list.push({
      keys: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      label: "GitHub OAuth App",
      missing:
        "Only one half of the pair is set, so the OAuth door cannot work. Set both, or clear both and use the pasted token instead.",
      where: "GitHub → Settings → Developer settings → OAuth Apps. The callback is /api/github/oauth/callback.",
      severity: "optional",
      configured: false,
    });
  }

  return list;
}

/**
 * The report this deployment's banner shows.
 *
 * Only unconfigured items are returned. A key that has been set disappears from
 * the list on the next read, which is the whole point: the banner shrinks as
 * the deployment fills in, and goes away entirely when there is nothing left to
 * say.
 */
export function setupReport(): SetupReport {
  const all = items();
  const missing = all.filter((item) => !item.configured);
  // Required problems first: an owner reading the banner in order should fix
  // the thing that stops the product working before the thing that stops a
  // feature working.
  missing.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "required" ? -1 : 1));
  return {
    checked: all.length,
    configured: all.length - missing.length,
    missing,
  };
}

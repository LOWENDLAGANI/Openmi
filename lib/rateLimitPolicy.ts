// ── One rate-limit policy ────────────────────────────────────────────────────
// The table is the policy. Every route imports its own scope from here instead
// of passing a bare number, so the limits can be read, reviewed and explained
// as a whole — and so two routes can never quietly share a bucket at different
// sizes, which is what a literal per call site used to do.
//
// These are burst limits: requests per minute, per caller. They are not a plan,
// a quota or a daily allowance — the daily identity cap and the Dew balance are
// separate refusals with separate statuses (403 and 402), because they ask the
// reader to do different things (wait until tomorrow vs top up).

export const BUCKET_WINDOW_MS = 60_000;

export type RateLimitScope =
  | "chat"
  | "agent"
  | "commits"
  | "changesets"
  | "changeset-approve"
  | "dew"
  | "dew-claim"
  | "dew-activity"
  | "hour-session"
  | "github-link"
  | "github-manage"
  | "github-read"
  | "projects"
  | "project-files"
  | "project-tree"
  | "share-create"
  | "share-list"
  | "share-revoke"
  | "setup"
  | "admin"
  | "keys"
  | "models";

export interface RateLimitPolicy {
  perMinute: number;
  /** What one unit is, for copy: "messages", "agent steps", … */
  label: string;
}

export const RATE_LIMITS: Record<RateLimitScope, RateLimitPolicy> = {
  // Expensive: one unit can be a whole model turn.
  chat: { perMinute: 30, label: "messages" },
  agent: { perMinute: 20, label: "agent steps" },
  commits: { perMinute: 10, label: "commit attempts" },

  // Cheap to serve, and the console polls them; generous on purpose.
  changesets: { perMinute: 120, label: "change reads" },
  "changeset-approve": { perMinute: 20, label: "approvals" },

  // Dew reads are frequent (the balance chip), claims are infrequent and have
  // database side effects, so they are separate budgets.
  dew: { perMinute: 60, label: "balance checks" },
  "dew-claim": { perMinute: 10, label: "top-up claims" },
  "dew-activity": { perMinute: 30, label: "activity reads" },
  // Starting a session spends Dew and can be refused with a choice, so it is a
  // write budget rather than a read one; status is read by the chat page.
  "hour-session": { perMinute: 20, label: "hour session changes" },

  // Linking a credential is a write with a vendor round trip; reading a list is
  // not. The callback is unauthenticated, so it gets the loosest bucket.
  "github-link": { perMinute: 10, label: "GitHub link attempts" },
  "github-manage": { perMinute: 20, label: "GitHub connection changes" },
  "github-read": { perMinute: 30, label: "GitHub reads" },

  // Repository reads are token-scoped GitHub calls; writes are single rows.
  projects: { perMinute: 20, label: "project changes" },
  "project-files": { perMinute: 120, label: "file reads" },
  "project-tree": { perMinute: 60, label: "tree reads" },

  "share-create": { perMinute: 20, label: "share links" },
  "share-list": { perMinute: 60, label: "share reads" },
  "share-revoke": { perMinute: 60, label: "share changes" },

  // A key change is a vendor round trip and a sealed write; reading the list is
  // what the settings screen does when it opens. One bucket is enough for both.
  keys: { perMinute: 20, label: "key changes" },

  // Public and cheap, but public: a flood of either is still a flood.
  setup: { perMinute: 30, label: "setup checks" },
  admin: { perMinute: 60, label: "console requests" },
  models: { perMinute: 20, label: "model checks" },
};

/** The sentence a refused caller reads, from the policy rather than the route. */
export function rateLimitMessage(scope: RateLimitScope, retryAfterSeconds: number): string {
  const label = RATE_LIMITS[scope].label;
  return `Too many ${label} at once. Please wait ${retryAfterSeconds}s and try again.`;
}

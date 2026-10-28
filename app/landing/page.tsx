import { Metadata } from "next";
import LandingMark from "@/components/LandingMark";
import { LandingSection } from "@/components/LandingAnimate";

export const metadata: Metadata = {
  title: "Openmi — Your repository, with a reviewer built in.",
  description:
    "Openmi reads a repository and proposes the change. You review the diff, then approve the commit on an agent branch.",
};

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col">
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center">
        <div className="animate-stagger flex flex-col items-center gap-3" style={{ "--delay": 0 } as React.CSSProperties & { "--delay"?: number }}>
          <div className="animate-fade-block h-20 w-20 animate-mark-bounce">
            <LandingMark />
          </div>
          <div className="max-w-[90vw] text-balance">
            <p className="text-[12px] uppercase tracking-[0.22em] text-text-low">
              Read the repo. Stage the diff. Approve the commit.
            </p>
          </div>
          <h1 className="mx-auto max-w-3xl text-balance text-[46px] font-medium leading-[1.05] tracking-[-0.035em] text-text-hi sm:text-[62px] lg:text-[76px]">
            Your repository, <br /> with a reviewer built in.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-balance text-[15px] leading-relaxed text-text-mid">
            Openmi reads the code you point it at and proposes the change as a
            diff you can review. Nothing is committed until you say so.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <a
              href="#"
              className="group inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-on-accent transition-transform hover:scale-[1.02] active:scale-[0.99]"
            >
              Open Openmi
              <svg
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </a>
            <a
              href="/about"
              className="rounded-full border border-line-strong px-6 py-3 text-sm font-medium text-text-hi transition-colors hover:bg-hover"
            >
              See what shipped
            </a>
          </div>
          <p className="mt-10 text-[11px] uppercase tracking-[0.2em] text-text-low">
            Try it on a repository you know
          </p>
          <div className="relative mt-10 h-72 w-full max-w-5xl">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-b from-accent-soft/30 to-transparent blur-2xl" />
            <div className="relative flex h-full flex-col rounded-2xl border border-line-strong bg-card p-6 shadow-2xl">
              <div className="flex items-center gap-3 text-text-low">
                <span className="inline-block h-3 w-3 rounded-full bg-red-400/60" />
                <span className="inline-block h-3 w-3 rounded-full bg-amber-400/60" />
                <span className="inline-block h-3 w-3 rounded-full bg-emerald-400/60" />
                <span className="ml-2 text-[11px] tabular-nums">repo: app.tsx</span>
              </div>
              <div className="mt-4 overflow-hidden rounded-xl bg-canvas">
                <pre className="overflow-x-auto text-[13px] font-mono leading-relaxed text-text-body">
                  {`<button
  onClick={handleReview}
  className="rounded-lg border border-line bg-card px-4 py-2 text-sm text-text-hi"
>
  Review change
</button>`}
                </pre>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-[12px] text-text-mid">
                <span className="rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-accent">
                  +38 lines
                </span>
                <span className="rounded-full border border-line px-3 py-1 text-text-mid">
                  read 4 files
                </span>
                <span className="rounded-full border border-line px-3 py-1 text-text-mid">
                  1 change staged
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-line">
        <LandingSection>
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="mb-14 text-center animate-stagger" style={{ "--delay": 0 } as React.CSSProperties & { "--delay"?: number }}>
              <p className="text-[12px] uppercase tracking-[0.2em] text-text-low">
                What it does
              </p>
              <h2 className="mt-3 text-[34px] font-medium tracking-[-0.02em] text-text-hi sm:text-[44px]">
                Reads the code. Proposes the change.
              </h2>
            </div>

            <p className="mx-auto max-w-2xl text-balance text-[15px] leading-relaxed text-text-mid">
              Openmi is a repo agent. You attach a GitHub repository, ask a
              question, and it reads the relevant files, stages a change, and
              hands you a diff you can approve or reject.
            </p>

            <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 animate-stagger" style={{ "--delay": 200 } as React.CSSProperties & { "--delay"?: number }}>
              {FEATURES.map((feature) => (
                <article
                  key={feature.title}
                  className="group rounded-2xl border border-line bg-card p-6 transition-shadow hover:shadow-lg"
                >
                  <div className="text-accent">{feature.icon}</div>
                  <h3 className="mt-5 text-[17px] font-medium text-text-hi">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-text-mid">
                    {feature.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </LandingSection>
      </section>

      <section className="bg-raised border-t border-line">
        <LandingSection>
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="mb-14 text-center animate-stagger" style={{ "--delay": 0 } as React.CSSProperties & { "--delay"?: number }}>
              <p className="text-[12px] uppercase tracking-[0.2em] text-text-low">
                Why it exists
              </p>
              <h2 className="mt-3 text-[34px] font-medium tracking-[-0.02em] text-text-hi sm:text-[44px]">
                Built for people who review their own code
              </h2>
            </div>

            <p className="mx-auto max-w-2xl text-balance text-[15px] leading-relaxed text-text-mid">
              Most tools that “help with code” hide the decision from you. Openmi
              does the opposite: it does the reading and the drafting, then stops
              at the exact moment where a human should decide.
            </p>

            <div className="mt-12 flex flex-col items-center gap-8 sm:flex-row sm:items-start animate-stagger" style={{ "--delay": 160 } as React.CSSProperties & { "--delay"?: number }}>
              <div className="flex-1 text-center sm:text-left">
                <div className="rounded-xl border border-line bg-card p-6 sm:max-w-sm">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-text-low">
                    First request
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-text-mid">
                    The agent reads the repo you choose and stages a change you
                    can review. Nothing is committed until you approve it.
                  </p>
                </div>
              </div>
              <div className="flex-1 text-center sm:text-left">
                <div className="rounded-xl border border-line bg-card p-6 sm:max-w-sm">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-text-low">
                    You stay in control
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-text-mid">
                    You review the diff, approve it, or ask for a different
                    approach. The agent is useful because it waits for you.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </LandingSection>
      </section>

      <footer className="border-t border-line py-10 text-center text-[12px] text-text-low">
        <p>Openmi · Repo Agent</p>
        <p className="mt-1">Read the repo. Stage the diff. Approve the commit.</p>
      </footer>
    </main>
  );
}

const FEATURES = [
  {
    title: "Reads real repositories",
    body: "Point it at a GitHub repository and it reads the files that matter for the question you asked.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        <path d="M8 7h8" />
        <path d="M8 11h6" />
        <path d="M8 15h4" />
      </svg>
    ),
  },
  {
    title: "Stages a change, not a guess",
    body: "The answer is a diff you can review in your own repository, not a block of text that pretends to be finished.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M4.5 20.5h15" />
      </svg>
    ),
  },
  {
    title: "You approve the commit",
    body: "Nothing lands on the default branch unless you explicitly approve it. The agent works on its own branch.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
        <path d="M9 12l2 2 4-4" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
];

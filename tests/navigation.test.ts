// ── Navigation and feature visibility ────────────────────────────────────────
//
// A link to a page that was never built is invisible to a build and to a type
// check: Next answers it with a 404 at runtime, which is how the sidebar's
// "News" item pointed at /notes for months after the feature left the product.
// These contracts are cheap and would have caught that, plus the two doors this
// pass opened: the repository button in the chat header, and Escape on the
// repository panel.
//
//   bun run test

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
let passes = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

function walk(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir)).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(join(process.cwd(), path)).isDirectory() ? walk(path) : [path];
  });
}

async function main(): Promise<void> {
  console.log("\nnavigation");

  await test("every internal link has a page behind it", () => {
    const sources = walk("app").concat(walk("components")).filter((file) => file.endsWith(".tsx"));
    const links = new Set<string>();
    for (const file of sources) {
      for (const match of read(file).matchAll(/href="(\/[^"?#]*)"/g)) {
        const href = match[1];
        // API routes are called with fetch, not <Link>; a page that builds a
        // dynamic href is checked by its own route.
        if (href.startsWith("/api/")) continue;
        links.add(href);
      }
    }

    const missing = [...links].filter((href) => {
      const page = href === "/" ? "app/page.tsx" : join("app", href.replace(/^\//, ""), "page.tsx");
      return !existsSync(join(process.cwd(), page));
    });
    assert.deepEqual(missing, [], `dead internal links: ${missing.join(", ")}`);
  });

  await test("the sidebar footer leads somewhere: Activity, not a missing News page", () => {
    const sidebar = read("components/Sidebar.tsx");
    assert.match(sidebar, /href="\/activity"/, "the spend history has no door outside /plus");
    assert.ok(!sidebar.includes('href="/notes"'), "the dead News link is back");
  });

  await test("the repository door is in the chat header, with a dot when one is attached", () => {
    const page = read("app/chat/page.tsx");
    assert.ok(
      page.includes('aria-label={project ? `Repository: ${project.repoFullName}` : "Choose a repository"}'),
      "the header has no repository button"
    );
    assert.ok(page.includes("onClick={() => setRepoOpen(true)}"), "the button does not open the panel");
    assert.ok(
      page.includes("rounded-full bg-[#7fd1a1]"),
      "an attached project is not marked on the button"
    );
  });

  await test("Escape closes the repository panel", () => {
    const panel = read("components/RepoPanel.tsx");
    const start = panel.indexOf("Escape closes the panel");
    const effect = panel.slice(start, panel.indexOf("// Read inside", start));
    assert.ok(start > 0 && effect.length > 0, "there is no Escape handler");
    assert.match(effect, /event\.key === "Escape"/, "Escape does nothing");
    assert.match(effect, /window\.addEventListener\("keydown"/, "the handler is never attached");
    assert.match(effect, /if \(!open\) return;/, "a closed panel still captures Escape");
  });

  await test("the design controls lead the settings sheet", () => {
    const settings = read("components/SettingsPanel.tsx");
    const headings = new Map<string, number>();
    let offset = 0;
    for (const line of settings.split("\n")) {
      const name = line.trim();
      if (["Appearance", "Home layout", "Web search", "Response length", "Reasoning effort"].includes(name)) {
        if (!headings.has(name)) headings.set(name, offset);
      }
      offset += line.length + 1;
    }
    const order = ["Appearance", "Home layout", "Web search", "Response length", "Reasoning effort"];
    const positions = order.map((name) => headings.get(name) ?? -1);
    assert.ok(positions.every((position) => position >= 0), "a section heading moved or was renamed");
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "appearance and home layout no longer lead");
    assert.ok(
      settings.indexOf("<DataControls />") > positions[positions.length - 1],
      "the data controls still sit above the theme and the home layout"
    );
  });

  await test("the mobile header keeps its controls instead of truncating the name", () => {
    const page = read("app/chat/page.tsx");
    assert.match(
      page,
      /hidden truncate text-\[17px\] font-medium tracking-\[-0\.02em\] text-white sm:block/,
      "the wordmark squeezes the repository button and the mode selector on a phone"
    );
  });

  console.log(`\n${passes} checks`);
  if (failures > 0) {
    console.error(`navigation: ${failures} failed`);
    process.exit(1);
  }
  console.log("navigation: all checks passed");
}

void main();

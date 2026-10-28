// ── The Focus home ────────────────────────────────────────────────────────────
//
// The Focus layout is a design, and a design is exactly the kind of thing a
// build cannot check: the screen still compiles with the mark missing, the ink
// palette never applied, or the layout silently reverting to Classic the
// moment a preference write fails. These are source contracts, in the style of
// tests/composer-and-thread.test.ts.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

async function main(): Promise<void> {
  console.log("\nfocus home");

  await test("the ink theme belongs to the Focus layout, not to a third appearance", () => {
    const settings = read("lib/settings.ts");
    assert.match(settings, /export type HomeLayout = "classic" \| "focus"/, "there is no Focus layout");
    assert.match(settings, /export type Appearance = "dark" \| "light"/, "appearance grew a third value");
    const apply = settings.slice(settings.indexOf("export function applyDocumentTheme"), settings.indexOf("export function saveAppearance"));
    assert.match(apply, /const ink = homeLayout === "focus"/, "ink is not decided by the layout");
    assert.match(apply, /classList\.toggle\("ink", ink\)/, "the ink class is never set");
    assert.match(apply, /classList\.toggle\("light", !ink && appearance === "light"\)/, "ink does not win over light");
  });

  await test("the first paint already knows the home layout", () => {
    const layout = read("app/layout.tsx");
    assert.match(layout, /openmi:home-layout/, "the boot script does not read the layout");
    assert.match(layout, /classList\.add\("ink"\)/, "a Focus visitor is painted in the wrong theme first");
    assert.match(layout, /openmi:appearance/, "the appearance is no longer read on boot");
  });

  await test("the layout follows the account, not only this browser", () => {
    const preferences = read("lib/preferences.ts");
    assert.match(preferences, /homeLayout: HomeLayout;/, "the preference has no home layout");
    assert.match(preferences, /home_layout/, "the layout is never read from or written to the account");
    assert.match(preferences, /row\.home_layout === "focus"/, "a stored Focus layout is ignored");
    assert.match(preferences, /homeLayout: loadHomeLayout\(\)/, "the local copy is not read");
    assert.match(preferences, /saveHomeLayout\(preferences\.homeLayout\)/, "the local copy is not written");

    const migration = read("supabase/migrations/20261024000900_home_layout.sql");
    assert.match(migration, /add column if not exists home_layout/, "the column is missing");
    assert.match(migration, /check \(home_layout in \('classic', 'focus'\)\)/, "the column accepts anything");
  });

  await test("the empty screen is the only place Focus replaces the thread", () => {
    const page = read("app/chat/page.tsx");
    assert.match(
      page,
      /const focusHome = homeLayout === "focus" && !temporary && messages\.length === 0;/,
      "Focus does not stop at the empty screen"
    );
    assert.match(page, /<FocusHome project=\{project\} onOpenRepo=\{\(\) => setRepoOpen\(true\)\} \/>/, "the screen is not rendered");
    assert.match(
      page,
      /focusHome[\s\S]{0,40}\? \{ responseLength, onChange: handleResponseLengthChange \}/,
      "the composer is never told about Focus"
    );
    assert.match(page, /handleHomeLayoutChange/, "there is no way to choose the layout");
  });

  await test("the screen is the design: mark, repository, composer", () => {
    const home = read("components/FocusHome.tsx");
    assert.match(home, /<rect x="0" y="0" width="13" height="56"/, "the mark is gone");
    assert.match(home, /focus-chip/, "the repository chip lost its surface");
    assert.match(home, /onOpenRepo/, "the chip no longer opens the repository panel");

    const input = read("components/ChatInput.tsx");
    assert.match(input, />Skills</, "the section label is gone");
    assert.match(input, /Ask Openmi…/, "the placeholder is not the design's");
    assert.match(input, /focus-composer/, "the card surface is gone");
    assert.match(input, /focus-send/, "the send control lost its fill");
    assert.match(input, /LENGTH_LABELS\[/, "the length picker does not show its value");
  });

  await test("the ink palette is a flat, complete table of values", () => {
    const css = read("app/globals.css");
    const ink = css.slice(css.indexOf("html.ink {"), css.indexOf("html.ink body"));
    assert.ok(ink.length > 0, "there is no ink theme");
    for (const token of ["--bg:", "--card:", "--text-hi:", "--accent:", "--bubble-user:", "--dock:"]) {
      assert.ok(ink.includes(token), `the ink theme is missing ${token}`);
    }
    assert.match(css, /html\.ink \.app-surface \{ background: var\(--bg\); \}/, "the green canvas gradient survives in ink");
    assert.match(css, /\.focus-composer \{/, "the composer card is unstyled");
    assert.match(css, /\.focus-send:hover:not\(:disabled\)/, "the send control has no hover state");
  });

  console.log(`\n${passes} checks`);
  if (failures > 0) {
    console.error(`focus-home: ${failures} failed`);
    process.exit(1);
  }
  console.log("focus-home: all checks passed");
}

void main();

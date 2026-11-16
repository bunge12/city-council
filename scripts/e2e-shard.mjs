// Prints the chromium project's spec files for one CI runner, so that every
// runner gets about the same minutes of tests.
//
//   node scripts/e2e-shard.mjs 3/8
//
// Playwright's own `--shard` deals out the same number of tests to each
// runner, whatever they take. On CI a test that draws the 30,000 segment
// city takes three minutes and a replay test a second, so its shards ran
// from one minute to seventeen. This deals out whole files by the seconds
// each took on CI (`seconds` in e2e/projects.json), the longest first,
// each to the runner with the least so far. Every file goes to exactly one
// runner, and a new file, not yet timed, counts as `defaultSeconds`.
//
// With --list it prints every runner's files and minutes instead.

import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const projects = JSON.parse(readFileSync(new URL("e2e/projects.json", root), "utf8"));
const walkthrough = new RegExp(projects.walkthrough);

// Playwright finds tests in any `*.spec.*` or `*.test.*` file under e2e/,
// in subfolders too. This deals out only `e2e/*.spec.ts`, so any other
// would run on no CI runner: refuse instead.
const e2eDir = fileURLToPath(new URL("e2e/", root));
const stray = readdirSync(e2eDir, { recursive: true })
  .map(String)
  .filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f) && !/^[^/\\]+\.spec\.ts$/.test(f));
if (stray.length > 0) {
  console.error(`put spec files directly in e2e/ and name them *.spec.ts, or no CI runner gets them: ${stray.map((f) => relative(".", `${e2eDir}${f}`)).join(", ")}`);
  process.exit(1);
}

/** The chromium project's spec files: every one the other projects do not run. */
const files = readdirSync(new URL("e2e/", root))
  .filter((f) => f.endsWith(".spec.ts") && !walkthrough.test(f) && !projects.roads.includes(f))
  .sort();

/** Seconds each file is expected to take on a CI runner. */
const seconds = (f) => projects.seconds[f] ?? projects.defaultSeconds;

/** Files dealt to `total` runners, longest first, each to the runner with the least. Ties go by name and by runner number, so every runner computes the same deal. */
function deal(total) {
  const runners = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  const order = files.slice().sort((a, b) => seconds(b) - seconds(a) || (a < b ? -1 : 1));
  for (const f of order) {
    let least = runners[0];
    for (const r of runners) if (r.seconds < least.seconds) least = r;
    least.files.push(f);
    least.seconds += seconds(f);
  }
  for (const r of runners) r.files.sort();
  return runners;
}

const arg = process.argv[2] ?? "";
if (arg === "--list") {
  const total = Number(process.argv[3] ?? 8);
  deal(total).forEach((r, i) => console.log(`${i + 1}/${total} ${Math.round(r.seconds / 6) / 10} min: ${r.files.join(" ")}`));
} else {
  const match = /^(\d+)\/(\d+)$/.exec(arg);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || current > total) {
    console.error("usage: node scripts/e2e-shard.mjs <current>/<total>, for example 3/8, or --list <total>");
    process.exit(1);
  }
  const { files: mine } = deal(total)[current - 1];
  // No files would mean no filter, and Playwright would run them all.
  if (mine.length === 0) {
    console.error(`runner ${current} of ${total} has no spec files: use fewer runners`);
    process.exit(1);
  }
  console.log(mine.map((f) => `e2e/${f}`).join(" "));
}

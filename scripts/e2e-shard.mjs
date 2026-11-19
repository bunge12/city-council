// Prints one Playwright project's spec files for one CI runner, so that
// every runner gets about the same minutes of tests.
//
//   node scripts/e2e-shard.mjs 3/6
//   node scripts/e2e-shard.mjs 2/3 --project perf
//
// The project is chromium unless --project names perf or evidence (issue
// #225), whose files are the lists of those names in e2e/projects.json.
//
// Playwright's own `--shard` deals out the same number of tests to each
// runner, whatever they take. On CI a test that draws the 30,000 segment
// city takes three minutes and a replay test a second, so its shards ran
// from one minute to seventeen. This deals out whole files by the seconds
// each took on CI (`seconds` in e2e/projects.json), the longest first,
// each to the runner with the least so far. Every file goes to exactly one
// runner, and a new file, not yet timed, counts as `defaultSeconds`.
//
// With --list <total> it prints every runner's files and minutes instead.
//
// With --global-timeout it prints the milliseconds to give that runner's
// Playwright run as --global-timeout instead of its files (issue #228):
// `timesPlan` times its planned seconds and no less than `minMinutes`, from
// `globalTimeout` in e2e/projects.json, and no less than its plan plus
// every attempt of its longest test, so a test that times out still gets
// its retry (scripts/e2e-limits.mjs).
//
//   node scripts/e2e-shard.mjs 3/6 --global-timeout

import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { attemptsOf, configTimeoutMs, globalTimeoutMs, longestTestMs } from "./e2e-limits.mjs";

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

const args = process.argv.slice(2);
const timeoutAt = args.indexOf("--global-timeout");
const globalTimeout = timeoutAt >= 0;
if (globalTimeout) args.splice(timeoutAt, 1);
const at = args.indexOf("--project");
const project = at >= 0 ? args.splice(at, 2)[1] : "chromium";
if (!["chromium", "perf", "evidence"].includes(project ?? "")) {
  console.error(`--project takes chromium, perf or evidence, not ${project}`);
  process.exit(1);
}

const specFiles = readdirSync(new URL("e2e/", root)).filter((f) => f.endsWith(".spec.ts"));
const listed = [...projects.perf, ...projects.evidence];
const missing = listed.filter((f) => !specFiles.includes(f));
if (missing.length > 0) {
  console.error(`e2e/projects.json lists spec files that do not exist: ${missing.join(", ")}`);
  process.exit(1);
}

/** The project's spec files. The chromium project runs every one the other projects do not. */
const files = (
  project === "chromium"
    ? specFiles.filter((f) => !walkthrough.test(f) && !projects.roads.includes(f) && !listed.includes(f))
    : projects[project]
).slice().sort();

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

const arg = args[0] ?? "";
if (arg === "--list") {
  const total = Number(args[1] ?? 6);
  deal(total).forEach((r, i) => console.log(`${i + 1}/${total} ${Math.round(r.seconds / 6) / 10} min: ${r.files.join(" ")}`));
} else {
  const match = /^(\d+)\/(\d+)$/.exec(arg);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || current > total) {
    console.error("usage: node scripts/e2e-shard.mjs <current>/<total> [--project chromium|perf|evidence] [--global-timeout], for example 3/6, or --list <total>");
    process.exit(1);
  }
  const { files: mine, seconds: planned } = deal(total)[current - 1];
  // No files would mean no filter, and Playwright would run them all.
  if (mine.length === 0) {
    console.error(`runner ${current} of ${total} has no spec files: use fewer runners`);
    process.exit(1);
  }
  if (globalTimeout) {
    const defaultMs = configTimeoutMs(readFileSync(new URL("playwright.config.ts", root), "utf8"));
    const longest = Math.max(...mine.map((f) => longestTestMs(readFileSync(new URL(`e2e/${f}`, root), "utf8"), defaultMs)));
    if (!Number.isFinite(longest)) {
      console.error("a spec file sets a time limit that cannot be read: run node scripts/check-e2e-timeouts.mjs");
      process.exit(1);
    }
    console.log(globalTimeoutMs(projects, planned, longest, attemptsOf(project)));
  } else {
    console.log(mine.map((f) => `e2e/${f}`).join(" "));
  }
}

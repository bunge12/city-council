// Prints what one CI runner of a Playwright project runs, so that every
// runner gets about the same minutes of tests.
//
//   node scripts/e2e-shard.mjs 3/6
//   node scripts/e2e-shard.mjs 2/3 --project perf
//   node scripts/e2e-shard.mjs 1/3 --project roads --planned-out plan.txt
//
// The project is chromium unless --project names roads, perf or evidence.
// For chromium, perf and evidence it prints spec files. For roads, whose
// three files go to three runners, it writes the runner's tests to
// e2e-test-list.txt and prints `--test-list e2e-test-list.txt`.
//
// Playwright's own `--shard` deals out the same number of tests to each
// runner, whatever they take. On CI a test that draws the 30,000 segment
// city takes three minutes and a replay test a second, so its shards ran
// from one minute to seventeen. This deals out files or tests by the
// seconds each took on CI (`seconds` and `testSeconds` in e2e/projects.json),
// the longest first, each to the runner with the least so far. Every one
// goes to exactly one runner. One with no seconds fails the job, with a
// message that says what to add (issue #229).
//
// With --planned-out <file> it writes the runner's planned seconds there,
// for the run summary (scripts/e2e-report.mjs).
//
// With --list <total> it prints every runner's share and minutes instead.
//
// With --global-timeout it prints the milliseconds to give that runner's
// Playwright run as --global-timeout instead of its share (issue #228):
// `timesPlan` times its planned seconds and no less than `minMinutes`, from
// `globalTimeout` in e2e/projects.json, and no less than its plan plus
// every attempt of its longest test, so a test that times out still gets
// its retry (scripts/e2e-limits.mjs).
//
//   node scripts/e2e-shard.mjs 3/6 --global-timeout

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { attemptsOf, configTimeoutMs, globalTimeoutMs, longestTestMs, perfLimitMs } from "./e2e-limits.mjs";
import { countTestList, dealtProjects, deal, plan, readProjects, root, specFiles } from "./e2e-plan.mjs";

const projects = readProjects();

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
/** Takes `--name value` out of args. */
function option(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : undefined;
}
const timeoutAt = args.indexOf("--global-timeout");
const globalTimeout = timeoutAt >= 0;
if (globalTimeout) args.splice(timeoutAt, 1);
const project = option("--project") ?? "chromium";
const plannedOut = option("--planned-out");
if (!dealtProjects.includes(project)) {
  console.error(`--project takes ${dealtProjects.join(", ")}, not ${project}`);
  process.exit(1);
}

const listed = [...projects.roads, ...projects.perf, ...projects.evidence];
const missing = listed.filter((f) => !specFiles().includes(f));
if (missing.length > 0) {
  console.error(`e2e/projects.json lists spec files that do not exist: ${missing.join(", ")}`);
  process.exit(1);
}

let planned;
try {
  planned = plan(projects, project);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const { items, secondsOf } = planned;

const arg = args[0] ?? "";
if (arg === "--list") {
  const total = Number(args[1] ?? 6);
  deal(items, secondsOf, total).forEach((r, i) => console.log(`${i + 1}/${total} ${Math.round(r.seconds / 6) / 10} min: ${r.items.join(project === "roads" ? "\n    " : " ")}`));
} else {
  const match = /^(\d+)\/(\d+)$/.exec(arg);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || current > total) {
    console.error(`usage: node scripts/e2e-shard.mjs <current>/<total> [--project ${dealtProjects.join("|")}] [--planned-out <file>] [--global-timeout], for example 3/6, or --list <total>`);
    process.exit(1);
  }
  const mine = deal(items, secondsOf, total)[current - 1];
  // Nothing would mean no filter, and Playwright would run it all.
  if (mine.items.length === 0) {
    console.error(`runner ${current} of ${total} has nothing to run: use fewer runners`);
    process.exit(1);
  }
  if (plannedOut) writeFileSync(plannedOut, `${Math.round(mine.seconds)}\n`);
  if (globalTimeout) {
    // A roads item is `file › titles`; the limits are set per file.
    const files = [...new Set(mine.items.map((i) => i.split(" › ")[0]))];
    // The perf project has one limit for every test, in place of the config's default.
    const defaultMs = project === "perf" ? perfLimitMs(projects) : configTimeoutMs(readFileSync(new URL("playwright.config.ts", root), "utf8"));
    const longest = Math.max(...files.map((f) => longestTestMs(readFileSync(new URL(`e2e/${f}`, root), "utf8"), defaultMs)));
    if (!Number.isFinite(longest)) {
      console.error("a spec file sets a time limit that cannot be read: run node scripts/check-e2e-timeouts.mjs");
      process.exit(1);
    }
    console.log(globalTimeoutMs(projects, mine.seconds, longest, attemptsOf(project)));
  } else if (project === "roads") {
    // Playwright's test list: `[project] › file › titles`, the file under e2e/.
    writeFileSync("e2e-test-list.txt", mine.items.map((t) => `[roads] › ${t}\n`).join(""));
    // A title Playwright's list format cannot hold (one with a `›` in it,
    // say) would match nothing, and the runner would pass without it.
    const matched = countTestList("e2e-test-list.txt");
    if (matched !== mine.items.length) {
      console.error(`Playwright selects ${matched} of this runner's ${mine.items.length} roads tests from e2e-test-list.txt: a title it cannot read back? ${mine.items.join(" | ")}`);
      process.exit(1);
    }
    console.log("--test-list e2e-test-list.txt");
  } else {
    console.log(mine.items.map((f) => `e2e/${f}`).join(" "));
  }
}

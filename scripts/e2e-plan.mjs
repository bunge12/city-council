// What scripts/e2e-shard.mjs, e2e-report.mjs and e2e-timings.mjs share:
// which spec files and tests each Playwright project runs, the seconds
// e2e/projects.json expects of each, and the deal of them to CI runners.
//
// The chromium, perf and evidence projects are dealt out by whole files
// (`seconds`). The roads project is dealt out test by test (`testSeconds`),
// since it has three files and three runners. A test is named by its file
// and its titles, `roads.spec.ts › the fixture city draws ... (?webgl)`, as
// Playwright's `--test-list` reads them.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = new URL("../", import.meta.url);
const projectsPath = new URL("e2e/projects.json", root);

/** The projects whose work scripts/e2e-shard.mjs deals out to runners. */
export const dealtProjects = ["chromium", "roads", "perf", "evidence"];

export function readProjects() {
  return JSON.parse(readFileSync(projectsPath, "utf8"));
}

export function writeProjects(projects) {
  writeFileSync(projectsPath, `${JSON.stringify(projects, null, 2)}\n`);
}

/** Every `e2e/*.spec.ts`, sorted. */
export function specFiles() {
  return readdirSync(new URL("e2e/", root))
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
}

/** The spec files of a project. The chromium project runs every one the others do not. */
export function projectFiles(projects, project) {
  const walkthrough = new RegExp(projects.walkthrough);
  if (project === "chromium") {
    const others = [...projects.roads, ...projects.perf, ...projects.evidence];
    return specFiles().filter((f) => !walkthrough.test(f) && !others.includes(f));
  }
  if (project === "walkthrough") return specFiles().filter((f) => walkthrough.test(f));
  return projects[project].slice().sort();
}

/** Every file that `seconds` should hold: those of the projects dealt out by file. */
export function timedFiles(projects) {
  return ["chromium", "perf", "evidence"].flatMap((p) => projectFiles(projects, p)).sort();
}

/**
 * The roads project's tests, as `file › title`, sorted. Playwright lists
 * them, so a test added to one of its files is dealt out like the rest.
 */
export function roadsTests() {
  const report = listTests(["--project", "roads", "--no-deps"]);
  const tests = new Set();
  const walk = (suite, titles) => {
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) if (t.projectName === "roads") tests.add([...titles, spec.title].join(" › "));
    }
  };
  // Each top-level suite is a file, titled with its path under e2e/.
  for (const file of report.suites) walk(file, [file.title]);
  return [...tests].sort();
}

/** Playwright's JSON list of the tests these arguments select. */
function listTests(args) {
  const bin = fileURLToPath(new URL("node_modules/.bin/playwright", root));
  const out = execFileSync(bin, ["test", "--list", "--reporter=json", ...args], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out);
}

/**
 * How many roads tests Playwright selects from a test list file. Playwright
 * does not fail a run whose test list matches nothing, so the shard script
 * checks the count itself.
 */
export function countTestList(path) {
  const report = listTests(["--project", "roads", "--no-deps", "--test-list", path]);
  let count = 0;
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) count += spec.tests.filter((t) => t.projectName === "roads").length;
  };
  for (const file of report.suites) walk(file);
  return count;
}

/**
 * What is missing from e2e/projects.json for these items, as a message that
 * says what to add, or null. Without it a new file would count as some
 * guess, and its runner could run out of time (issue #229).
 */
export function missingTimes(table, key, items) {
  const missing = items.filter((i) => table[i] === undefined);
  if (missing.length === 0) return null;
  const lines = missing.map((i) => `    ${JSON.stringify(i)}: <seconds>,`).join("\n");
  return (
    `e2e/projects.json has no \`${key}\` for:\n${lines}\n` +
    `Add each under \`${key}\`, with the seconds it takes with one worker on your machine times 1.5, so that ` +
    "a CI runner has room for it. The weekly e2e timings run (.github/workflows/e2e-timings.yml) replaces the " +
    "figure with what CI measures."
  );
}

/**
 * Items dealt to `total` runners, longest first, each to the runner with
 * the least so far. Ties go by name and by runner number, so every runner
 * computes the same deal.
 */
export function deal(items, secondsOf, total) {
  const runners = Array.from({ length: total }, () => ({ items: [], seconds: 0 }));
  const order = items.slice().sort((a, b) => secondsOf(b) - secondsOf(a) || (a < b ? -1 : 1));
  for (const item of order) {
    let least = runners[0];
    for (const r of runners) if (r.seconds < least.seconds) least = r;
    least.items.push(item);
    least.seconds += secondsOf(item);
  }
  for (const r of runners) r.items.sort();
  return runners;
}

/**
 * A project's items and the seconds of each: files for chromium, perf and
 * evidence, tests for roads. Throws with the message of missingTimes when
 * an item has no figure.
 */
export function plan(projects, project) {
  const byTest = project === "roads";
  const key = byTest ? "testSeconds" : "seconds";
  const table = projects[key] ?? {};
  const items = byTest ? roadsTests() : projectFiles(projects, project);
  const missing = missingTimes(table, key, items);
  if (missing) throw new Error(missing);
  return { items, key, secondsOf: (i) => table[i] };
}

/**
 * Every e2e-times.json under a folder, as e2e/file-times-reporter.ts wrote
 * them. `run` is the first folder under it when that is a number, the CI
 * run the file came from, as .github/workflows/e2e-timings.yml lays them
 * out (`<folder>/<run id>/<artifact>/e2e-times.json`).
 */
export function readTimes(dir) {
  const found = [];
  for (const f of readdirSync(dir, { recursive: true }).map(String)) {
    if (!f.endsWith("e2e-times.json")) continue;
    const path = join(dir, f);
    let times;
    try {
      times = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.error(`skipping ${path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (times.version !== 1) {
      console.error(`skipping ${path}: version ${times.version}, not 1`);
      continue;
    }
    const first = relative(dir, path).split(sep)[0] ?? "";
    found.push({ path, run: /^\d+$/.test(first) ? first : null, times });
  }
  return found;
}

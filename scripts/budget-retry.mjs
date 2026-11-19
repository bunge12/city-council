// Runs Vitest, and when the only failures are missed time budgets, runs the
// files that missed once more. The run fails when they miss again (issue
// #231). A real regression misses both times; a garbage collection or a
// pause of a shared runner lands on one attempt and seldom on the next.
//
//   node scripts/budget-retry.mjs [--keep <path>]... -- <vitest arguments>
//
// A budget check marks its failure with `[budget]` in the assertion's
// message. A failed test whose failures all carry the mark may be run
// again. Any other failure, a hash mismatch or a wrong count say, fails the
// run at once, since running it again gives the same answer.
//
// Each `--keep` path is copied aside before the second attempt, so the
// first attempt's report survives it: a file to `<name>.attempt-1<ext>`, a
// directory's files to `<dir>/attempt-1/`.
//
// The log, and the GitHub job summary when there is one, say which attempt
// failed and with what. The child sees `BUDGET_ATTEMPT` set to 1 or 2.
//
// The child also sees `BUDGET_ROWS`, the package's `budget-rows/`, emptied
// before the first attempt. Each held figure appends its row there, one
// file an attempt, for the headroom table (scripts/budget-table.mjs, issue
// #232).

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, extname, join, relative } from "node:path";

const BUDGET_MARK = "[budget]";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 0) {
  console.error("usage: node scripts/budget-retry.mjs [--keep <path>]... -- <vitest arguments>");
  process.exit(2);
}
const keep = [];
for (let i = 0; i < split; i++) {
  if (argv[i] === "--keep" && argv[i + 1] !== undefined && i + 1 < split) keep.push(argv[++i]);
  else {
    console.error(`budget-retry: unknown option ${argv[i]}`);
    process.exit(2);
  }
}
const vitestArgs = argv.slice(split + 1);
const outDir = mkdtempSync(join(tmpdir(), "budget-retry-"));
const rowsDir = join(process.cwd(), "budget-rows");
rmSync(rowsDir, { recursive: true, force: true });

/** One Vitest run, with a JSON report beside the reporters asked for. */
function attempt(n, files) {
  const out = join(outDir, `attempt-${n}.json`);
  const args = [...vitestArgs, "--reporter=json", `--outputFile.json=${out}`, ...files];
  console.log(`\nbudget-retry: attempt ${n}: vitest ${args.join(" ")}\n`);
  // The package's own Vitest, also when run with plain `node` rather than from a pnpm script.
  const path = `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env["PATH"] ?? ""}`;
  const run = spawnSync("vitest", args, { stdio: "inherit", env: { ...process.env, PATH: path, BUDGET_ATTEMPT: String(n), BUDGET_ROWS: rowsDir } });
  if (run.error) throw run.error;
  const report = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { status: run.status ?? 1, report };
}

/** Each failed file and its failed tests, and whether every failure in it is a missed budget. */
function failures(report) {
  const files = [];
  for (const file of report.testResults) {
    if (file.status !== "failed") continue;
    const tests = file.assertionResults
      .filter((t) => t.status === "failed")
      .map((t) => ({ name: t.fullName, messages: t.failureMessages.map((m) => m.split("\n")[0] ?? "") }));
    // A file that failed with no failed test failed to load, or in a hook.
    const budgetOnly = tests.length > 0 && tests.every((t) => t.messages.length > 0 && t.messages.every((m) => m.includes(BUDGET_MARK)));
    const fileMessage = file.message ? [file.message.split("\n")[0]] : [];
    files.push({ path: relative(process.cwd(), file.name), tests, budgetOnly, fileMessage });
  }
  return files;
}

function describe(n, files) {
  const lines = [];
  for (const f of files) {
    for (const m of f.fileMessage) lines.push(`attempt ${n}: ${f.path}: ${m}`);
    for (const t of f.tests) for (const m of t.messages) lines.push(`attempt ${n}: ${f.path} > ${t.name}: ${m}`);
  }
  return lines;
}

function summary(lines) {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
}

function keepAside() {
  for (const path of keep) {
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      const to = join(path, "attempt-1");
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(path)) {
        const from = join(path, name);
        if (statSync(from).isFile()) copyFileSync(from, join(to, name));
      }
    } else {
      const ext = extname(path);
      copyFileSync(path, join(path, "..", `${basename(path, ext)}.attempt-1${ext}`));
    }
  }
}

const first = attempt(1, []);
if (first.status === 0) process.exit(0);
if (!first.report) {
  console.error("budget-retry: attempt 1 failed and left no report, so it is not run again");
  process.exit(first.status);
}
const failed = failures(first.report);
const firstLines = describe(1, failed);
console.log(`\nbudget-retry: attempt 1 failed:\n${firstLines.join("\n")}`);
const other = failed.filter((f) => !f.budgetOnly || f.fileMessage.length > 0);
// An unhandled error fails the run without failing a test, and the report's
// `success` leaves it out. Running only the files that missed a budget would
// hide it, so such a run is not retried.
const unhandled = first.report.success === true || first.report.numFailedTests === 0;
if (failed.length === 0 || other.length > 0 || unhandled) {
  const why =
    other.length > 0
      ? `${other.map((f) => f.path).join(", ")} failed on more than a time budget`
      : "the run failed outside its tests, an unhandled error say,";
  console.log(`budget-retry: ${why}, so nothing is run again`);
  summary(["### Budget retry", "", `Attempt 1 failed. ${why}, so nothing was run again.`, "", ...firstLines.map((l) => `- ${l}`), ""]);
  process.exit(first.status);
}

keepAside();
const again = failed.map((f) => f.path);
const second = attempt(2, again);
const secondLines = second.report ? describe(2, failures(second.report)) : [`attempt 2: left no report, exit ${second.status}`];
const verdict =
  second.status === 0
    ? "Attempt 2 passed, so the miss in attempt 1 is put down to the runner and the run passes."
    : "Attempt 2 failed too, so the run fails.";
console.log(`\nbudget-retry: ${verdict}${secondLines.length > 0 ? `\n${secondLines.join("\n")}` : ""}`);
summary([
  "### Budget retry",
  "",
  `Attempt 1 missed a time budget, and ${again.join(", ")} ran again. ${verdict}`,
  "",
  ...firstLines.map((l) => `- ${l}`),
  ...secondLines.map((l) => `- ${l}`),
  "",
]);
process.exit(second.status);

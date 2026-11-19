// Prints every held time budget of a run as a Markdown table: figure,
// measured, budget, headroom and the runner's CPU (issue #232). The bench
// and soak jobs in .github/workflows/ci.yml write it to the job summary, so
// a figure close to its budget shows before it fails.
//
//   node scripts/budget-table.mjs --title <title> [--out <file.jsonl>] <rows folder>...
//
// Each folder is a package's `budget-rows/`, which scripts/budget-retry.mjs
// points the benches and the soak at: one `attempt-<n>.jsonl` an attempt,
// one row a held case (`hold` in packages/sim/test/budget.ts). A case run
// twice is shown from its last attempt. A figure under the headroom in
// packages/sim/balance/budgets.json gets a warning annotation on GitHub.
//
// `--out` writes the same rows as JSON lines with the commit, the run and
// the CPU on each, for the budget history on the data branch.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

const BUDGETS = new URL("../packages/sim/balance/budgets.json", import.meta.url);

const argv = process.argv.slice(2);
let title = "Time budgets";
let out = null;
const dirs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--title" && argv[i + 1] !== undefined) title = argv[++i];
  else if (argv[i] === "--out" && argv[i + 1] !== undefined) out = argv[++i];
  else if (argv[i]?.startsWith("--")) {
    console.error(`budget-table: unknown option ${argv[i]}`);
    process.exit(2);
  } else dirs.push(argv[i]);
}

const warnBelow = JSON.parse(readFileSync(BUDGETS, "utf8")).warnBelowHeadroom;
const list = cpus();
const cpu = list.length > 0 ? `${list.length} x ${list[0].model.trim()}` : "unknown";

/** Each case's row from its last attempt, in the order first seen. */
function read() {
  const rows = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .map((name) => ({ name, attempt: Number(/^attempt-(\d+)\.jsonl$/.exec(name)?.[1]) }))
      .filter((f) => Number.isInteger(f.attempt))
      .sort((a, b) => a.attempt - b.attempt);
    for (const { name, attempt } of files) {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const row = JSON.parse(line);
        rows.set(`${row.figure}\u0000${row.case}`, { ...row, attempt });
      }
    }
  }
  return [...rows.values()];
}

/** A number as the table shows it: whole numbers as they are, others to about three significant figures. */
function num(v) {
  if (v === null || v === undefined) return "-";
  if (!Number.isFinite(v) || Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  return String(Number(abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : abs >= 1 ? v.toFixed(2) : v.toPrecision(2)));
}

const unitOf = (row) => (row.unit === "ms" ? " ms" : row.unit === "steps" ? " steps" : "");
const cell = (text) => String(text).replace(/\|/g, "\\|");
const headroom = (row) => (row.headroom === null ? "no misses" : `${num(row.headroom)}x`);
// A count of steps over a time already allows for a couple of runner
// pauses, so 2 of 2 allowed is a pass with nothing to warn about; only the
// timed figures and ratios are marked low.
const low = (row) => row.statistic !== "count over" && row.headroom !== null && row.headroom < warnBelow;

const rows = read();
// Closest to its budget first, so the ones to watch head the table.
const sorted = [...rows].sort((a, b) => (a.headroom ?? Infinity) - (b.headroom ?? Infinity));

const lines = [`### ${title}: headroom on every held budget`, ""];
if (sorted.length === 0) {
  lines.push("No held figure wrote a row in this run.", "");
} else {
  const attempts = new Set(sorted.map((r) => r.attempt));
  lines.push(
    `Headroom is the budget over the measured figure; a timed figure under ${warnBelow}x is marked. Budgets and statistics are in \`packages/sim/balance/budgets.json\`.`,
    "",
    `| | Figure | Case | Statistic | Measured | Budget | Headroom | CPU | Mode${attempts.size > 1 ? " | Attempt" : ""} |`,
    `|---|---|---|---|---:|---:|---:|---|---${attempts.size > 1 ? "|---:" : ""}|`,
  );
  for (const r of sorted) {
    const mark = !r.pass ? "**over**" : low(r) ? "**low**" : "ok";
    lines.push(
      `| ${mark} | \`${cell(r.figure)}\` | ${cell(r.case)} | ${r.statistic} | ${num(r.measured)}${unitOf(r)} | ${num(r.budget)}${unitOf(r)} | ${headroom(r)} | ${cell(cpu)} | ${r.mode}${attempts.size > 1 ? ` | ${r.attempt}` : ""} |`,
    );
  }
  lines.push("");
}
const table = lines.join("\n");
console.log(table);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary) appendFileSync(summary, `${table}\n`);

// A warning annotation for each figure under the headroom, so it shows on
// the pull request's checks without opening a log.
if (process.env["GITHUB_ACTIONS"]) {
  const escape = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const r of sorted.filter(low)) {
    const what = `${r.case} (${r.figure}): ${r.statistic} ${num(r.measured)}${unitOf(r)} against ${num(r.budget)}${unitOf(r)}, ${num(r.headroom)}x headroom on ${cpu}`;
    console.log(`::warning title=${escape(`${title}: ${r.pass ? "low headroom" : "over budget"}`)}::${escape(what)}`);
  }
}

if (out) {
  const stamp = {
    date: new Date().toISOString(),
    sha: process.env["GITHUB_SHA"] ?? null,
    run: process.env["GITHUB_RUN_ID"] ?? null,
    job: title,
    cpu,
  };
  writeFileSync(out, rows.map((r) => JSON.stringify({ ...stamp, ...r })).join("\n") + (rows.length > 0 ? "\n" : ""));
}

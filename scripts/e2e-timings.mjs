// Brings the `seconds` and `testSeconds` in e2e/projects.json up to date
// from recent CI runs, and writes the body of the "Flaky tests" issue
// (issue #229). .github/workflows/e2e-timings.yml runs it weekly and opens
// a pull request with the change, so nobody edits the figures by hand.
//
//   node scripts/e2e-timings.mjs --times runs/main --flakes runs/pr [--write] [--flaky-out flaky.md]
//
// Each folder holds `<run id>/<artifact>/e2e-times.json`, the files that
// e2e/file-times-reporter.ts wrote and each e2e job uploaded. `--times`
// folders give the timings and the flakes; `--flakes` folders, a pull
// request's runs, only the flakes, since a pull request may change the
// tests it times. Either can be given more than once.
//
// A file's or test's new figure is the 75th percentile of its first
// attempts in those runs, weighted so that each CPU model counts the same
// however many of the runs it served. GitHub hands out fast and slow
// runners (issue #152), and a figure taken mostly on fast ones would plan a
// slow runner past its time limit. Only jobs that passed count: one
// stopped part way has not timed every file, and on a broken main every
// test can fail in a second. A file or test no run timed keeps its figure,
// and is listed. One that no longer exists is dropped.

import { writeFileSync } from "node:fs";
import { projectFiles, readProjects, readTimes, roadsTests, timedFiles, writeProjects } from "./e2e-plan.mjs";

const args = process.argv.slice(2);
const timeDirs = [];
const flakeDirs = [];
let write = false;
let flakyOut;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--times") timeDirs.push(args[++i]);
  else if (args[i] === "--flakes") flakeDirs.push(args[++i]);
  else if (args[i] === "--write") write = true;
  else if (args[i] === "--flaky-out") flakyOut = args[++i];
  else {
    console.error(`unknown argument ${args[i]}\nusage: node scripts/e2e-timings.mjs --times <folder> [--flakes <folder>] [--write] [--flaky-out <file>]`);
    process.exit(1);
  }
}
if (timeDirs.length === 0) {
  console.error("give at least one --times folder of CI runs' e2e-times.json files");
  process.exit(1);
}

/**
 * The weighted 75th percentile: each sample weighs 1 over the number of
 * samples from its CPU model, so every model has the same total weight.
 */
function weightedP75(samples) {
  const perCpu = new Map();
  for (const s of samples) perCpu.set(s.cpu, (perCpu.get(s.cpu) ?? 0) + 1);
  const sorted = samples.map((s) => ({ seconds: s.seconds, weight: 1 / perCpu.get(s.cpu) })).sort((a, b) => a.seconds - b.seconds);
  const total = sorted.reduce((a, s) => a + s.weight, 0);
  let sum = 0;
  for (const s of sorted) {
    sum += s.weight;
    // A little slack so that 0.75 of the weight, summed in floats, counts.
    if (sum >= 0.75 * total - 1e-9) return s.seconds;
  }
  return sorted[sorted.length - 1].seconds;
}

const projects = readProjects();
const timed = timeDirs.flatMap((d) => readTimes(d));
const complete = timed.filter(({ times }) => times.status === "passed");
const runIds = [...new Set(complete.map((t) => t.run).filter(Boolean))].sort();
console.log(`${complete.length} e2e jobs from ${runIds.length} runs, ${timed.length - complete.length} left out as not passed`);

/** Samples per key, from one table of each complete job's times. */
function samples(table) {
  const out = new Map();
  for (const { times } of complete) {
    for (const [key, seconds] of Object.entries(times[table] ?? {})) {
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ seconds, cpu: times.cpu });
    }
  }
  return out;
}

/** New figures for these keys, printed against the old. */
function update(key, items, measured) {
  const old = projects[key] ?? {};
  const next = {};
  const untimed = [];
  console.log(`\n${key}:`);
  for (const item of items) {
    const s = measured.get(item);
    const now = s ? Math.round(weightedP75(s)) : undefined;
    if (now === undefined) untimed.push(item);
    if (now !== undefined || old[item] !== undefined) next[item] = now ?? old[item];
    const cpus = s ? new Set(s.map((x) => x.cpu)).size : 0;
    console.log(`  ${item.padEnd(48)} ${String(old[item] ?? "-").padStart(5)} -> ${String(next[item] ?? "-").padStart(5)}  (${s?.length ?? 0} runs, ${cpus} CPU models)`);
  }
  const dropped = Object.keys(old).filter((k) => !items.includes(k));
  if (untimed.length > 0) console.log(`  not timed by these runs, kept as they were: ${untimed.join(", ")}`);
  if (dropped.length > 0) console.log(`  dropped, no longer in the suite: ${dropped.join(", ")}`);
  return next;
}

// The roads project is dealt out by test, so its files' seconds are not
// kept, nor the walkthrough's, which is not dealt out.
const roadsFiles = new Set(projectFiles(projects, "roads"));
const fileSamples = samples("seconds");
for (const f of roadsFiles) fileSamples.delete(f);
const seconds = update("seconds", timedFiles(projects), fileSamples);
const testSeconds = update("testSeconds", roadsTests(), samples("testSeconds"));

const changed =
  JSON.stringify(seconds) !== JSON.stringify(projects.seconds) || JSON.stringify(testSeconds) !== JSON.stringify(projects.testSeconds ?? {});
if (write && complete.length === 0) {
  console.log("\nno complete e2e job to time by, e2e/projects.json left as it was");
} else if (write && !changed) {
  console.log("\nevery figure is as it was, e2e/projects.json left as it was");
} else if (write) {
  projects.seconds = seconds;
  projects.testSeconds = testSeconds;
  projects._timings =
    `Written by scripts/e2e-timings.mjs from ${complete.length} e2e jobs of ${runIds.length} CI runs on main` +
    (runIds.length > 0 ? `, runs ${runIds[0]} to ${runIds[runIds.length - 1]}` : "") +
    ": the 75th percentile of each file's or test's first attempts, each CPU model weighted the same.";
  writeProjects(projects);
  console.log("\nwritten to e2e/projects.json");
}

// Flakes: tests that failed and then passed on a retry, in any run. A test
// that failed every attempt is a failure, which the run itself reports.
if (flakyOut) {
  const all = [...timed, ...flakeDirs.flatMap((d) => readTimes(d))];
  const flaky = new Map();
  for (const { run, times } of all) {
    for (const r of times.retries ?? []) {
      if (r.outcome !== "flaky") continue;
      const id = `${r.project} › ${r.test}`;
      if (!flaky.has(id)) flaky.set(id, { test: r.test, project: r.project, runs: new Set(), count: 0, error: r.error });
      const entry = flaky.get(id);
      entry.count += 1;
      if (run) entry.runs.add(run);
    }
  }
  const allRuns = new Set(all.map((t) => t.run).filter(Boolean));
  const server = process.env["GITHUB_SERVER_URL"] ?? "https://github.com";
  const repo = process.env["GITHUB_REPOSITORY"] ?? "";
  const link = (id) => (repo ? `[${id}](${server}/${repo}/actions/runs/${id})` : id);
  const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = [
    "Tests that failed and then passed on a retry in CI, so their jobs stayed green (issue #229).",
    "",
    `Kept up to date by the weekly e2e timings run (.github/workflows/e2e-timings.yml), from the ${allRuns.size} CI and perf runs it read, on main and on pull requests. Each line is a bug to find, in the test or in the game: close it here by fixing it, not by editing this list.`,
    "",
  ];
  if (flaky.size === 0) {
    lines.push("No test needed a retry in these runs.");
  } else {
    lines.push("| Test | Project | Times | Runs | First error |", "| --- | --- | ---: | --- | --- |");
    const order = [...flaky.values()].sort((a, b) => b.count - a.count || a.test.localeCompare(b.test));
    for (const f of order) {
      const runs = [...f.runs].sort().reverse();
      const shown = runs.slice(0, 8).map(link).join(", ") + (runs.length > 8 ? `, and ${runs.length - 8} more` : "");
      lines.push(`| ${cell(f.test)} | ${f.project} | ${f.count} | ${shown} | ${cell(f.error)} |`);
    }
  }
  writeFileSync(flakyOut, `${lines.join("\n")}\n`);
  console.log(`\n${flaky.size} flaky tests, written to ${flakyOut}`);
}

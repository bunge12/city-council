// The run summary of a CI run's e2e jobs (issue #229): each runner's
// minutes against its plan, and every test that needed a retry. It reads
// the e2e-times.json files that e2e/file-times-reporter.ts wrote and each
// job uploaded, from a folder `gh run download` filled.
//
//   node scripts/e2e-report.mjs <folder> >> "$GITHUB_STEP_SUMMARY"
//
// With retries on, a test that fails once and then passes leaves its job
// green. This is where it shows.

import { readTimes } from "./e2e-plan.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/e2e-report.mjs <folder of e2e-times.json files>");
  process.exit(1);
}

const minutes = (s) => (s === null || s === undefined ? "-" : (s / 60).toFixed(1));
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);

const runs = readTimes(dir).sort((a, b) => (a.times.runner ?? a.path).localeCompare(b.times.runner ?? b.path));
const out = ["## e2e runners", ""];
if (runs.length === 0) {
  out.push("No e2e job uploaded its times. A job stopped at its time limit, or killed, writes none.");
} else {
  out.push("| Runner | CPU | Planned min | First attempts min | Retries min | Ratio | Status |", "| --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const { times: t } of runs) {
    const took = sum(t.seconds);
    const ratio = t.plannedSeconds ? (took / t.plannedSeconds).toFixed(2) : "-";
    out.push(`| ${t.runner ?? "?"} | ${t.cores} x ${t.cpu} | ${minutes(t.plannedSeconds)} | ${minutes(took)} | ${minutes(sum(t.retrySeconds))} | ${ratio} | ${t.status} |`);
  }
  out.push("", "Planned is what e2e/projects.json expects of the runner's share; the weekly e2e timings run updates it from these files.");
}

const retries = runs.flatMap(({ times: t }) => t.retries.map((r) => ({ ...r, runner: t.runner ?? "?" })));
out.push("", "## Tests that needed a retry", "");
if (retries.length === 0) {
  out.push("None.");
} else {
  out.push("| Test | Project | Runner | Attempts | Outcome | First error |", "| --- | --- | --- | ---: | --- | --- |");
  const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const r of retries) out.push(`| ${cell(r.test)} | ${r.project} | ${r.runner} | ${r.attempts} | ${r.outcome === "flaky" ? "passed on retry" : "failed"} | ${cell(r.error)} |`);
  out.push("", 'The weekly e2e timings run lists every test that passed only on a retry in the issue titled "Flaky tests".');
}
console.log(out.join("\n"));

// Checks the e2e time limits against the CI jobs that run them (issue #228).
//
// No test may run longer than a third of its CI job. A test that times out
// is run again, so it can use twice its limit, and the rest of its runner's
// files need the last third. A 1,200 s test that timed out twice took 40
// minutes in a 35 minute job, and GitHub stopped the job before Playwright
// wrote its report.
//
// A runner of ci.yml's e2e job with no `files` to deal, such as a
// walkthrough, names the minutes of its Playwright run in `limit`. That must
// hold every attempt of its longest test with two minutes to spare, and end
// three minutes before its job's limit, so the report is written. Runners
// with `files` get their limit from scripts/e2e-shard.mjs, which holds the
// same.
//
// The job limits come from the workflows themselves, so they cannot drift:
// .github/workflows/ci.yml's e2e job for the chromium, roads and walkthrough
// projects, and .github/workflows/perf.yml's for perf and evidence. Each spec
// file's projects come from e2e/projects.json, as in scripts/e2e-shard.mjs.
// Run by `pnpm lint`.

import { readFileSync, readdirSync } from "node:fs";
import { attemptsOf, configTimeoutMs, timeouts } from "./e2e-limits.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** The text of one top-level job in a workflow file, from its name to the next job. */
function jobBlock(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`no job named ${job}`);
  const rest = workflow.slice(start + 1);
  const next = /\n {2}[\w-]+:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

/**
 * Each runner of ci.yml's e2e job, by its matrix id, with its job minutes,
 * its Playwright project, any `-g` title, and its `files` or `limit`. An
 * entry the check cannot read is an error, so no runner is skipped unseen.
 */
function ciRunners(workflow) {
  const e2e = jobBlock(workflow, "e2e");
  const fallback = /timeout-minutes: \$\{\{ matrix\.timeout \|\| (\d+) \}\}/.exec(e2e);
  if (!fallback) throw new Error("ci.yml's e2e job has no `timeout-minutes: ${{ matrix.timeout || N }}`");
  const runners = [];
  for (const line of e2e.split("\n").filter((l) => /^\s*- \{ ?id:/.test(l))) {
    const entry = /^\s*- (\{.*\})\s*(#.*)?$/.exec(line)?.[1];
    const id = entry && /\bid: ([\w-]+)/.exec(entry)?.[1];
    const project = entry && /--project (\w+)/.exec(entry)?.[1];
    if (!entry || !id || !project) throw new Error(`check-e2e-timeouts cannot read the ci.yml matrix entry: ${line.trim()}. Keep each entry on one line.`);
    const limit = /\blimit: (\d+)/.exec(entry)?.[1];
    runners.push({
      id,
      project,
      minutes: Number(/\btimeout: (\d+)/.exec(entry)?.[1] ?? fallback[1]),
      grep: /-g \\"([^"\\]+)\\"/.exec(entry)?.[1] ?? null,
      files: /\bfiles: "([^"]+)"/.exec(entry)?.[1] ?? null,
      limit: limit === undefined ? null : Number(limit),
    });
  }
  if (runners.length === 0) throw new Error("ci.yml's e2e job lists no matrix entries");
  return runners;
}

/** The minutes perf.yml's e2e job gets. */
function perfMinutes(workflow) {
  const minutes = /\n {4}timeout-minutes: (\d+)\n/.exec(jobBlock(workflow, "e2e"))?.[1];
  if (!minutes) throw new Error("perf.yml's e2e job has no `timeout-minutes: N`");
  return Number(minutes);
}

/** Every test limit in a file over a third of `minutes`, as a message. */
function violations(file, source, defaultMs, minutes, jobs) {
  const capMs = (minutes * 60_000) / 3;
  return timeouts(source, defaultMs).flatMap(({ line, ms, text }) => {
    if (ms === null) {
      return [`${file}:${line}: ${text} cannot be checked. Give test.setTimeout a number above 0, or a const set to one in the file.`];
    }
    if (ms <= capMs) return [];
    return [
      `${file}:${line}: ${text} allows ${ms / 1000} s, over a third of the ${minutes} minutes of ${jobs}` +
        ` (${capMs / 1000} s). With a retry it could take ${(2 * ms) / 60_000} minutes.`,
    ];
  });
}

/** The check fires on what it is meant to catch, or this script would pass on anything. */
function selfTest() {
  const cases = [
    ["test.setTimeout(1_200_000);", 35, 1],
    ["test.setTimeout(700_000);", 35, 0],
    ["const LONG = 20 * 60_000;\ntest.setTimeout(LONG);", 35, 1],
    ["  test.setTimeout(RUN_TIMEOUT);", 35, 1],
    ["test.setTimeout(0);", 35, 1],
    ["test.slow();", 1, 1],
    ["test.setTimeout(300_000);\n  test.slow();", 35, 1],
    ["testInfo.slow(isWebGpu);", 1, 1],
    ["test.describe.configure({ mode: \"serial\",\n  timeout: 5_000 });", 35, 1],
    ["test.describe.configure({ mode: \"serial\" });", 35, 0],
    ["// test.setTimeout(9_000_000);", 35, 0],
  ];
  for (const [source, minutes, expected] of cases) {
    const got = violations("x.spec.ts", source, 60_000, minutes, "a job").length;
    if (got !== expected) throw new Error(`check-e2e-timeouts self-test: ${JSON.stringify(source)} in ${minutes} minutes gave ${got} problems, not ${expected}`);
  }
  const workflow = (entry) => `jobs:\n  e2e:\n    timeout-minutes: \${{ matrix.timeout || 35 }}\n${entry}\n  check:\n`;
  const runners = ciRunners(workflow('          - { id: walkthrough-m2, timeout: 60, limit: 48, args: "--project walkthrough -g \\"M2 walkthrough\\"" } # one'));
  if (runners[0]?.minutes !== 60 || runners[0]?.limit !== 48 || runners[0]?.grep !== "M2 walkthrough") throw new Error("check-e2e-timeouts self-test: cannot read a matrix entry");
  let threw = false;
  try {
    ciRunners(workflow("          - { id: roads-1,\n              args: \"--project roads\" }"));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("check-e2e-timeouts self-test: a matrix entry over two lines was skipped");
}

function main() {
  selfTest();
  const projects = JSON.parse(read("e2e/projects.json"));
  const defaultMs = configTimeoutMs(read("playwright.config.ts"));
  const runners = ciRunners(read(".github/workflows/ci.yml"));
  const perf = perfMinutes(read(".github/workflows/perf.yml"));
  const walkthrough = new RegExp(projects.walkthrough);
  const projectOf = (file) =>
    projects.perf.includes(file) ? "perf" : projects.evidence.includes(file) ? "evidence" : walkthrough.test(file) ? "walkthrough" : projects.roads.includes(file) ? "roads" : "chromium";
  /** Whether a ci.yml runner runs the file. */
  const runs = (runner, file, source) => runner.project === projectOf(file) && (runner.grep === null || source.includes(runner.grep));

  const problems = [];
  if (defaultMs > (Math.min(...runners.map((r) => r.minutes), perf) * 60_000) / 3) {
    problems.push(`playwright.config.ts: the default timeout of ${defaultMs / 1000} s is over a third of the shortest e2e job`);
  }
  const files = readdirSync(new URL("e2e/", root)).filter((f) => f.endsWith(".spec.ts")).sort();
  const sources = new Map(files.map((f) => [f, read(`e2e/${f}`)]));
  for (const [file, source] of sources) {
    const project = projectOf(file);
    const jobs = project === "perf" || project === "evidence" ? [{ id: "perf.yml e2e", minutes: perf }] : runners.filter((r) => runs(r, file, source));
    if (jobs.length === 0) {
      problems.push(`e2e/${file}: no CI job runs it`);
      continue;
    }
    const minutes = Math.min(...jobs.map((j) => j.minutes));
    const names = jobs.length > 3 ? `${jobs[0]?.id} and the other ${jobs[0]?.id.replace(/-\d+$/, "")} runners` : jobs.map((j) => j.id).join(", ");
    problems.push(...violations(`e2e/${file}`, source, defaultMs, minutes, names));
  }

  for (const r of runners) {
    if (r.files !== null) continue;
    if (r.limit === null) {
      problems.push(`ci.yml: e2e runner ${r.id} has no files to deal, so it needs a \`limit:\` in minutes for its Playwright run`);
      continue;
    }
    const longest = Math.max(
      defaultMs,
      ...[...sources].filter(([f, s]) => runs(r, f, s)).flatMap(([, s]) => timeouts(s, defaultMs).map((t) => t.ms ?? 0)),
    );
    const needMs = attemptsOf(r.project) * longest + 2 * 60_000;
    if (r.limit * 60_000 < needMs) {
      problems.push(`ci.yml: e2e runner ${r.id}'s limit of ${r.limit} minutes cannot hold every attempt of its longest test (${longest / 1000} s) with two minutes to spare: make it at least ${Math.ceil(needMs / 60_000)}`);
    }
    if (r.limit > r.minutes - 3) {
      problems.push(`ci.yml: e2e runner ${r.id}'s limit of ${r.limit} minutes leaves less than three of its job's ${r.minutes} to upload the report`);
    }
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error("Lower the test's limit, split the file, or change the runner's limit. See issue #228.");
    process.exit(1);
  }
  console.log(`check-e2e-timeouts: ${files.length} spec files, every test limit within a third of its job.`);
}

main();

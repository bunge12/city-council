// A Playwright reporter for CI. When a run starts it prints the machine's
// CPU, it prints each failure as it happens, and when the run ends it prints
// how many seconds each spec file took and writes e2e-times.json.
//
// GitHub's runners are not all the same speed. On 16 November 2026 the same
// tests on the same runner image took 1.5 to 2 times as long on some runners
// as on others (issue #152), and the logs did not say what the machine was.
//
// e2e-times.json holds the CPU, each file's and each test's seconds on their
// first attempt, the seconds spent on retries, and every test that needed a
// retry (issue #229). Each CI job uploads it. scripts/e2e-report.mjs puts a
// run's files in its summary, and scripts/e2e-timings.mjs, run weekly, turns
// recent runs' files into the seconds in e2e/projects.json and the "Flaky
// tests" issue. The job sets E2E_RUNNER, E2E_SHARD and E2E_PLANNED_SECONDS
// to say which runner it was and what it was planned to take.

import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { basename, relative } from "node:path";
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/** One test that needed a retry. */
interface Retried {
  /** `file › titles`, as e2e/projects.json's `testSeconds` names tests. */
  test: string;
  project: string;
  /** Attempts it took, the first included. */
  attempts: number;
  /** flaky: failed, then passed. unexpected: failed every attempt. */
  outcome: string;
  /** The first line of the first attempt's error. */
  error: string;
}

export default class FileTimesReporter implements Reporter {
  private rootDir = "";
  /** Seconds of each file's first attempts, the figure projects.json keeps. */
  private readonly seconds: Record<string, number> = {};
  /** Seconds of each test's first attempt. */
  private readonly testSeconds: Record<string, number> = {};
  /** Seconds spent on retries, apart: a retry is a flake, not the file's length. */
  private readonly retrySeconds: Record<string, number> = {};
  private readonly projects = new Set<string>();
  private readonly firstErrors = new Map<TestCase, string>();
  private readonly retried = new Set<TestCase>();

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
    const cpu = cpus();
    console.log(`machine: ${cpu.length} x ${cpu[0]?.model ?? "unknown CPU"}, ${Math.round(totalmem() / 2 ** 30)} GB`);
  }

  /** `file › titles`, the file relative to e2e/, without the project. */
  private name(test: TestCase): string {
    const [, , , ...titles] = test.titlePath();
    return [relative(this.rootDir, test.location.file).split("\\").join("/"), ...titles].join(" › ");
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const file = basename(test.location.file);
    const project = test.parent.project()?.name ?? "";
    this.projects.add(project);
    // The list reporter prints failures only when the run ends, so a runner
    // cancelled at the job's time limit never shows why its tests failed.
    if (result.status !== "passed" && result.status !== "skipped") {
      const message = (result.error?.message ?? result.status).split("\n").slice(0, 6).join("\n    ");
      console.log(`  ${result.status}: ${file} › ${test.title}${result.retry > 0 ? ` (retry #${result.retry})` : ""}\n    ${message}`);
      if (result.retry === 0) this.firstErrors.set(test, (result.error?.message ?? result.status).split("\n")[0] ?? "");
    }
    const seconds = result.duration / 1000;
    if (result.retry === 0) {
      this.seconds[file] = (this.seconds[file] ?? 0) + seconds;
      const name = this.name(test);
      this.testSeconds[name] = (this.testSeconds[name] ?? 0) + seconds;
    } else {
      this.retrySeconds[file] = (this.retrySeconds[file] ?? 0) + seconds;
      this.retried.add(test);
    }
  }

  onEnd(result: FullResult): void {
    const rounded = (times: Record<string, number>, places = 0) =>
      Object.fromEntries(Object.entries(times).map(([key, s]) => [key, Math.round(s * 10 ** places) / 10 ** places]));
    console.log(`e2e file seconds: ${JSON.stringify(rounded(this.seconds))}`);
    if (Object.keys(this.retrySeconds).length > 0) console.log(`e2e retry seconds: ${JSON.stringify(rounded(this.retrySeconds))}`);

    const retries: Retried[] = [...this.retried].map((test) => ({
      test: this.name(test),
      project: test.parent.project()?.name ?? "",
      attempts: test.results.length,
      outcome: test.outcome(),
      // ANSI colour codes from expect's messages.
      // eslint-disable-next-line no-control-regex
      error: (this.firstErrors.get(test) ?? "").replace(/\u001b\[[0-9;]*m/g, "").slice(0, 200),
    }));
    const planned = Number(process.env["E2E_PLANNED_SECONDS"]);
    const cpu = cpus();
    const times = {
      version: 1,
      runner: process.env["E2E_RUNNER"] ?? null,
      shard: process.env["E2E_SHARD"] ?? null,
      projects: [...this.projects].sort(),
      cpu: cpu[0]?.model ?? "unknown CPU",
      cores: cpu.length,
      // passed, failed, timedout or interrupted. A run stopped part way has
      // not timed every file, and scripts/e2e-timings.mjs leaves it out.
      status: result.status,
      plannedSeconds: Number.isFinite(planned) && planned > 0 ? planned : null,
      seconds: rounded(this.seconds),
      testSeconds: rounded(this.testSeconds, 1),
      retrySeconds: rounded(this.retrySeconds),
      retries,
    };
    writeFileSync(process.env["E2E_TIMES_FILE"] ?? "e2e-times.json", `${JSON.stringify(times, null, 2)}\n`);
  }

  printsToStdio(): boolean {
    // The list reporter writes the run's progress.
    return false;
  }
}

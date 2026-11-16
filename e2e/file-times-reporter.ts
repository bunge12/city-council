// A Playwright reporter for CI logs. When a run starts it prints the
// machine's CPU, and when it ends it prints how many seconds each spec file
// took, on one line that scripts/e2e-timings.mjs reads back into
// e2e/projects.json.
//
// GitHub's runners are not all the same speed. On 16 November 2026 the same
// tests on the same runner image took 1.5 to 2 times as long on some runners
// as on others (issue #152), and the logs did not say what the machine was.

import { cpus, totalmem } from "node:os";
import { basename } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

export default class FileTimesReporter implements Reporter {
  /** Seconds of each file's first attempts, the figure projects.json keeps. */
  private readonly seconds: Record<string, number> = {};
  /** Seconds spent on retries, printed apart: a retry is a flake, not the file's length. */
  private readonly retrySeconds: Record<string, number> = {};

  onBegin(): void {
    const cpu = cpus();
    console.log(`machine: ${cpu.length} x ${cpu[0]?.model ?? "unknown CPU"}, ${Math.round(totalmem() / 2 ** 30)} GB`);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const file = basename(test.location.file);
    const into = result.retry === 0 ? this.seconds : this.retrySeconds;
    into[file] = (into[file] ?? 0) + result.duration / 1000;
  }

  onEnd(): void {
    const rounded = (times: Record<string, number>) =>
      Object.fromEntries(Object.entries(times).map(([file, s]) => [file, Math.round(s)]));
    console.log(`e2e file seconds: ${JSON.stringify(rounded(this.seconds))}`);
    if (Object.keys(this.retrySeconds).length > 0) console.log(`e2e retry seconds: ${JSON.stringify(rounded(this.retrySeconds))}`);
  }

  printsToStdio(): boolean {
    // The list reporter writes the run's progress.
    return false;
  }
}

// Runs one CI e2e runner's share on this machine, the way CI runs it
// (issue #234). `pnpm e2e:shard` calls it.
//
//   pnpm e2e:shard 3/6
//   pnpm e2e:shard 2/3 --project roads
//   pnpm e2e:shard 1/3 --project perf --trace off
//
// The share and --project go to scripts/e2e-shard.mjs, which prints the
// spec files (or, for roads, the test list) that runner gets. The project
// is chromium unless --project says otherwise. Every other argument goes to
// Playwright. As in .github/workflows/ci.yml and perf.yml, it runs with one
// worker, adds --no-deps for every project but chromium, skips the
// production build (E2E_DEV_SERVER_ONLY=1), prints the load and task
// budgets rather than holding them, and runs under `xvfb-run -a` on a Linux
// machine with no display. It does not apply CI's --global-timeout, which
// is planned from CI's seconds, not this machine's.
//
// CI runs chromium on 6 runners, roads on 3, perf on 3 and evidence on 2.

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const share = args.shift();
if (!share || !/^\d+\/\d+$/.test(share)) {
  console.error("usage: pnpm e2e:shard <n>/<total> [--project chromium|roads|perf|evidence] [playwright args]");
  process.exit(1);
}
const at = args.indexOf("--project");
const project = at >= 0 ? args.splice(at, 2)[1] : "chromium";

const dealt = spawnSync(process.execPath, ["scripts/e2e-shard.mjs", share, "--project", project], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
if (dealt.status !== 0) process.exit(dealt.status ?? 1);
const files = dealt.stdout.trim().split(/\s+/).filter(Boolean);
console.log(`${project} ${share}: ${files.join(" ")}`);

const playwright = ["pnpm", "e2e", "--project", project, ...(project === "chromium" ? [] : ["--no-deps"]), "--workers=1", ...args, ...files];
const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const command = headless ? ["xvfb-run", "-a", ...playwright] : playwright;
const run = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  env: { E2E_DEV_SERVER_ONLY: "1", E2E_LOAD_BUDGET: "report", E2E_TASK_BUDGET: "report", ...process.env },
});
if (run.error) {
  console.error(headless && run.error.code === "ENOENT" ? "xvfb-run not found: install xvfb, or run with a display" : run.error.message);
  process.exit(1);
}
process.exit(run.status ?? 1);

// Runs a walkthrough against the public address and stops it when a newer
// push has replaced the site. deploy.yml's walkthrough jobs call it.
//
//   node scripts/walkthrough-public.mjs xvfb-run -a pnpm e2e --project walkthrough ...
//
// It runs the command it is given and, every 20 seconds, asks GitHub whether
// a github-pages deployment newer than this run's is going out or is out.
// When one is, the public address serves the newer build or will within
// seconds, so the walkthrough would no longer test the commit it names. The script then
// stops the command and exits 0 with a notice, and the job ends green.
//
// deploy.yml used to cancel the walkthrough through a concurrency group. A
// cancelled job leaves the whole run "cancelled", which GitHub shows as a
// failed check on the commit, so three merges in a row left two red marks
// that meant nothing. The newer run's walkthrough covers the older commit's
// changes, and a failure there is reported.
//
// A command that fails while a newer deployment is replacing the site is
// counted as replaced too: it may have loaded half of each build.
//
// It reads GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN.
// Without a repository and a commit it only runs the command. A question
// GitHub does not answer counts as "not replaced".

import { spawn } from "node:child_process";

const POLL_MS = Number(process.env.WALKTHROUGH_POLL_MS ?? 20_000);
/** How long the command gets to stop on its own before it is killed. */
const STOP_MS = Number(process.env.WALKTHROUGH_STOP_MS ?? 30_000);

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: node scripts/walkthrough-public.mjs <command> [args]");
  process.exit(1);
}

const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const token = process.env.GITHUB_TOKEN;

async function ask(path) {
  const response = await fetch(`${api}/repos/${repo}/${path}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

/**
 * The newer commit when one has replaced this run's on the site, or null.
 *
 * GitHub records a deployment as soon as its deploy job is created, minutes
 * before that job gets through the `pages` group and a runner, and the site
 * serves this run's commit all that time. So a deployment counts only once
 * its newest status says it is going out or is out. The list is newest first
 * and stops at this run's own deployment.
 */
async function replacedBy() {
  if (!repo || !sha) return null;
  try {
    for (const deployment of await ask("deployments?environment=github-pages&per_page=10")) {
      if (deployment.sha === sha) return null;
      const [status] = await ask(`deployments/${deployment.id}/statuses?per_page=1`);
      if (status?.state === "in_progress" || status?.state === "success") return deployment.sha;
    }
  } catch {
    // Not answered: carry on as not replaced.
  }
  return null;
}

function replaced(by, how) {
  console.log(`::notice title=Walkthrough replaced::${by} was deployed ${how}, so the public address no longer serves ${sha}. Stopped without a result; the newer run's walkthrough covers this commit.`);
  process.exit(0);
}

const early = await replacedBy();
if (early) replaced(early, "before this walkthrough started");

// Its own process group, so stopping it also stops Xvfb and the browsers.
const child = spawn(command[0], command.slice(1), { stdio: "inherit", detached: true });
const signal = (name) => {
  try {
    process.kill(-child.pid, name);
  } catch {
    // Already gone.
  }
};
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => signal(name));

let stoppedFor = null;
const poll = setInterval(async () => {
  if (stoppedFor) return;
  const by = await replacedBy();
  if (!by || stoppedFor) return;
  stoppedFor = by;
  signal("SIGINT");
  setTimeout(() => signal("SIGKILL"), STOP_MS).unref();
}, POLL_MS);

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", async (code) => {
  clearInterval(poll);
  if (stoppedFor) {
    // Whatever in the group outlived its parent.
    signal("SIGKILL");
    replaced(stoppedFor, "while this walkthrough ran");
  }
  if (code === 0) process.exit(0);
  const late = await replacedBy();
  if (late) replaced(late, "as this walkthrough failed");
  process.exit(code ?? 1);
});

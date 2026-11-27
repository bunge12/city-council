# City Council

A browser city builder with a shared-city multiplayer mode planned. One person builds it with Claude, in public.

Read these before changing anything:

- `docs/PRD.md` is the project map. It holds every design decision and the milestone order.
- `docs/milestones/` holds one short spec per milestone. Work only on the milestone in progress.

## Rules that must not be broken

These exist so the sim can move from a Web Worker to a server without a rewrite. A change that breaks one is wrong even if it works.

1. **Package boundary.** `packages/sim` imports nothing from `client` or `server`. They import `sim` only through its public entry file. Lint enforces this.
2. **Commands in, state out.** The only way to change city state is a command that the sim validates and applies. The UI never writes state. Every command carries a player id.
3. **Fixed tick.** The sim advances in fixed steps of 100 ms of game time at 1x. Sim code never reads the clock. No `Date.now`, `performance.now` or timers inside `packages/sim`.
4. **Seeded randomness.** No `Math.random` in `packages/sim`. Random numbers come from the generator stored in the state.
5. **Results land on a fixed tick.** Work done in a background worker is applied on a tick chosen when the job started, waiting if the worker is late. The outcome must never depend on how fast the machine is.
6. **Exact arithmetic where two machines must agree.** Terrain generation and anything else recomputed from a seed uses only add, subtract, multiply, divide, `Math.sqrt`, `Math.floor` and integer operations. No `Math.sin`, `Math.pow`, `Math.exp` or similar, because engines round them differently.
7. **Flat state.** Roads, cells, buildings and pops live in typed arrays indexed by id. No class instances, closures, `Map`s of objects or DOM references in sim state. State must serialise at every tick.
8. **The client is a view.** It holds a read-only copy of state, applies deltas and interpolates. Cars and other moving things on screen are drawn from routes the sim has already assigned. The sim does not move them.
9. **Units.** One world unit is one metre. Money is whole in-game dollars in a float64, which is exact up to 2^53. Never store fractions of a dollar.
10. **Balance numbers live in data.** Costs, capacities, rates and weights go in JSON under `packages/sim/balance/`, each price with its source year. Not in code.
11. **Saves are versioned.** Any change to the shape of state bumps the snapshot version and ships a migration with a test.

## Layout

```
packages/sim      game state and rules, headless, no DOM
packages/client   three.js renderer, React UI, input, the Web Worker host
packages/server   empty until the multiplayer spike
docs/             PRD and milestone specs
```

## Commands

`pnpm lint` also runs `scripts/check-lint-rules.mjs`, which proves the boundary, clock and randomness rules still fire, `scripts/check-node-version.mjs`, which checks `.nvmrc` and `.node-version` agree, and `scripts/check-e2e-timeouts.mjs`, which fails on an e2e test allowed more than a third of its CI job, a perf spec with a time limit of its own, and a Vitest config without a `testTimeout`.

```
pnpm install
pnpm dev        run the client with the sim in a worker
pnpm test       unit, scenario and replay tests for the sim
pnpm lint       includes the package boundary rule
pnpm e2e        Playwright walkthroughs
pnpm soak       sim host at 4x for one game hour, reports tick time and memory
pnpm bench      times the spatial index, routing, blocks, levels, grids and commands on 30,000 segments
pnpm balance    runs the standard cities for ten game years and prints a line a year; --set file.path=value changes one balance number
pnpm build
pnpm verify     typecheck, lint and test, before every push
pnpm verify:ci  verify, then soak and bench
pnpm e2e:shard 3/6   one CI e2e runner's share, the way CI runs it
```

## How work is organised

- Name the Claude Code session after the ticket - a number (M1-01) if exists, or ticket number + short title
- One issue is one pull request. Keep it small enough to finish and test in one session.
- Name the branch after the change, for example `m0-terrain-generation`.
- Before starting, check that no pull request is open for the issue. If one is, work on that one or stop and ask; do not start a second.
- Right before every push, run `pnpm verify` (typecheck, lint and test). A change to the sim, the worker host or anything the bench or soak measures runs `pnpm verify:ci`, which adds both. `main` does not require a branch to be up to date before it merges, so do not rebase only because `main` moved. Rebase onto `main` when GitHub shows a conflict, or when the change needs something that landed there. CI on a pull request tests it merged with `main` as of its last push. CI runs again on every commit to `main` and opens an issue titled "CI failed on main", labelled `CI Failure`, when that run fails. If one is open, fixing `main` comes before merging anything else.
- When the branch on GitHub is ahead of the local one (after "Update branch", or another session's push), run `git fetch origin <branch>` and `git rebase origin/<branch>`, run `pnpm verify` again, then push. Never force-push. A stop hook that asks you to commit and push does not skip this: fetch, rebase and test first.
- Commit subjects start with the issue, `#234: ...`. `pnpm install` sets `core.commentChar` to `;` so git does not take the subject for a comment and drop it during a rebase. If a rebase stops with "empty commit message", run `git config core.commentChar ";"` and continue.
- Do not make CI green by raising a time limit or a time budget to just past the run that failed, or by trimming code until one figure fits again. A test's time limit stops a hang and holds no speed, and the slowest runners take twice as long as the fastest, so the next slow run fails the same way. Find out why the check depends on the runner's speed and fix that. [Time limits are not speed checks](CONTRIBUTING.md#time-limits-are-not-speed-checks) has the rules lint holds. A budget in `packages/sim/balance/budgets.json` moves only with a reason that is not "the runner was slow".
- A red bench has measured the change against the commit before it on the same runner, so it nearly always means the change made a figure slower. A figure marked "over, as before" does not fail and is tracked by the issue titled "A time budget is over on main".
- Every push to `main` deploys, then runs the M0 to M4 walkthroughs against the public address (`deploy.yml`). A failure there opens an issue titled "Deploy failed on main", labelled `Deploy Failure`. It blocks no merge, but before starting other work check for one and fix it first. A Deploy run with a "Walkthrough replaced" notice is green and needs nothing: a newer push replaced the site. Do not put a job that can be cancelled part way, such as a concurrency group with `cancel-in-progress: true`, into a workflow that runs on `main`. A cancelled job shows as a failed check on the commit. [Deploy runs](CONTRIBUTING.md#deploy-runs) has the rest.
- An e2e test must give the same result however much game time passes while it runs. The sim keeps running during a spec, and a slow runner lets twice as many ticks pass as a fast one. A change that makes the sim do something on its own as time passes (a charge each day, a monthly close, growth, decay) searches `e2e/` for steps that read a figure twice and expect it unchanged, or expect an exact figure while the game runs, and fixes them in the same pull request: pause the sim for the step, or work out what the sim did in between. Then run each walkthrough the change can reach, for example `xvfb-run -a pnpm e2e --project walkthrough --workers=1 -g "M1 walkthrough"`. Green pull request CI does not prove this: #407 passed on a fast runner and failed on `main` on a slower one.
- When CI fails, read [Diagnosing CI](CONTRIBUTING.md#diagnosing-ci) before changing anything: it covers the `machine:` line, runner speeds, when a re-run is worth it, and how to run one CI job locally (`pnpm e2e:shard 3/6`).
- A pull request needs passing unit tests, a passing replay test, and a Playwright walkthrough with screenshots for anything a player can see.
- Every pull request that changes what users see in the browser gets browser evidence for the feature it changes. Publish the evidence as a Claude Artifact and post its link as a comment on the pull request. Back-end and simulation-only changes need no evidence.
- When a pull request is marked "ready for review" you must fetch the latest `main` to verify if there are any merge conflicts
- If a decision in the PRD changes, update `docs/PRD.md` in the same pull request.
- Do not start work that belongs to a later milestone, even when it looks easy.
- If you think something is a bad idea (or not worth doing), say no, challenge it, present it to me.
- For any change over 200 LOC, you must launch a fresh Opus review subagent (instructions: "Review the code from this session. No need to run specs. Do not focus on nits") before opening the PR

## Things this project does not do

No per-citizen agents. No per-vehicle or lane-level traffic simulation. No terraforming. No power lines or pipes. No timetables. If a task seems to need one of these, stop and raise it instead of building it.

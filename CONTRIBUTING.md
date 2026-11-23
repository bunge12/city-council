# Contributing

Thanks for looking. This project is built in the open by one person with Claude, and help is welcome.

## Before you start

1. Read [docs/PRD.md](docs/PRD.md) for the plan and [CLAUDE.md](CLAUDE.md) for the rules the code follows. The rules are short and they matter more than style.
2. Pick an open issue from the milestone in progress. Issues for later milestones do not exist yet on purpose.
3. Check that no pull request is already open for the issue, then comment on it so two people do not build the same thing.

## Setup

You need Node 22 and pnpm 10. The exact Node version is in `.nvmrc` and `.node-version`, so nvm, nodenv, fnm and asdf all pick it up. Change both together; `pnpm lint` fails if they differ. `corepack enable` picks the pinned pnpm.

```
pnpm install
pnpm dev
```

`pnpm install` also sets `core.commentChar` to `;` in this clone's git config (`scripts/git-setup.mjs`). Commit subjects here start with the issue, `#204: ...`, and while git edits a message, as in `git rebase --continue` after a conflict, it drops lines that start with `#`, the subject with them. To set it by hand: `git config core.commentChar ";"`.

## Tests

```
pnpm test    sim unit, scenario and replay tests, client protocol tests
pnpm lint
pnpm verify  typecheck, lint and test: run it before every push
pnpm e2e     Playwright walkthroughs
pnpm soak    one hour of game time at 4x, headless; writes packages/client/soak-report.json
```

`e2e/walkthrough.spec.ts` is the M0 exit test. It runs in its own Playwright project against a production build, once on WebGPU and once with `?webgl`, and saves a screenshot of each step under `walkthrough-screenshots/`. It opens a real browser window, because headless Chromium cannot show a WebGPU canvas. On Linux without a display, run the e2e suite under `xvfb-run -a`. To check the deployed game, point the walkthrough at it:

```
BASE_URL=https://bunge12.github.io/city-council/ pnpm e2e --project walkthrough
```

`e2e/roads.spec.ts` checks road rendering in its own `roads` project, also headed, against the dev server. It draws a fixture city on WebGPU and with `?webgl` and compares both with the same baseline screenshots in `e2e/roads.spec.ts-snapshots/`. If you change how roads look on purpose, refresh them with `xvfb-run -a pnpm e2e --project roads --update-snapshots` and say why in the pull request. It draws at the Low graphics preset, so shadows do not move the pictures.

Every e2e test starts with the Low preset kept in the browser (see `playwright.config.ts`), so the first-run benchmark does not run in each fresh browser. `e2e/presets.spec.ts` clears it to test the benchmark. For frame times per preset on the M1 scale city, run `e2e/scale.spec.ts` with `SCALE_PRESET` set to `low`, `balanced` or `high`. Add `SCALE_WEBGPU=1` and `--project roads` to measure on WebGPU instead of `?webgl`.

Specs open their fixture cities with `openCity` from `e2e/helpers.ts`, which also has `ready`, `frames`, `settle` and `canvasShot`. Use those rather than writing your own. `openPage` and `openCity` add `?flush` to the address, which gives the page `view.flush()`: `settle` calls it to build every pending chunk at once rather than wait for the per-frame budget, and waits for `data-render-settled` on the canvas (issue #223). `settleThroughFrames` waits for the budget instead, without a flush. `openCity` loads the page once: the page's `?load=` address names a city file that `page.route` answers, and the worker stores and opens that file in place of any other city, with no import and no reload. `canvasShot` takes a screenshot of the page clipped to the canvas. A screenshot of the canvas element waits for the canvas to stop changing, which takes twice as long in software rendering.

The specs that measure frame time and memory are the `perf` project, and the ones that only take pictures are the `evidence` project. Both are listed in `e2e/projects.json`. They are the slowest in the suite and do not gate a merge. A failure on `main` opens an issue labelled `Perf Failure`. `.github/workflows/perf.yml` runs them nightly, after every push to `main`, and on a pull request that touches `packages/client/src/render/` or carries the `perf` or `evidence` label. On a pull request a failing test leaves the run green, and its job summary shows each perf figure next to `main`'s. Add the `evidence` label to a pull request that changes how the city looks but not the renderer. Run either project alone with `xvfb-run -a pnpm e2e --project perf --no-deps`. Without `--no-deps`, `--project perf` runs the whole suite first, so nothing else shares the machine while it measures.

CI deals spec files, and the roads project's tests, out to its runners by the seconds in `e2e/projects.json`. A new spec file, or a new test in `roads.spec.ts`, `cells.spec.ts` or `buildings.spec.ts`, fails CI until it has a figure there, and the message says what to add: its seconds with one worker on your machine, times 1.5. Don't change the other figures by hand. A weekly workflow replaces them with what CI measured, and lists every test that passed only on a retry in the issue titled "Flaky tests". See `node scripts/e2e-shard.mjs --list 6` for the current plan.

The replay tests feed a recorded command log and a seed to the sim and compare a hash of the final state. If one fails after your change, the sim has become nondeterministic or its behaviour changed. Both need an explanation in the pull request.

Fixtures live in `packages/sim/test/fixtures/replay/`. Each holds a seed, a log, the tick to replay to and the expected hash. When a change to the sim is meant to change the result, the failing test prints the new hash. Put it in the fixture and say why in the pull request.

## Diagnosing CI

Before reading a red run, make sure it is the newest. A push or "Update branch" cancels the pull request's run in flight. `check`, the one required job, does not run on a cancelled run (issue #220), and anything red on a run that a later push replaced means nothing, including a failed `check` on runs from before that change. Look at the latest run for the head commit.

`check` fails when any of `lint-build`, `test`, `soak`, `bench` or `e2e` failed, and its log line names which. Open that job.

### Where things are

- **The CPU.** The soak, bench and e2e jobs print `machine:` with the runner's core count, CPU model and memory near the top. Read it first: the same commit takes twice as long on the slowest runners as on the fastest (see below).
- **e2e times.** Each e2e job prints `e2e file seconds: {...}` at the end of its test step, and uploads the same figures as `e2e-times-<runner>`. The `e2e-summary` job's run summary has a table of every runner with its CPU, planned minutes, minutes taken and the ratio, and lists every test that needed a retry, since with `retries: 1` a test that fails once and then passes leaves its job green.
- **The plan.** `e2e/projects.json` holds the seconds each spec file (and each roads test) took on CI, which `scripts/e2e-shard.mjs` uses to deal them out to runners, and the `globalTimeout` rule. `node scripts/e2e-shard.mjs --list 6` prints every chromium runner's files and planned minutes.
- **Budgets.** The soak and bench jobs put a table of every held figure, its budget and its headroom in their job summary (`scripts/budget-table.mjs`). A figure under its headroom gets a warning annotation before it fails.
- **Reports.** Every e2e job uploads `playwright-report-<runner>`; see [Reading an e2e failure](#reading-an-e2e-failure).

### A slow runner or a regression

Divide the runner's minutes by its plan, from the `e2e-summary` table. Then compare with the table below for that runner's CPU. A ratio near the CPU's usual figure is that runner, not your change. A ratio well above it, on a fast CPU, or the same test slow on several runners with different CPUs, is your change. A test that fails on an assertion, not a time limit, is your change whatever the runner.

For the soak and bench, a missed budget is already run a second time inside the job (issue #231), and the job fails only when the second attempt misses too.

The bench job also runs the bench on the commit before your change first, on the same runner, and its table has that figure in the "Before" column (issue #319). A figure over its budget fails your change when your change put it there or made it more than 1.15 times slower. One that was over already is marked "over, as before" and does not fail: the runner is slow, or an earlier change left it over, and the issue titled "A time budget is over on main" tracks that. So a red bench now means your change: compare "Measured" with "Before". The soak has no base, and its counts of slow steps already allow for a runner's pauses.

### When a re-run is worth it

Re-run the failed jobs when the job timed out or the soak missed its budget on one of the slower CPUs, and nothing else in the run points at your change. A bench that is red after its own retry has measured your change against the code before it on the same runner, so a re-run seldom changes it. GitHub draws a new runner, and a re-run that lands on a faster CPU often passes. Do not re-run an assertion failure, a lint or type error, a test that failed on a fast CPU, or a failure you can reproduce with the commands below. If a test passes only on a retry or a re-run, it is flaky: it appears in the run summary and in the weekly "Flaky tests" issue, and wants an issue of its own.

### Time limits are not speed checks

A test's time limit stops a test that hangs. It is not there to hold the test's speed, because the slowest runners take twice as long as the fastest. When a test times out on a slow runner, do not raise its limit to just past that run: the next slow run passes it again. `cells-scale.spec.ts` went from 10 minutes to 15 to 18 that way in four days.

- Unit tests have a minute each (`testTimeout` in both Vitest configs), and `pnpm lint` fails a config without it.
- Every perf spec calls `test.setTimeout(PERF_TEST_TIMEOUT)` from `e2e/measure.ts`, which is `perfLimit` in `e2e/projects.json`, 40 minutes. `pnpm lint` fails a perf spec that sets a number of its own, and fails when that limit is under 2.5 times the longest perf file's measured seconds. If the weekly timings change trips that, split the spec or make it cheaper.
- The other e2e projects keep a limit per file. Give a new test about 2.5 times what it takes on your machine (see the table below), and no more than a third of its job.

A speed you want to hold goes in `packages/sim/balance/budgets.json` and a bench, where it is measured many times and judged against the code before your change.

### Refreshing the timings

Don't edit the figures in `e2e/projects.json` by hand, except a new spec file's or roads test's, which CI asks for: its seconds with one worker on your machine, times 1.5. `.github/workflows/e2e-timings.yml` runs `scripts/e2e-timings.mjs` every Monday over the week's runs on `main`, and opens a pull request with the new figures. To refresh them sooner, run that workflow by hand from the Actions tab ("Run workflow"). When the repository does not let Actions open pull requests, the run pushes the branch and opens an issue titled "e2e timings are ready" with a link that opens the pull request.

### Running a CI job on your machine

Before every push, run what the `lint-build` and `test` jobs run:

```bash
pnpm verify
```

That is `pnpm typecheck`, `pnpm lint` and `pnpm test`. A change to the sim, the worker host, or anything the bench or soak measures needs the `soak` and `bench` jobs too:

```bash
pnpm verify:ci
```

To run one e2e runner's share the way CI does, with one worker, the dev server only, and under `xvfb-run -a` on Linux without a display:

```bash
pnpm e2e:shard 3/6
```

CI has six chromium runners. Add `--project roads` (three runners), `--project perf` (three) or `--project evidence` (two) for the others; those get `--no-deps`, so the rest of the suite does not run first. Any other argument goes to Playwright, for example `--trace off` or `--list`. To run a single roads, perf or evidence spec without the dealer, give it `--no-deps` yourself:

```bash
xvfb-run -a pnpm e2e --project roads --no-deps --workers=1 e2e/roads.spec.ts
```

### Reading an e2e failure

Every e2e job uploads `playwright-report-<runner>`, whatever its result. In it, `test-results/` holds a screenshot of each failed attempt and the trace of each test that failed its first attempt: its steps, console, network and source, with no screenshots or DOM snapshots, which would slow every test by about half on a runner drawing in software. Open the trace with `npx playwright show-trace <path>/trace.zip`, or open `playwright-report/index.html`. A test still running when Playwright's time limit stops the run gets a screenshot but no trace.

Each runner's Playwright run stops at three times its planned minutes, with a ten minute floor (`globalTimeout` in `e2e/projects.json`), and never before its plan plus every attempt of its longest test, so a retry still fits. It then fails with its report, before GitHub's job limit would stop it with none. The walkthrough runners have nothing to deal and set their limit in minutes as `limit:` in `ci.yml`. `pnpm lint` runs `scripts/check-e2e-timeouts.mjs`, which fails when a test's limit is over a third of its CI job's: a test that times out runs again, and the runner's other files need the rest. It also fails when a `limit:` cannot hold every attempt of its runner's longest test with two minutes to spare, or leaves less than three minutes of the job. The perf project does not retry, so a perf test may take half of its job; its one limit is described under [Time limits are not speed checks](#time-limits-are-not-speed-checks).

### Runners are not the same speed

CI runners have 4 virtual CPUs and no GPU, and they are not all the same speed. The e2e jobs print their CPU as `machine:` near the top of the test step. Over 300 e2e jobs in the 25 CI runs before 19 November 2026, with each runner's time as a multiple of its files' planned seconds (the median per CPU):

| CPU | Share of runners | Time against plan | Against the fastest |
| --- | ---: | ---: | ---: |
| AMD EPYC 9V45 | 15% | 0.76 | 1.0 |
| Intel Xeon 6975P-C | 10% | 0.96 | 1.3 |
| AMD EPYC 9V74 | 33% | 1.18 | 1.6 |
| Intel Xeon Platinum 8370C | 3% | 1.52 | 2.0 |
| AMD EPYC 7763 | 30% | 1.60 | 2.1 |
| Intel Xeon Platinum 8573C | 8% | 1.60 | 2.1 |

To run a spec on as many cores as a runner, pin it with `taskset` and give it a display:

```bash
E2E_DEV_SERVER_ONLY=1 taskset -c 0-1 xvfb-run -a pnpm e2e --project chromium --workers=1 --trace off e2e/grid-tool.spec.ts
```

`E2E_DEV_SERVER_ONLY=1` skips the production build that only the walkthrough needs. In the development container (Intel Xeon at 2.1 GHz), `e2e/grid-tool.spec.ts` took 87 seconds on two cores and 106 on one, about what it takes on an EPYC 9V45. It took 189 seconds on an EPYC 7763. So a spec that only just passes on two local cores is likely to time out on a slow runner: give it about 2.5 times what it takes here.

## Pull requests

- One issue per pull request.
- Tests pass in CI. There is no second reviewer, so the tests are the gate.
- Run `pnpm verify` before every push. If CI fails, see [Diagnosing CI](#diagnosing-ci).
- If your branch on GitHub has commits your clone lacks, from "Update branch" or another session, fetch it and rebase onto it, test again, then push. Never force-push over it.
- Your branch does not need to be up to date with `main` to merge. Rebase only when GitHub shows a conflict or you need something that landed since. CI runs again on every commit to `main`, and a failure there opens an issue titled "CI failed on main", labelled `CI Failure`. While one is open, fix `main` before merging anything else.
- Anything visible to a player comes with a Playwright walkthrough and screenshots.
- Changes to the shape of saved state come with a version bump and a migration.
- Models, sounds and other assets must carry a licence that can sit in an MIT repository.

## Licence

MIT. By contributing you agree your work is released under it.

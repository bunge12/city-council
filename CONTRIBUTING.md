# Contributing

Thanks for looking. This project is built in the open by one person with Claude, and help is welcome.

## Before you start

1. Read [docs/PRD.md](docs/PRD.md) for the plan and [CLAUDE.md](CLAUDE.md) for the rules the code follows. The rules are short and they matter more than style.
2. Pick an open issue from the milestone in progress. Issues for later milestones do not exist yet on purpose.
3. Comment on the issue so two people do not build the same thing.

## Setup

You need Node 22 and pnpm 10. The exact Node version is in `.nvmrc` and `.node-version`, so nvm, nodenv, fnm and asdf all pick it up. Change both together; `pnpm lint` fails if they differ. `corepack enable` picks the pinned pnpm.

```
pnpm install
pnpm dev
```

## Tests

```
pnpm test    sim unit, scenario and replay tests, client protocol tests
pnpm lint
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

The specs that measure frame time and memory are the `perf` project, and the ones that only take pictures are the `evidence` project. Both are listed in `e2e/projects.json`. They are the slowest in the suite and do not gate a merge. `.github/workflows/perf.yml` runs them nightly, after every push to `main`, and on a pull request that touches `packages/client/src/render/` or carries the `perf` or `evidence` label. On a pull request a failing test leaves the run green, and its job summary shows each perf figure next to `main`'s. Add the `evidence` label to a pull request that changes how the city looks but not the renderer. Run either project alone with `xvfb-run -a pnpm e2e --project perf --no-deps`. Without `--no-deps`, `--project perf` runs the whole suite first, so nothing else shares the machine while it measures.

### When an e2e test fails in CI

Every e2e job uploads `playwright-report-<runner>`, whatever its result. In it, `test-results/` holds a screenshot of each failed attempt and the trace of each test that failed its first attempt: its steps, console, network and source, with no screenshots or DOM snapshots, which would slow every test by about half on a runner drawing in software. Open the trace with `npx playwright show-trace <path>/trace.zip`, or open `playwright-report/index.html`. A test still running when Playwright's time limit stops the run gets a screenshot but no trace.

Each runner's Playwright run stops at three times its planned minutes, with a ten minute floor (`globalTimeout` in `e2e/projects.json`), and never before its plan plus every attempt of its longest test, so a retry still fits. It then fails with its report, before GitHub's job limit would stop it with none. The roads and walkthrough runners have no files to deal and set their limit in minutes as `limit:` in `ci.yml`. `pnpm lint` runs `scripts/check-e2e-timeouts.mjs`, which fails when a test's limit is over a third of its CI job's: a test that times out runs again, and the runner's other files need the rest. It also fails when a `limit:` cannot hold every attempt of its runner's longest test with two minutes to spare, or leaves less than three minutes of the job. The perf project does not retry, since a perf test that timed out on a slow runner times out again.

### Running a spec at CI speed

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

The replay tests feed a recorded command log and a seed to the sim and compare a hash of the final state. If one fails after your change, the sim has become nondeterministic or its behaviour changed. Both need an explanation in the pull request.

Fixtures live in `packages/sim/test/fixtures/replay/`. Each holds a seed, a log, the tick to replay to and the expected hash. When a change to the sim is meant to change the result, the failing test prints the new hash. Put it in the fixture and say why in the pull request.

## Pull requests

- One issue per pull request.
- Tests pass in CI. There is no second reviewer, so the tests are the gate.
- Your branch does not need to be up to date with `main` to merge. Rebase only when GitHub shows a conflict or you need something that landed since. CI runs again on every commit to `main`, and a failure there opens an issue titled "CI failed on main", labelled `CI Failure`. While one is open, fix `main` before merging anything else.
- Anything visible to a player comes with a Playwright walkthrough and screenshots.
- Changes to the shape of saved state come with a version bump and a migration.
- Models, sounds and other assets must carry a licence that can sit in an MIT repository.

## Licence

MIT. By contributing you agree your work is released under it.

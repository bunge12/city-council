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

The replay tests feed a recorded command log and a seed to the sim and compare a hash of the final state. If one fails after your change, the sim has become nondeterministic or its behaviour changed. Both need an explanation in the pull request.

Fixtures live in `packages/sim/test/fixtures/replay/`. Each holds a seed, a log, the tick to replay to and the expected hash. When a change to the sim is meant to change the result, the failing test prints the new hash. Put it in the fixture and say why in the pull request.

## Pull requests

- One issue per pull request.
- Tests pass in CI. There is no second reviewer, so the tests are the gate.
- Anything visible to a player comes with a Playwright walkthrough and screenshots.
- Changes to the shape of saved state come with a version bump and a migration.
- Models, sounds and other assets must carry a licence that can sit in an MIT repository.

## Licence

MIT. By contributing you agree your work is released under it.

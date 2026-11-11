# Contributing

Thanks for looking. This project is built in the open by one person with Claude, and help is welcome.

## Before you start

1. Read [docs/PRD.md](docs/PRD.md) for the plan and [CLAUDE.md](CLAUDE.md) for the rules the code follows. The rules are short and they matter more than style.
2. Pick an open issue from the milestone in progress. Issues for later milestones do not exist yet on purpose.
3. Comment on the issue so two people do not build the same thing.

## Setup

You need Node 22 (the exact version is in `.nvmrc`) and pnpm 10. `corepack enable` picks the pinned pnpm.

```
pnpm install
pnpm dev
```

## Tests

```
pnpm test    sim unit, scenario and replay tests
pnpm lint
pnpm e2e     Playwright walkthroughs
```

The replay tests feed a recorded command log and a seed to the sim and compare a hash of the final state. If one fails after your change, the sim has become nondeterministic or its behaviour changed. Both need an explanation in the pull request.

## Pull requests

- One issue per pull request.
- Tests pass in CI. There is no second reviewer, so the tests are the gate.
- Anything visible to a player comes with a Playwright walkthrough and screenshots.
- Changes to the shape of saved state come with a version bump and a migration.
- Models, sounds and other assets must carry a licence that can sit in an MIT repository.

## Licence

MIT. By contributing you agree your work is released under it.

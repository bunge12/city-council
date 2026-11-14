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

`pnpm lint` also runs `scripts/check-lint-rules.mjs`, which proves the boundary, clock and randomness rules still fire, and `scripts/check-node-version.mjs`, which checks `.nvmrc` and `.node-version` agree.

```
pnpm install
pnpm dev        run the client with the sim in a worker
pnpm test       unit, scenario and replay tests for the sim
pnpm lint       includes the package boundary rule
pnpm e2e        Playwright walkthroughs
pnpm soak       sim host at 4x for one game hour, reports tick time and memory
pnpm bench      times the spatial index, routing, blocks, levels, grids and commands on 30,000 segments
pnpm build
```

## How work is organised

- One issue is one pull request. Keep it small enough to finish and test in one session.
- Name the branch after the change, for example `m0-terrain-generation`.
- Right before every push, fetch `main` and rebase onto it, then run `pnpm typecheck`, `pnpm lint` and `pnpm test`. `main` moves while you work, and branch protection needs the branch up to date. Checking once at the start is not enough.
- A pull request needs passing unit tests, a passing replay test, and a Playwright walkthrough with screenshots for anything a player can see.
- Every pull request that changes what users see in the browser gets browser evidence for the feature it changes. Publish the evidence as a Claude Artifact and post its link as a comment on the pull request. Back-end and simulation-only changes need no evidence.
- If a decision in the PRD changes, update `docs/PRD.md` in the same pull request.
- Do not start work that belongs to a later milestone, even when it looks easy.

## Things this project does not do

No per-citizen agents. No per-vehicle or lane-level traffic simulation. No terraforming. No power lines or pipes. No timetables. If a task seems to need one of these, stop and raise it instead of building it.

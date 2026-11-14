# City Council

A city builder that runs in a desktop browser. Free-form roads, zoning along them, demand, traffic, transit and services, with one city that several people can build together from a shared link.

One person builds it with Claude, in the open.

Play the current build at <https://bunge12.github.io/city-council/>. It is redeployed on every merge to `main`.

## Where it stands

It is early. You can lay out a road network on a generated map, but nothing grows on it yet.

M0, the foundation, is done:

- A 12 km map generated from a seed, with land, water, trees and grass
- Orbit, pan and zoom, on WebGPU with a WebGL 2 fallback
- The simulation running in a Web Worker at 10 ticks a second, with pause, 1x, 2x and 4x
- Saves in the browser, plus download and import of a city as a `.city` file
- An activity log of every command, and replay tests that rebuild a city from its seed and that log

M1, road networks, is done:

- Streets, avenues and one-way roads, straight or curved, that split and join into intersections where they meet
- Snapping to nodes, segments and angles, with guide lines, a parallel offset and a length snap
- A grid tool that lays out a block grid in one drag and one click
- Bridges where a road crosses water, and roads at different levels that cross without an intersection
- Upgrade, bulldoze and undo
- A pathfinder that routes between any two connected points, and outside connections at the map edge
- Blocks enclosed by roads, found and outlined in the debug panel
- A scale check on a generated network of 30,000 segments

M2, zoning and buildings, is next. The player paints five zones at three densities on cells along the roads, and buildings appear on them. It also brings lighting, shadows, three graphics presets and the first building models. The spec is [docs/milestones/M2.md](docs/milestones/M2.md) and the work is in the [issues labelled M2](https://github.com/bunge12/city-council/issues?q=is%3Aissue+label%3AM2).

## Roadmap

Twelve milestones, built in order. There are no dates. The full table, with the exit test for each, is in [the PRD](docs/PRD.md#module-roadmap).

| # | Milestone | Status |
| --- | --- | --- |
| M0 | Foundation and terrain | Done |
| M1 | Road networks | Done |
| M2 | Zoning and buildings | Next |
| M3 | Demand | |
| M4 | Economy | |
| M5 | Traffic | |
| M6 | Public transport: buses | |
| M7 | Rail transport | |
| M8 | Services | |
| M9 | Utilities | |
| M10 | Multiplayer | |
| M11 | Polish and launch | |

v1 is done when two people can open a link, build a working city of 500,000 residents together, and come back the next day to find it as they left it.

## Run it

You need Node 22 and pnpm 10. The exact Node version is in `.nvmrc`.

```
pnpm install
pnpm dev
```

Then open the address Vite prints. Add `?webgl` to the address to force the WebGL 2 path, and `?preset=low`, `?preset=balanced` or `?preset=high` to force a graphics preset. The backquote key opens the debug panel.

```
pnpm test    unit, scenario and replay tests
pnpm lint
pnpm e2e     Playwright walkthroughs
pnpm soak    one hour of game time at 4x, reporting tick time and memory
pnpm bench   times the hot sim queries on a 30,000 segment network
pnpm build
```

## How it is built

The code is three packages.

```
packages/sim      game state and rules, headless, no DOM
packages/client   three.js renderer, React UI, input, the Web Worker host
packages/server   empty until the multiplayer spike
```

The whole plan rests on one rule. `sim` takes commands and produces state, and it never touches rendering, the clock or `Math.random`. In single player it runs in a worker. In multiplayer the same package will run on a server, and the client will not know the difference. The rules that keep this true are short, and they are in [CLAUDE.md](CLAUDE.md). Lint enforces the ones it can.

## Read more

- The plan and every design decision: [docs/PRD.md](docs/PRD.md)
- The next milestone: [docs/milestones/M2.md](docs/milestones/M2.md)
- The ones before it: [M1](docs/milestones/M1.md) and [M0](docs/milestones/M0.md)
- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md)

MIT licensed.

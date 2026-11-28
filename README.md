# City Council

A city builder that runs in a desktop browser. Free-form roads, zoning along them, demand, traffic, transit and services, with one city that several people can build together from a shared link.

One person builds it with Claude, in the open.

Play the current build at <https://bunge12.github.io/city-council/>. It is redeployed on every merge to `main`.

## Where it stands

It is early. You can lay out a road network on a generated map, zone the land along it and watch a town grow. People move in, take jobs and leave when there are none. Every road costs money, buildings pay tax, and the city keeps one budget that closes once a game month.

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

M2, zoning and buildings, is done:

- Five zones at three densities, painted on 8 m cells along the roads
- Buildings that grow on zoned lots, from houses and corner stores to towers, malls and factories, with their own models and colours
- Rezoning that leaves standing buildings in place, and a bulldozer for roads and buildings
- Lighting, shadows and three graphics presets: Low, Balanced and High
- Three levels of detail for buildings, by how far out the camera is
- A scale check on that network grown out to 57,000 buildings

M3, demand, is done:

- People move in from the outside connections, take the jobs their education allows, nearer ones first, and leave after a month without work
- Four demand bars, for residential, commercial, office and industrial, decide what grows and how fast, and their tooltips say why
- An all-residential town stalls until it has work. Each cell builds at the density it is zoned for, so an R3 lot gets a tower straight away
- Births, deaths, children leaving home and households moving on, a little every game day
- Homes and workplaces that people leave stand vacant, then abandoned, and come back when demand does
- Built ground zoned up is redeveloped over game months, and people in a bulldozed home move to others with room
- A first land value from road access, water, the city centre and industry, with an overlay, which decides which lots fill first
- The population and its trend in the top bar, and a statistics panel that graphs a hundred years of history
- Sounds for the tools, wind and construction, with volume settings
- Scale checks on generated cities of 50,000, 200,000 and 500,000 residents

M4, the economy, is done:

- One treasury in whole dollars, in the bottom right, that starts on a grant and may fall to a small overdraft, past which anything that costs money is refused with the price and what is left
- Roads cost 2026 prices to build and a yearly share of that to keep, charged a day at a time
- Property tax on homes, sales tax on shops and output tax on offices and factories, with a rate for each that also moves its demand bar
- Developers pay a development charge on each new building, and a higher charge slows building in that zone
- A budget panel with last month and this month line by line, graphs, tax and charge sliders, and loans the city repays monthly within a credit limit that grows with it
- Clearing an occupied building pays its value, its people's relocation and a premium, shown on the bulldozer before the click, and the people moved are less satisfied for a year
- Population milestones that pay grants and unlock densities 2 and 3, larger loans and City Hall, which goes up on a lot of its own, grows with the city and opens the budget when clicked
- A budget overlay showing which blocks pay their way and which lose money on their roads
- Money sounds, and money in the activity log beside each command
- Scale checks of the same three cities with a treasury, tax rates, a loan and City Hall in them

M5, traffic, is next.

## Roadmap

Twelve milestones, built in order. There are no dates. The full table, with the exit test for each, is in [the PRD](docs/PRD.md#module-roadmap).

| # | Milestone | Status |
| --- | --- | --- |
| M0 | Foundation and terrain | Done |
| M1 | Road networks | Done |
| M2 | Zoning and buildings | Done |
| M3 | Demand | Done |
| M4 | Economy | Done |
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
pnpm balance runs the standard cities for ten game years, a line a year
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
- The milestone in progress: [docs/milestones/M4.md](docs/milestones/M4.md)
- The ones before it: [M3](docs/milestones/M3.md), [M2](docs/milestones/M2.md), [M1](docs/milestones/M1.md) and [M0](docs/milestones/M0.md)
- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md)

MIT licensed.

# M3-20: Scale cities of 50,000, 200,000 and 500,000 residents

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 09, 10, 11.

## Goal

Three generated cities exist to measure every milestone on from here. See "Scale checkpoints" under "Running through every milestone" in the PRD.

## Scope

- A generator in `packages/sim/src/scale.ts` that makes a city of about 50,000, 200,000 or 500,000 residents from a seed: roads, zoning, buildings, pops in their homes and pops in jobs
- The 500,000 city needs more room than the M2 scale town has. Decide whether it gets a denser network, more density 3, or both, and aim for a mix of densities a real game would reach
- Each city has about 0.5 jobs per resident, split between commercial, office and industrial as "Jobs per building" in the PRD works out
- Buildings and pops are placed by the same internal functions the grower and arrivals use, called directly, as `growScaleCity` does. The totals must equal a recount
- Each city is also saved as a city file the Playwright tests can load
- `pnpm bench` gains a file that runs each city for two game days and records the time per system and the worst tick
- The soak run moves to the 200,000 city, with pops arriving, working, leaving and turning over while the bot builds and zones

## Out of scope

- Frame time on the three cities, which is the close-out
- Fixing what the measurements find, beyond opening an issue for each thing over budget
- Traffic on these cities, which is M5

## Done when

- [ ] Each generator run gives a population within 5 percent of its target and the same state hash for the same seed on every run
- [ ] The totals of each city equal a recount
- [ ] The bench records, for each city: pops, buildings, snapshot size, the time per system and the worst tick over two game days. The table is in the pull request
- [ ] Anything over its share of the 20 ms tick has an issue
- [ ] The soak run passes on the 200,000 city, or the pull request says what stops it and links the issue
- [ ] The three city files load in the browser, with the load time of each in the pull request

## Notes

This comes as soon as pops arrive, work, leave and turn over. It is the first sight of the pop systems at full size, while the later issues are still open and can take what it finds into account. Issues 03 and 09 each bench their own part on the M2 scale town before this.

The M2 scale town measured 475,467 residents with every home full, on 57,345 buildings, mostly at density 1. A played city of 500,000 would have fewer, larger buildings. A third of residents in density 3 is a reasonable start.

Generating 500,000 residents through ticks would take game decades, so the generator places them directly. A replay of the command log then gives the roads and zoning only, and the city file carries the rest, as the PRD records for the M2 town.

CI should not generate the 500,000 city on every push. Cache it by seed and balance stamp, or run that bench on a schedule.

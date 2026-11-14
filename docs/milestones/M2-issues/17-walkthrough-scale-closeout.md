# M2-17: M2 walkthrough, scale check and close-out

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: all other M2 issues.

## Goal

The M2 exit test runs automatically, a city full of buildings holds up, and the milestone is closed.

## Scope

- One Playwright walkthrough that performs the fourteen exit test steps in M2.md, on the WebGPU path where the CI browser supports it and on `?webgl`
- Screenshots from the walkthrough saved as CI artifacts and published as browser evidence on the pull request
- The scale city from M1 with every cell zoned and grown out to about 100,000 buildings
- On that city, measure and record: the grower's time per tick, worker time per tick against the 20 ms budget, one `ZoneCells` at the cap, one `BuildRoad` through built ground, one `BulldozeRoad` of a built street, frame time in each zoom band at Low and at Balanced, snapshot size, autosave time and tab memory
- A save and resume test: run a scripted session with zoning and growth straight through, and separately save and reload half way. The final hashes must match
- The soak script extended to zone, rezone and clear buildings while it runs
- `pnpm bench` gains the cell and lot queries
- Update the PRD with every decision M2 made, and tick the M2 row in the roadmap

## Out of scope

- The scale checkpoints at 50,000, 200,000 and 500,000 residents, which start in M3 when pops exist
- Tuning the growth rate and the lot sizes

## Done when

- [ ] The walkthrough passes in CI on the pull request and against the deployed page
- [ ] Every measurement is recorded in the pull request and under "M2 exit numbers" in the PRD, and anything over budget has an issue
- [ ] The save and resume hashes match
- [ ] The M2 row in the PRD roadmap is ticked and `docs/milestones/M3.md` is opened as the next task

## Notes

The PRD asks which two machines are the reference for Low and Balanced. If that is still open here, record the frame times on the CI machine and name the machine each other number came from.

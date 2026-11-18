# M3-01: Demand and pop balance data, and jobs per building

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: M2.

## Goal

Every number M3 runs on has a home in the balance files, and every building knows how many jobs it offers.

## Scope

- `jobsPerCell` on each type in `buildings.json`, with the rates from "Jobs per building" in the PRD. Residential types have 0
- A sim function that gives a building's jobs: `max(1, round(jobsPerCell × width × depth))` for a type that offers any, and 0 otherwise. It reads the building row and the type only
- Which education levels each zone's jobs take, from "What each zone supplies" in the PRD. Mixed offers commercial jobs, and office jobs too at density 3. The split of a building's jobs between the levels is a share in the file
- `packages/sim/balance/pops.json`: the pop size cap per density, the education, wealth and children mix of a newcomer, the share of a pop's people who work, and the turnover rates. Later issues read it
- `packages/sim/balance/demand.json`: the weights of each bar's inputs, the pull from outside for a new city, and the pace of arrivals. Later issues read it
- Both files are checked when the sim loads, like `buildings.json`, and are part of the balance stamp
- `buildingInfo` gives a building's jobs, so the hover readout can show them

## Out of scope

- Pops, demand and anything that reads these files, which are the issues after this one
- `landvalue.json`, which issue 13 adds
- Prices. M3 has no money

## Done when

- [ ] Unit tests give the PRD's worked examples: a corner store on 1 × 1 has 1 job, a strip mall on 6 × 3 has 36, an office tower on 4 × 6 has 840, a small factory on 4 × 4 has 5 and a regional mall on 12 × 12 has 216
- [ ] The scale town measures 247,877 jobs with the table, the number the PRD records, or the pull request says why it differs
- [ ] A test loads each new file with a field missing or out of range and gets a clear error
- [ ] The balance stamp changes, and the test that pins it is updated
- [ ] No change to the shape of state, so no snapshot bump. `pnpm lint` passes

## Notes

Jobs are a function of fields every building row already has. That is why they need no state column, as the PRD records under "Jobs per building".

The files start with the numbers the later issues propose. Each issue that reads one may change its fields, and says so. Every value is a starting value with no source behind it, and the file's `_about` says so. No prices, so no source years.

The 18 game years for a child to leave is the one turnover number the PRD fixes.

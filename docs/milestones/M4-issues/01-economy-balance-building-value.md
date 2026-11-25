# M4-01: Economy balance data and building value

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: M3.

## Goal

Every number M4 runs on has a home in the balance files, and every building has a value in dollars.

## Scope

- `packages/sim/balance/economy.json`: the starting grant, the overdraft, the default tax rate and its range for each of the four sliders, the default development charge and its range per zone, dollars of value per square metre of floor space by zone, floor space per resident and per job, the eminent domain relocation payment per resident and per job and its premium, the demolition cost of a building per square metre of floor space, the refund share for city-owned roads and buildings, the loan terms and the credit limit's weights. Later issues read it
- Every price has an amount, a source year and a source, checked as `roads.json`'s are. A figure with no source says `placeholder: true`
- Construction prices are raised to 2026 by the escalation in `roads.json`, which is a highway construction index. Property values, relocation payments and grants are not construction, so they use 2026 figures or a general price index with its own source
- The file is checked when the sim loads, like the other balance files, and is part of the balance stamp
- Road demolition in `roads.json`, and the yearly upkeep share of build cost that upkeep moves to, get a source where research finds one. The rest stay placeholders and the file says so
- A sim function that gives a building's value in dollars, from the land value at its lot's centre, its floor space and its zone. It reads the building row, the type and the derived land value only
- `buildingInfo` gives a building's value, so the hover readout can show it
- A table in the pull request: the scale cities' total building value by zone and density, and the value per cell at each density

## Out of scope

- The treasury and anything that moves money, which are the issues after this one
- `progression.json`, which issue 12 adds
- Changing redevelopment's worth. This issue measures it and proposes

## Done when

- [ ] Unit tests give a house, a plex, a tower, a corner store and a factory a value from a known land value, and the value rises with land value and with floor space
- [ ] A test loads `economy.json` with a field missing, a price with no source year, and a rate outside its range, and gets a clear error for each
- [ ] The balance stamp changes, and the test that pins it is updated
- [ ] The pull request records the value per cell at each density on the scale cities, against the 1x, 10x and 50x tax per cell the PRD aims for, and says whether redevelopment's worth should move onto this value
- [ ] No change to the shape of state, so no snapshot bump. `pnpm lint` passes

## Notes

Value is a function of fields every building row already has and of land value, which is derived. That is why it needs no state column, like jobs per building in M3-01.

Floor space follows room and jobs, not lot area, because a tower on 4 × 6 cells holds hundreds of people and a house on 2 × 3 holds four. That is what makes tax per cell climb with density as the PRD's table asks.

Search for sources before falling back to placeholders: assessed value per square metre of housing and of commercial floor space in a North American city, relocation assistance under the US Uniform Relocation Act, and municipal road maintenance per lane-km. Each price keeps its year.

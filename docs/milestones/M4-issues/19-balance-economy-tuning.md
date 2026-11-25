# M4-19: Balance check and the economy tuning pass

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 07, 08, 10, 11, 12, 13.

## Goal

The money makes a game: a new city can start, a density 1 suburb roughly breaks even, the dense core carries the city, and growth is not paid for by a trap the player cannot see. See "M4 Economy", "Prices in 2026 dollars" and "Pacing" in the PRD.

## Scope

- `pnpm balance` prints the treasury, income by line and expenses by line for each game year, beside the population figures M3 added
- A standard city that starts from an empty map on the starting grant, as well as M3's
- Settle the "other city spending" decision in M4.md and build what it picks. If it is the per-resident line, add it with its price and source year in `economy.json`, and say in the PRD that M8 and M9 replace it a service at a time
- Tune the starting grant, the tax and charge defaults, building value, upkeep shares, the loan terms and the milestones against these checks: tax per cell near 1x, 10x and 50x at the three densities; a compact density 1 town near zero net; the first town breaking even before density 2 unlocks; the first milestone in the first game hour or so; and the city budget per resident near the PRD's figures by 500,000
- The two scenario tests from the M4 exit test
- Play a few budget cycles at 100 ticks a day and say whether the day length stays. If it changes, change `time.json` and the PRD

## Out of scope

- New systems. Only numbers, and the one spending line if it is chosen
- Tuning M3's demand, beyond what the tax part needs

## Done when

- [ ] `pnpm balance` prints the money for each standard city, and the pull request has the before and after
- [ ] The two scenario tests pass
- [ ] Every number changed is in the balance files, with a reason in the pull request
- [ ] The PRD records the decisions this issue made
- [ ] A replay gives the same state hash. Fixtures are recorded again where the numbers changed them

## Notes

Settle the spending question with the project owner before tuning, since every other figure depends on it.

Use `--set file.path=value` to try numbers without editing files, then commit the ones that hold.

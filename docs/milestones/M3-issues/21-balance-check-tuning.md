# M3-21: Balance check script and the first tuning pass

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 11, 14.

## Goal

A tuning change shows its effect in one command, and M3's starting numbers have been played once. See "Balance checks" under "Testing" in the PRD.

## Scope

- `pnpm balance`: a script that builds a standard city by a fixed list of commands, runs it for ten game years, and prints population, the four bars, unemployment, vacant and abandoned buildings, and births, deaths, arrivals and departures, one line per game year
- It takes a balance override on the command line, so two runs with one number changed can be compared
- A few standard cities, each a script of commands: homes only, a balanced town, a town that loses its industry in year five, and a town rezoned to density 3 in year five
- A first tuning pass over `demand.json`, `pops.json` and `landvalue.json` with the script and by playing, against the targets below
- The table of numbers that changed, with before and after, in the pull request and under "M3 Demand" in the PRD
- CLAUDE.md and the README list the new command

## Out of scope

- Treasury and average commute in the output, which M4 and M5 add
- Tuning lot sizes and resident numbers, unless the open question on lot sizes is answered here
- A balance test that fails CI on drift. The scenario tests already pin behaviour. This script is for reading

## Done when

- [ ] `pnpm balance` runs each standard city in under two minutes and prints the same table on every run
- [ ] The homes-only city stalls under a set population and does not empty
- [ ] The balanced town grows at 12,000 to 22,000 residents a game year while it has zoned room, around the PRD's 17,000
- [ ] No bar in the balanced town changes sign more than a few times a game year
- [ ] The town that loses its industry shrinks, then recovers once industry is zoned again
- [ ] The rezoned town reaches density 3 buildings on at least half its rezoned ground within five game years
- [ ] Jobs per resident in the balanced town settles between 0.4 and 0.6
- [ ] The scenario tests from the sim issues still pass with the tuned numbers, or are updated with the reason

## Notes

The first thing to tune, from the PRD's "Jobs per building": whether office jobs stand in for industrial ones well enough as density rises, or the industrial rates need to go up.

The script steps the sim directly in Node, with no worker and no clock, so ten game years of a small town take seconds.

Playing matters as much as the script. A city that passes every line above can still be dull. Say in the pull request what an hour of play felt like, and open issues for what the numbers cannot fix.

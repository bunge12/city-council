# M3-11: Turnover

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 09.

## Goal

Households change over time at a steady rate, so no district fills or empties all at once. See "Turnover" in the PRD.

## Scope

- A turnover system in the step, a slice of pops per tick, every pop once per game day
- Birth: a pop gains a person and is marked as having children, if its home has room
- A child grows up and leaves: a pop with children loses a person, and after about 18 game years on average no longer counts as having children
- Death: a pop loses a person
- Household replaced: size, education, wealth and children are drawn again, the old job is freed and the newcomer looks for work
- A pop that falls to zero people is removed, and its home stands vacant until demand fills it
- Each event is a chance per pop per day, drawn from the generator in state, with the yearly rates in `pops.json`
- Births and deaths add to the year's counts from issue 04. A replacement counts as a departure and an arrival
- One replacement rate for all housing. The game does not model owning or renting

## Out of scope

- Land value shaping who the newcomer is, which issue 25 adds
- School coverage raising a newcomer's education, and clinics lowering the share of replacements counted as deaths, which are M8
- Ages. A pop does not age and nobody is tracked through a life

## Done when

- [ ] The scenario test M3.md names: a street of houses fills with families, its population dips as children leave over about two game decades, and climbs back toward a steady level. The test asserts the dip and the recovery within bounds
- [ ] A scenario test runs a full city for fifty game years with demand held steady and finds the population within a few percent of where it started, with no wave
- [ ] A test finds births, deaths, arrivals and departures for a year add up to the change in population
- [ ] The totals equal the recount at the end of each test
- [ ] A replay gives the same state hash, and a city saved and reloaded mid-year resumes to the same hash
- [ ] The system's tick time at 150,000 pops is in the pull request

## Notes

Smooth rates are the point. A rate applied per pop per day from the seeded generator gives a few events a day across a district, never a cohort.

A yearly rate becomes a daily chance by dividing by 365. That is exact enough, and it keeps to the arithmetic rule 6 allows.

How deep the dip goes depends on two rates set against each other: how fast children leave and how fast households are replaced. Start with replacement at about 5 percent a year and tune in issue 21.

A fifty-year scenario is 1.8 million ticks. Run it on a small city, and step the sim directly.

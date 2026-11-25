# M4-05: The tax sweep and property tax

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 02.

## Goal

Homes pay a yearly property tax on their value, a day at a time, and the cost of collecting it does not grow with the city in any one tick. See "M4 Economy" in the PRD.

## Scope

- A TAX system that visits each building once a game day, strided by tick as redevelopment does (M3-14), and charges that building's day of tax on the visit
- Residential property tax: the residential rate times the building's value from issue 01, as a yearly amount, with the exact daily share. Mixed buildings pay it on the share of their floor space that is homes
- A building pays only while it has people in it. A vacant or abandoned building pays nothing
- The rate comes from state, where issue 02 put it. The command that changes it is issue 07
- A function gives a building's yearly tax, for the hover readout and the budget overlay

## Out of scope

- Commercial, office and industrial tax, which are issue 06
- Tax feeding demand and satisfaction, which are issue 07
- Wealth changing what a pop pays. A building pays on its value

## Done when

- [ ] Unit tests give a house and a tower a yearly tax from a known value and rate
- [ ] A scenario test runs a town for a game year and finds the residential tax line equal to the sum of each building's yearly tax over the days it was occupied
- [ ] The system's mean and worst tick on the 500,000 resident city are in the pull request, with a share of the tick held in `budgets.json` by the scale cities' bench. The aim is under 1 ms. No test asserts a time
- [ ] A city saved half way through a day resumes to the same hash
- [ ] A replay gives the same state hash. Replay fixtures with buildings are recorded again

## Notes

Land value is derived and changes when a factory goes up or the centre moves, so a running sum of property value would have to be rebuilt on each. Charging on the visit reads the value as it is that day and needs no sum.

The sweep is shared: issue 06 adds business tax to the same visit, so the cost of finding each building is paid once.

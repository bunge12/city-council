# M3-04: City statistics: running totals and monthly history

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 03.

## Goal

The city knows its population and the other counts the game leans on, without recounting. See "City statistics" in the PRD.

## Scope

- Running totals in state: population and the number of pops, residents by zone density, education and wealth, workers employed and unemployed, jobs offered and filled by commercial, office and industrial, pops with children, and buildings by zone and density
- The totals are adjusted by the pop functions from issue 03 and by adding and removing buildings. Nothing recounts them in a tick
- The highest population the city has reached, kept for M4's milestones
- A yearly count of births, deaths, arrivals and departures. Issues 08, 10 and 11 add to it
- Once per game month, on the first tick of the month, one sample of each total goes into a fixed-length history of 1,200 samples. When it is full the oldest sample is dropped
- A recount function that works every total out from the pops and buildings, used by tests
- `SNAPSHOT_VERSION` goes up, with a migration that counts an old city's buildings and starts its history empty, and a test

## Out of scope

- The top bar and the statistics panel, which are issues 15 and 16
- Sending the totals to the client, which is issue 05
- Treasury, commute and satisfaction lines, which later milestones add

## Done when

- [ ] A test runs a scripted session of adds, changes and removals and finds every total equal to the recount at each step
- [ ] A test runs 1,201 game months and finds 1,200 samples, the oldest gone
- [ ] A city saved and reloaded mid-month hashes the same as one that never stopped, and takes its next sample on the same tick
- [ ] The migration test loads a city with buildings and finds the building counts right
- [ ] The history's size in a snapshot is recorded in the pull request

## Notes

Mixed buildings offer commercial jobs, and office jobs at density 3, so their jobs count under those two headings.

The history is typed arrays, one per total, with one write position shared by all. About 30 totals of 1,200 samples at 4 bytes each is under 150 KB.

The yearly counts reset on 1 January. The year that just ended is kept beside the running one, because the panel shows a full year.

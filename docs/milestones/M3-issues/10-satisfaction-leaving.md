# M3-10: Satisfaction and leaving

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 09.

## Goal

Pops that cannot find work leave. See "Satisfaction" in the PRD.

## Scope

- A satisfaction system in the step that sets each pop's score once per game day, a slice of pops per tick. M3 has one input: having a job, and one that fits the pop's education
- A pop's score moves part of the way to its target each day, so a pop that just lost its job does not leave the next morning
- A pop whose score has stayed under a threshold for a set time moves out. Its job is freed and the year's departures count goes up
- While the residential bar is below zero, pops leave at a rate that follows the bar, the least satisfied first
- The city's average satisfaction, weighted by pop size, is a running total, and an input to the residential bar from issue 06
- The scores, thresholds and times are in `pops.json` and `demand.json`
- `SNAPSHOT_VERSION` goes up for the time a pop has spent under the threshold and for the system's cursor, with a migration and a test. The protocol version goes up, since the bar gains a part

## Out of scope

- Every other satisfaction input, each of which arrives with its module
- The satisfaction overlay and the approval rating, which the PRD puts in M8
- What happens to the buildings pops leave, which is issue 24

## Done when

- [ ] The scenario test the PRD names: a city with no jobs loses population
- [ ] A scenario test removes every workplace from a working city and finds pops leaving after about a game month, not before
- [ ] A scenario test of an all-residential city finds it grows, stalls and then holds or shrinks, and never passes a set population
- [ ] A test finds the residential bar lower in a city of dissatisfied pops than in the same city satisfied
- [ ] The totals equal the recount at the end of each test
- [ ] A replay gives the same state hash, and a city saved mid-exodus resumes to the same hash
- [ ] The system's tick time at 150,000 pops is in the pull request

## Notes

The PRD says a low score for long enough replaces "the separate leave rules scattered through earlier modules". Hold to that: unemployment makes a pop leave only through its score. The one extra rule is the bar below zero, which the PRD states on its own.

A job that fits is one at the pop's own education level. A high education pop in a shop has a job, and a lower score than one in an office.

How long a pop waits has to be longer than job matching takes to place a newcomer, or a growing city leaks people. The proposal is about a game month, against a daily matching pass.

A pop with no workers, if the shares allow one, is satisfied on this input.

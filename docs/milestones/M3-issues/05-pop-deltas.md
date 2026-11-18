# M3-05: People and statistics in the protocol and the mirror

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 04.

## Goal

The client's copy of the city knows how many people it has and who is in each building.

## Scope

- A delta carries the totals that changed and any new history sample
- A delta carries, for each building whose numbers changed, its people and its jobs filled. Whole rows read when the delta is built, as road and building rows are
- A snapshot carries everything, the pop table included
- The mirror applies these and tells its listeners which buildings and which totals changed
- The mirror's homes counter from M2-18 stays until issue 15 replaces the figure it feeds
- The protocol version goes up
- The sim records which buildings a step touched in a list outside state, like the road and cell lists, and the host drains it

## Out of scope

- Any UI, which is issues 15, 16 and 17
- Pop rows in deltas. See the notes
- Demand values. Issue 06 adds them to the delta itself, since it adds the state

## Done when

- [ ] A test runs a session that adds, changes and removes pops and checks the mirror's totals and per-building numbers against the sim's after every delta
- [ ] A test drops a delta and finds the mirror asks for a snapshot and comes back equal
- [ ] The size of a day's deltas on a city with 150,000 pops under turnover is measured and in the pull request
- [ ] A client on the old protocol version is refused with the existing message

## Notes

The proposal in M3.md is that pop rows do not travel in deltas. Turnover changes thousands of pops a game day, and nothing on screen draws a single pop before M5. The client then holds a pop table only as of its last snapshot, which is no use for anything. Do not read it. If this turns out wrong, pop rows can join the delta later without changing what is already sent.

That makes the mirror less than a full copy of state for the first time. The client's tests compare `hashState` of the mirror with the host's snapshot after deltas, in `packages/client/test/protocol.test.ts` and `cell-deltas.test.ts`, and that stops holding once pops change between snapshots. Compare on a hash that leaves out the pop table and the pop cursors, keep the full comparison straight after a snapshot, and say which tests changed. Record the new rule under "Why this keeps multiplayer cheap" in the PRD.

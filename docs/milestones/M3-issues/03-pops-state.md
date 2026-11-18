# M3-03: Pops in state

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 01.

## Goal

The sim can hold pops. Nothing creates them in play yet.

## Scope

- `SimState.pops`: flat typed arrays by pop id with a free list, like buildings. Home building, workplace building or none, size, education, wealth, has children and satisfaction. See the pop table under "M3 Demand" in the PRD
- Internal functions to add a pop to a home, remove one, and change its size, workplace or profile. They refuse a pop that would put a building over its capacity
- Derived, never saved: the pops in each home, the pops working in each building, each building's people and its jobs filled. Built on first use and kept current by the functions above, with a test that a fresh build gives the same answers
- The rule that cuts a building's people into pops. The proposal: a pop is never larger than the cap for its home's density in `pops.json`, so a house holds one pop and a tower of 1,000 holds ten or more
- How many of a pop's people work: a share by profile from `pops.json`, lower for a pop with children. A function of the pop row, so issue 04 can count workers before anyone has a job
- A cursor pattern for systems that visit every pop: a slice of the pop ids per tick, the whole array once per game day, in id order. A helper here, used by issues 09, 10 and 11
- Removing a building removes its pops and frees the jobs in it, so state never names a building that is gone. Issue 12 replaces this with displacement
- `SNAPSHOT_VERSION` goes up, with a migration that gives an old city no pops, and a test

## Out of scope

- Pops arriving, working, leaving or changing, which are issues 08, 09, 10, 11 and 12
- Running totals, which are issue 04
- Sending pops to the client, which is issue 05

## Done when

- [ ] Unit tests add, change and remove pops and check every derived answer against a count from scratch
- [ ] A test fills a tower to capacity and finds its pops within the size cap, and a house with one pop
- [ ] The migration test loads a version 15 city and finds it unchanged apart from an empty pop table
- [ ] A snapshot with pops round-trips and hashes the same
- [ ] `pnpm bench` adds 150,000 pops to the scale town and records the time and the snapshot's growth in the pull request
- [ ] Typed arrays only. No objects per pop, no `Map` in state. `pnpm lint` passes

## Notes

A full city is 40,000 to 150,000 pops. Plan the arrays for 150,000 and let them grow like the building arrays do.

A pop row is about 12 bytes if home and workplace are 32-bit ids and the rest are bytes. Record the real number.

The slice per tick matters more than it looks. It is rule 3 in practice: the same pops are visited on the same tick on every machine, so the cursor is state, saved and hashed.

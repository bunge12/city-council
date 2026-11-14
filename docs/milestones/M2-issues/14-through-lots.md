# M2-14: Through-lots for large commercial and industrial buildings

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 10, 11.

## Goal

A big-box store, a mall or a large factory has somewhere to stand. This settles the note on large lots under "M2 Zoning and buildings" in the PRD.

## Scope

- Where a block between two parallel roads carries the same zone and density on both back-to-back strips, the finder may merge them into one lot up to 12 cells deep
- The block comes from the M1 block index. The two strips must meet back to back with no gap wider than a set number of metres in `zoning.json`
- Large commercial and industrial types in `buildings.json` on lots up to 12 × 12 cells, marked as proposals
- Only commercial and industrial at density 3 use through-lots to start with
- A through-lot building fronts both roads. It is removed when either road goes
- Zoning depth stays at six cells
- The PRD note becomes a decision, with the types added to the building tables

## Out of scope

- Through-lots for housing and offices
- Lots that merge strips around a corner
- Whole-block parks, which are M8

## Done when

- [ ] A scenario test builds two parallel streets twelve cells apart, zones both strips C3 and finds one building standing on both
- [ ] The same with the strips zoned C3 and I3 yields no through-lot
- [ ] Bulldoze either street and the building goes
- [ ] The grid tool's default block of twelve cells deep takes a through-lot with no gap, shown by a test
- [ ] A replay with a through-lot produces the same state hash

## Notes

The grid tool's default depth is two strips back to back, so a default grid is ready for through-lots. A block drawn by hand may leave a sliver between the strips, which is what the gap limit is for.

If through-lots turn out to crowd out smaller buildings in every C3 block, give the grower a share in the balance file.

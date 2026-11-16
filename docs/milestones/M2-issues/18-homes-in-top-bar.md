# M2-18: Homes built in the top bar

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 10, 12. Issue: #148.

## Goal

The top bar shows how many homes the city has built. M2 has no pops, so this number stands in for population until M3 replaces it. See "Before demand exists" and "Capacity and residents are different numbers" in the PRD.

## Scope

- A "Homes" figure in the top bar, beside the game date: the number of residential buildings standing in the city
- Its tooltip gives the room those homes have, the sum of their resident capacity, labelled as capacity and not as people
- The figure is counted in the client from its read-only copy of state, and the client adjusts it as building deltas arrive instead of recounting every building each frame
- It updates when the grower builds, when a road or the bulldozer removes buildings, and after undo, reload and city import
- Before a city is open it shows "-", like the date

## Out of scope

- Population, pops and the population trend arrow, which come in M3 with "City statistics"
- Running totals in sim state and their monthly history, also M3
- Counts for commercial, office, industrial or mixed buildings
- Renaming the `residents` field in `buildings.json` and in state to `capacity`. It already holds capacity, and M3 reads it that way

## Done when

- [ ] A unit test for the counter: it matches a full count over the mirror after a run of grows, removals and an undo
- [ ] A Playwright test paints R1, waits for houses, and reads the figure going up, then bulldozes a house and reads it going down. Screenshot of the top bar in the pull request
- [ ] The figure survives a reload with the same value
- [ ] No change to sim state, the snapshot version, the protocol version or the replay fixtures

## Notes

One residential building counts as one home here, whatever its type. A row of townhomes or an apartment block is one entry. The PRD gives no number of dwellings per building, and capacity already carries the size. If Artur wants dwellings counted instead, that needs a homes-per-type figure in `buildings.json` first.

The capacity paragraph in the PRD says a single family home has room for four, while the grower still draws 1 to 4 per house (kept on purpose in the PRD sync of 16 November 2026). The tooltip shows whatever the buildings hold.

This is client-only work, so it needs browser evidence and no snapshot bump.

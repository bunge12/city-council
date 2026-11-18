# M3-14: Redevelopment

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 12, 24, 25.

## Goal

Built ground that was rezoned rebuilds on its own, sooner where the land is worth more. See "Rezoning" in the PRD.

## Scope

- A building on ground zoned up to a higher density of the same zone is replaced when the new building would be worth clearly more than the old. The check runs on a slice of such buildings per game day
- Worth is a function of land value, lot area and density, in `landvalue.json`, with the margin that counts as "clearly more"
- The zone's bar has to be above zero, and the lot finder has to find a lot of the new zoning that covers the old building's ground or more
- A building on ground zoned down or to another use stays as long as it is in use. Once it is abandoned, the grower clears it and the ground builds under its current zoning
- An abandoned building on ground still zoned for it stays, as issue 24 left it
- The pops of a replaced home are displaced through issue 12. The jobs of a replaced workplace are freed
- The check's cursor is state, so `SNAPSHOT_VERSION` goes up with a migration and a test
- A cap on redevelopments per game day, in `demand.json`, so a rezoned district changes over months and not in a day
- The readout for a building says when it is a permitted existing use, and under what zoning its ground would rebuild

## Out of scope

- Any cost to the city or the owner. Redevelopment is free in M3 and stays free in M4
- Redevelopment toward a lower density

## Done when

- [ ] A scenario test rezones a built R1 street to R3 with demand high and finds houses replaced by towers over game months, the most valuable ground first, and their pops housed elsewhere
- [ ] The same test with the residential bar below zero finds nothing replaced
- [ ] A scenario test rezones a built R1 street to C2 and finds every house standing while people live in it, and a shop in place of one that was abandoned
- [ ] A scenario test rezones R1 to R3 on a strip only 2 cells deep and finds the houses stay, since no R3 lot fits
- [ ] The totals equal the recount at the end of each test
- [ ] A replay gives the same state hash
- [ ] The readout shows "permitted existing use" over a house on C2 ground. Screenshot in the pull request

## Notes

Rezoning has to stay cheap, as the PRD says: every city starts at density 1, and if built land could only densify through expropriation, growth toward 500,000 would stall. So err on the side of redeveloping too readily, and tune down in issue 21.

A house on a 2 × 3 lot cannot become a 4 × 4 tower alone. The proposal: when the check passes for one building, the lot finder is asked for the best lot of the new zoning that includes its ground, treating neighbouring buildings that also pass the check as free. Every building on that lot is replaced together. Assembly is in scope, because exit step 11 needs it: no R3 type fits a house lot. If the pull request grows too large, split the abandoned-building clearing into its own, not the assembly.

The M2 exit test's step 6 rezones a built R1 lot to C2 and expects the house to stay. It still does, since the house is in use.

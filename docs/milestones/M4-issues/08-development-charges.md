# M4-08: Development charges

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 02.

## Goal

Every new private building pays the city a lump sum, and the player trades that income against how fast the city builds. See "Development charges" in the PRD.

## Scope

- When the grower builds a building, its developer pays the charge for its zone: the zone's rate times the building's floor space from issue 01, to that zone's development charges line
- Redevelopment pays only on the floor space it adds over the buildings it replaces
- A `SetDevelopmentCharge` command with a zone and a rate, refused outside the range in `economy.json`
- The rate slows the grower in that zone. Today a zone's quota is ceil(rate × bar / 100), so it never falls below one building a day while the bar is above zero. The charge multiplies rate × bar / 100 by a share, from 1 at zero to the share in `economy.json` at the top of the range, before rounding. The whole part is built that day, and the part left over is one more building with that chance, drawn from the seeded generator. A quota of 0.3 then builds on about three days in ten. It does not enter the demand bar
- The five rates go in state and in the delta. `SNAPSHOT_VERSION` and the protocol version go up, with a migration and a test

## Out of scope

- The sliders, which are in the budget panel, issue 15
- Charges on city-owned buildings. City Hall pays none

## Done when

- [ ] Unit tests build a house and a tower and find each charge equal to the rate times its floor space
- [ ] A test redevelops a row of houses into a tower and finds the charge on the added floor space only
- [ ] A scenario test runs a zone at zero and at the top rate and finds fewer buildings at the top rate and no charge income at zero, on a zone whose quota is one a day as well as a large one
- [ ] A replay gives the same state hash. Replay fixtures with buildings are recorded again

## Notes

The trap the PRD describes, roads and schools paid from charges in a boom and upkeep left uncovered when growth stops, is the point. Issue 19's balance check should show it on the standard cities.

Mixed has its own rate, since a mixed building is one project.

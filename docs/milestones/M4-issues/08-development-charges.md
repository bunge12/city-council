# M4-08: Development charges

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 02.

## Goal

Every new private building pays the city a lump sum, and the player trades that income against how fast the city builds. See "Development charges" in the PRD.

## Scope

- When the grower builds a building, its developer pays the charge for its zone: the zone's rate times the building's floor space from issue 01, to the development charges line
- Redevelopment pays only on the floor space it adds over the buildings it replaces
- A `SetDevelopmentCharge` command with a zone and a rate, refused outside the range in `economy.json`
- The rate scales the grower's daily quota in that zone: full quota at zero, falling to the share in `economy.json` at the top of the range. It does not enter the demand bar
- The five rates go in state and in the delta. `SNAPSHOT_VERSION` and the protocol version go up, with a migration and a test

## Out of scope

- The sliders, which are in the budget panel, issue 15
- Charges on city-owned buildings. City Hall pays none

## Done when

- [ ] Unit tests build a house and a tower and find each charge equal to the rate times its floor space
- [ ] A test redevelops a row of houses into a tower and finds the charge on the added floor space only
- [ ] A scenario test runs a zone at zero and at the top rate and finds fewer buildings at the top rate and no charge income at zero
- [ ] A replay gives the same state hash. Replay fixtures with buildings are recorded again

## Notes

The trap the PRD describes, roads and schools paid from charges in a boom and upkeep left uncovered when growth stops, is the point. Issue 19's balance check should show it on the standard cities.

Mixed has its own rate, since a mixed building is one project.

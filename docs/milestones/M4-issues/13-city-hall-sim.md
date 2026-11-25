# M4-13: City Hall in the sim

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 03, 04, 12.

## Goal

The player can place one City Hall, the city's first landmark. See "Landmarks" and "Removing things" in the PRD.

## Scope

- A landmark is a city-owned building with a type of its own, kept in the building arrays with a flag, so the building index, picking and the bulldozer find it as they find any building
- A `PlaceLandmark` command with the landmark, the segment, the side and the position along it. Refused before its unlock, if one already stands, without road frontage, or where its footprint is not free cells. A `planPlaceLandmark` function gives the footprint, the price and the reason, for the tool
- City Hall's footprint, price and upkeep in `economy.json`, the price with a source year from a real city hall's construction cost
- Its price goes on the construction line. Its upkeep joins the building upkeep from issue 04
- Its cells leave the zoning and cannot be painted while it stands. `ZoneCells` passes over them
- `BulldozeBuilding` on it charges demolition only, less the refund share, and the cells come back unzoned
- Its stage, 1 to 3, follows the milestones reached, with the milestones in `progression.json`. Derived, not stored
- It offers no homes or jobs, pays no tax and no development charge
- `SNAPSHOT_VERSION` goes up if a building row gains a field, with a migration and a test

## Out of scope

- The placement tool, the model and the click that opens the budget, which are issue 17
- Land value around it and trips to it, which the PRD gives every landmark and which arrive with M8 and M5. Add a note to the PRD if M4 leaves them out

## Done when

- [ ] Unit tests place City Hall and find it charged, its cells unzonable, and a second one refused
- [ ] A test finds it refused before the first milestone, without frontage, and over a building
- [ ] A test bulldozes it and finds the refund paid and the cells free
- [ ] A test finds its stage follow the milestones reached
- [ ] A replay gives the same state hash

## Notes

The PRD has eight landmarks over v1. Build the kind, not one special case, so the central station in M7 only adds data and a model.

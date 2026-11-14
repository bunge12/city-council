# M2-04: ZoneCells command

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 03.

## Goal

A command paints a zone and a density on cells, or clears them.

## Scope

- `ZoneCells` carries a zone, a density and the ground to paint. The zone is residential, commercial, office, industrial, mixed or none. The density is 1, 2 or 3
- The payload names ground, not cell ids: a list of rectangles in world metres, each with its own angle. The sim paints every cell that is not blocked and whose centre lies inside one of them
- The number of rectangles in one command is capped in `zoning.json`
- Refused with a reason when the zone or density is unknown, when the list is over the cap, or when no cell would change
- Painting over a zoned cell rezones it. The command is free and instant. See "Rezoning" in the PRD
- All three densities can be painted. The milestone that unlocks densities 2 and 3 arrives in M4
- A `planZoneCells` function that returns the cells a command would change. It is exported for the tool's preview and runs on the mirror
- The command is logged with its player id like every other

## Out of scope

- The undo record, which is issue 16
- What rezoning does to a building, which is issue 11. No building exists yet
- The tool, which is issue 07

## Done when

- [ ] Unit tests cover paint, repaint, clear, a rectangle half over blocked cells, and each refusal
- [ ] A replay fixture with roads and zoning produces the same state hash on every run
- [ ] `planZoneCells` and the applied command change the same cells, shown by a test
- [ ] A command at the cap applies inside the tick budget, with the time in the pull request

## Notes

The M1 review found that a command naming things by id can act on the wrong thing once another player's command lands first (issue #94). A rectangle of ground has no such problem. If a road was split or bulldozed in between, the command paints whatever cells are there now.

# M1-20: BuildRoadGrid command

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 04, 14.

## Goal

The sim can build a whole street grid as one command: one validation, one log entry, one undo. See "Grid tool" in the PRD. The tool that sends it is issue 21.

## Scope

- A `BuildRoadGrid` command. It carries a rectangle as three corners on the build grid, a block depth and a block width in metres, and a road type id
- A pure `planRoadGrid` function, exported from the sim entry like `planStraightRoad`, that turns the command into a list of straight streets. The command and the tool's preview both call it, so the preview shows what the sim will build
- The plan uses only exact arithmetic. The client works out the rectangle's angle, so the sim needs no trigonometry
- Streets run along both axes of the rectangle at the block spacing. The spacing is between road edges, as in issue 19. The last block on each axis takes what is left, and a leftover too small for a block joins its neighbour
- The grid bends to the ground. A street stops where it meets water or a slope too steep for its type, using the ground checks from issue 03. Pieces under the minimum length are dropped. A grid never builds a bridge
- Each street is built through the code path `BuildRoad` uses, in a fixed order, so it splits and joins existing roads the way a hand-drawn street does, and new ids come out in a set order
- The grid is validated as a whole. Water and steep ground cut streets. Anything else that would refuse one street, such as an angle under 25 degrees against an existing road, refuses the whole grid with the reason and the street it came from
- A cap on the number of streets in one grid, in `roads.json` under `build`
- One log entry. `Undo` from issue 14 removes the whole grid in one step and rejoins the segments it split
- A replay fixture with a grid

## Out of scope

- The client tool, which is issue 21
- Curved or radial grids
- Clearing buildings and the eminent domain cost in the preview. Buildings arrive in M2 and eminent domain in M4
- Charging for the grid. The plan reports the cost, and the treasury arrives in M4

## Done when

- [ ] Unit tests cover a grid on open ground, one at an angle, one cut by water, one cut by a steep slope, one laid across an existing road, and one started on an existing road
- [ ] A 4 by 4 block grid is one log entry and gives 16 blocks once issue 18 is in
- [ ] Build a grid then undo it. The state hash equals the one before, apart from the log and the undo history
- [ ] A grid over the cap is refused with a reason
- [ ] `planRoadGrid` on the mirror and the applied command give the same streets
- [ ] The step that applies a grid at the cap, on the 30,000 segment network, is measured against the 20 ms tick budget. If it does not fit, lower the cap
- [ ] The replay fixture produces its committed hash

## Notes

A grid is the first command that builds many roads at once, so it sets how big one step can get. The cap is what keeps a step inside the budget. Pick it from the measurement, not by feel.

If the undo record from issue 14 cannot hold many roads under one log entry, change its shape here, bump `SNAPSHOT_VERSION` and ship the migration. If it can, this issue needs no bump.

The command payload is three points and three numbers, so it stays small whatever the grid size. That is one reason to send the rectangle and not the list of streets. The other is that the sim, not the client, decides where streets stop.

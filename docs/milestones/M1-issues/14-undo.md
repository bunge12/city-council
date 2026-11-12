# M1-14: Undo

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 12, 13.

## Goal

A player can take back their last road change, and only their own.

## Scope

- An `Undo` command. It carries no target. The sim finds the sender's most recent road command that has not been undone
- For each `BuildRoad`, `BulldozeRoad` and `UpgradeRoad` it applies, the sim stores what is needed to reverse it, as plain data in state, tied to the log entry
- Each player has their own undo history, capped at a set number of steps
- Undoing a build removes the segments it added and rejoins segments it split, when nothing else now uses the split node
- Undoing a bulldoze puts the segments back. Undoing an upgrade restores the old type
- An undo that is no longer valid is refused with a reason. For example, another road now joins the node, or the ground is taken
- `Undo` is itself recorded in the activity log, so a replay reproduces it
- In the client: Ctrl+Z or Cmd+Z, an undo button that is disabled when there is nothing to undo, and the reason shown when the sim refuses
- The snapshot version goes up, with a migration and a fixture

## Out of scope

- Redo
- Undoing another player's commands
- Undo for `SetSpeed`

## Done when

- [ ] Unit tests cover undo of each of the three commands, including a build that split two segments
- [ ] Build then undo leaves a state hash equal to the one before the build, apart from the log and the undo history
- [ ] With two player ids, each one's undo skips the other's commands
- [ ] An undo made invalid by a later command is refused and changes nothing
- [ ] A replay fixture with undos produces its committed hash
- [ ] A Playwright walkthrough builds, upgrades and bulldozes, then undoes all three

## Notes

The PRD says undo is per player and only works while the result is still valid. Decide here whether a refused undo stays at the top of the history or is dropped so the player can reach the step before it, and record the choice in the PRD.

Issue 20 adds `BuildRoadGrid`, which builds many roads under one log entry and must undo in one step. Shape the undo record so one entry can hold any number of added segments and splits. Then issue 20 needs no snapshot bump.

# M0-03: Activity log, state hash and replay tests

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 02.

## Goal

Every command is recorded, and a recorded log replays to the same state. This is the project's main regression net.

## Scope

- An activity log in state: for each applied command, its tick, player id, type and payload
- `hashState(state)` that returns a stable hash over every typed array and scalar in state, for example 64-bit FNV-1a
- `replay(seed, log, untilTick)` that builds a fresh state, feeds the log at the recorded ticks and returns the final state
- A replay test helper for Vitest, plus the first replay fixture: a short log of `NoOp` and `SetSpeed` commands
- A cap or paging scheme for the log so it cannot grow without bound in a long game. Old entries may move out of live state into the save

## Out of scope

- Undo, which arrives with the first real commands in M1
- Showing the log in the UI, which is issue 10

## Done when

- [ ] Replaying the fixture twice gives the same hash
- [ ] Replaying it and stepping the same commands live give the same hash
- [ ] Changing one byte of state changes the hash, covered by a test
- [ ] The log survives a snapshot round trip once issue 08 lands, noted there as a follow-up check

# M0-02: Sim core: state, tick, seeded randomness, command bus

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 01.

## Goal

The smallest sim that follows every rule in `CLAUDE.md`: a state object, a fixed tick, a seeded generator and one command.

## Scope

- `SimState` holding the tick counter, the seed, the generator state, the speed and the snapshot version, all in plain fields and typed arrays
- A seeded 32-bit generator such as xoshiro128** or sfc32, with its state stored in `SimState`
- `step(state)` that advances exactly one tick and calls each system in a fixed order. With no systems yet, it only increments the tick
- A command type with `seq`, `playerId`, `type` and `payload`, and a registry that maps a type to `validate` and `apply` functions
- `submit(state, command)` that validates, applies on the next tick, and returns ok or a rejection with a reason
- Two commands: `NoOp`, and `SetSpeed` with values pause, 1x, 2x and 4x
- A per-system timer hook so a host can measure tick time by system, with the clock supplied by the host and never read by the sim

## Out of scope

- Workers and messaging, which is issue 04
- Recording commands, which is issue 03
- Terrain

## Done when

- [ ] Unit tests cover: tick advances by one, `NoOp` is accepted, an unknown command is rejected with a reason, `SetSpeed` rejects values outside the four allowed
- [ ] Two states created from the same seed and stepped 1,000 times are equal
- [ ] The generator produces a committed sequence for a known seed, so a later change to it is caught
- [ ] No lint errors from the banned-API rule

## Notes

Speed is a command and not a client setting because in multiplayer there is one sim and one speed, shared by everyone.

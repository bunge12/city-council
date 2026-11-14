# M2-10: Grower

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 09.

## Goal

Buildings appear on zoned cells over time, at a fixed rate.

## Scope

- A grower system in the step. It spawns buildings at a rate set in `buildings.json`, in buildings per game day
- M2 has no demand, so every zone grows as if demand were positive. Mixed grows the same way. M3 puts the four demand bars in front of this
- Each spawn picks a free zoned lot with the finder from issue 09 and adds the building
- Which lot goes first is drawn from the generator in state. M3 replaces the draw with land value
- Residents scale with lot area between the type's low and high figure. For a single family home the number is drawn per building
- The variant number is drawn the same way. The client uses it to pick a model
- The grower keeps its list of candidate lots current as cells and buildings change. It does not scan the city each tick
- Its tick time shows in the debug panel as its own system

## Out of scope

- Demand, pops moving in, vacancy and abandonment, which are M3
- Redevelopment of built land after a rezone, which needs land value and waits for M3
- Money, which is M4
- Construction stages. A building appears complete

## Done when

- [ ] A scenario test zones a street R1 and finds houses along it after a set number of game days, with households of different sizes
- [ ] Scenario tests cover townhomes on a shallow R2 strip, apartments on a deep one, and an empty R3 lot under 4 × 4
- [ ] A replay of a recorded log with zoning produces the same buildings and the same state hash
- [ ] A city saved and reloaded while it grows hashes the same as one that never stopped
- [ ] On the 30,000 segment city with every cell zoned, the grower's worst tick is inside its share of the 20 ms budget, with the number in the pull request
- [ ] No `Math.random` and no clock. `pnpm lint` passes

## Notes

Pick the starting rate so a new street fills in about a game month, which is five minutes at 1x, and tune from there. It is a placeholder. Demand sets the pace from M3.

The grower takes the largest lot that fits, so a long empty strip would fill with the biggest type only. If streets come out too uniform, let the draw also pick among the lots that fit, and note the rule in the PRD.

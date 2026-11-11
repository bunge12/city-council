# M0-05: Terrain generation from a seed

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 02.

## Goal

A seed becomes a 12 km map of height, water and resources, and the same seed gives the same map on every machine.

## Scope

- `generateTerrain(seed)` returning a 750 x 750 height array in metres, a water level, and three resource masks for fertile land, forest and ore
- Layered value or gradient noise built on integer hashing, with a light erosion pass. Enough variety that maps have coasts or rivers, flat buildable land and some hills
- Only exact operations: add, subtract, multiply, divide, `Math.sqrt`, `Math.floor` and integer math. No `Math.sin`, `Math.pow`, `Math.exp`, `Math.log`
- `heightAt(x, z)` with bilinear interpolation in world metres, and `slopeAt(x, z)`. Later modules use these for road slope limits and blocked cells
- A guarantee that a useful share of the map is buildable, for example by regenerating with an adjusted parameter when too much is water or too steep. State the threshold in the balance file
- Terrain is derived data. It is not part of `SimState` and is not saved. It is rebuilt from the seed on load

## Out of scope

- Terraforming, which is out of v1
- Rendering, which is issue 06
- Trees and other decoration

## Done when

- [ ] The hash of the height array for three committed seeds matches committed constants in a Vitest test running in Node
- [ ] The same three hashes match in a Playwright test running in the browser
- [ ] Generation takes under 1 second for the full map on a mid-range laptop, measured and recorded in the pull request
- [ ] Each of the three seeds has at least the threshold share of buildable land
- [ ] A lint rule or test fails if a banned `Math` function appears in the terrain module

## Notes

This issue settles the risk named in M0.md. If identical output across Node and browsers cannot be reached, stop and record the fallback decision in the PRD before going on.

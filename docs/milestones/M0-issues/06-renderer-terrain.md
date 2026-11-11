# M0-06: Renderer bootstrap and chunked terrain

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 04, 05.

## Goal

The map is on screen, drawn in chunks, on WebGPU with a working WebGL 2 fallback.

## Scope

- three.js `WebGPURenderer`, pinned to an exact version, with the WebGL 2 backend used when WebGPU is missing or when a `?webgl` flag is set
- Terrain mesh built per 500 m chunk from the height array, 24 x 24 chunks
- A lower-detail mesh for distant chunks, so the whole map can be in view without drawing every sample
- Terrain colour from height, slope and the resource masks, in a TSL material. Readable, not pretty
- A water plane at the water level
- Fixed daylight. No day and night cycle in v1
- A render loop that is independent of the sim tick and reports frame time to the debug panel
- Resize handling and a device pixel ratio cap

## Out of scope

- Buildings, roads and anything that moves
- Shadows and post-processing. Add them only if they are nearly free
- Final art. This is a first pass

## Done when

- [ ] The full map renders at 60 fps on a laptop with integrated graphics, measured and recorded in the pull request
- [ ] With `?webgl` the page looks the same and still meets the frame rate
- [ ] No visible cracks between chunks or between detail levels at normal camera angles
- [ ] Screenshots of both backends are attached to the pull request
- [ ] The three.js version is recorded in the PRD stack table

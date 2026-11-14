# M2-02: Graphics presets, sun and shadows

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: M1.

## Goal

The game has three graphics presets and a lit scene, in place before the first building is drawn. See "Graphics presets" in the PRD.

## Scope

- A preset setting with Low, Balanced and High. It is kept per browser. It is not in sim state and not in the city file
- A settings entry in the UI to change it, and the current preset in the debug panel
- A short benchmark on first run that picks the preset. The rule and its thresholds live in `packages/client/src/render/config.ts`
- `?preset=low`, `?preset=balanced` and `?preset=high` force a preset and skip the benchmark, for tests
- One sun and one ambient light. Terrain, roads and the M0 trees are lit by them
- Low has flat lighting and no shadows. Balanced has sun shadows near the camera and soft ambient shading. High has a longer shadow range
- Shadows work on instanced meshes. The M0 trees are the first to cast and receive them, so issue 12 starts from a material that already works
- One list in the client where every visual feature names the preset that turns it on
- Costlier shaders compile in the background and switch on when ready. The first frame does not wait for them

## Out of scope

- Buildings and their material's tint, which are issue 12
- Water reflections and the other High extras, which are M11
- Car counts and street detail per preset, which are M5
- A day and night cycle. The sun stays where it is

## Done when

- [ ] A Playwright test loads the same city at each preset and takes a screenshot of each. Low has no shadows, Balanced has them near the camera and High has them further out
- [ ] A test runs the same commands at two presets and gets the same state hash
- [ ] The benchmark's choice is logged in the debug panel, and a second visit does not run it again
- [ ] Cold load to the first frame with terrain stays within the M0 number at every preset
- [ ] Frame time on the M1 scale city is recorded for each preset in the pull request, on WebGPU and on `?webgl`
- [ ] Screenshots attached to the pull request

## Notes

The PRD's open question about which two machines are the reference for Low and Balanced is still open. Until it is answered the thresholds are a first guess, measured on the CI machine and on whatever the pull request author has.

This issue touches no sim code, so it can run beside issues 01 to 11.

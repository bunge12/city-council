# M2-13: Building levels of detail across the zoom bands

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 12.

## Goal

A city full of buildings holds its frame rate at every zoom. See "Zoom bands" and "What 500,000 residents changes" in the PRD.

## Scope

- Street band: the full meshes from issue 12
- District band: each building is a plain box of its footprint and height, merged into one mesh per chunk
- City band: flat blocks coloured by zone and density, one mesh per chunk
- A short fade between bands, so nothing pops
- Only chunks near the camera hold full geometry. A chunk that leaves frees it
- A chunk's merged meshes rebuild only when a building in it changes
- Shadows by preset: none in Low, near the camera in Balanced, further out in High. Nothing in the city band casts one
- Draw calls and building counts per band in the debug panel

## Out of scope

- Cars and street detail, which are M5
- Tuning against real cities of 500,000 residents, which is M11

## Done when

- [ ] A script fills the 30,000 segment city with about 100,000 buildings through commands and the grower
- [ ] On that city, frame time in each zoom band at Low and at Balanced is recorded in the pull request, with draw calls and tab memory
- [ ] The district and city bands hold 60 fps on the CI machine or better at Balanced
- [ ] A Playwright test screenshots the same district in all three bands
- [ ] Flying across the map does not grow memory without bound, shown by a test that flies a loop twice and compares

## Notes

About 100,000 buildings is the count the PRD expects at full size. This is the first place the draw call risk under "Where the time goes" can be measured, so measure it before the close-out and open an issue for anything over budget.

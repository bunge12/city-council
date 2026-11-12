# M1-06: Road rendering: chunk meshes and junctions

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 04, 05.

## Goal

Roads in the mirror appear on the map.

## Scope

- Road surfaces built from the segment data, laid on the terrain, one merged mesh per 500 m chunk
- A chunk rebuilds only when the mirror says a road in it changed
- Width comes from the road type. Street, avenue and one-way look different from each other at a glance
- Junctions fill the area where segments meet, for any number of segments at any angles, with no gaps or overlapping surfaces
- A dead end gets a square cap
- Zoom bands: lane markings and one-way arrows in the street band, plain surfaces in the district band, and coloured lines for avenues and highways only in the city band
- Decorative trees and grass from M0 are not drawn where a road is
- Geometry is built from the mirror alone. The sim knows nothing about meshes

## Out of scope

- Curves, which are issue 09, and bridges, which are issue 11
- Sidewalks, street lights and other street furniture
- Signals and signs

## Done when

- [ ] A Playwright test loads a fixture city with a grid, a five-way junction and a dead end, and screenshots match in all three zoom bands
- [ ] Adding one segment rebuilds only the chunks it touches, shown by a counter in the debug panel
- [ ] A 30,000 segment network holds 60 fps in the city band on the CI machine or better, with the frame time recorded
- [ ] Roads do not flicker against the terrain at any zoom
- [ ] Both the WebGPU path and `?webgl` render the same picture

## Notes

Junction shapes are where free-form roads get ugly. Aim for clean and plain here. The PRD keeps the graph independent of the mesh so this can improve later without touching saves.

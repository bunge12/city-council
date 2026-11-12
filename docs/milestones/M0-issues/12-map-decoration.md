# M0-12: Map improvements

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 06, 07. GitHub issue #21.

## Goal

The map reads as land, not a spotted hide. The resource masks stop tinting the ground, and trees and grass give the land some texture up close.

## Scope

- The terrain material no longer draws the fertile, forest and ore masks. Colour comes from height and slope only. The masks stay in the terrain data for a later resources overlay
- Decorative trees, broadleaf and conifer, dense on forest land and scattered elsewhere, drawn within about 2.5 km of the camera
- Decorative grass tufts on open lowland, drawn within about 650 m of the camera
- Placement is a pure function of the seed: a jittered grid whose dice come from an integer hash of the seed and the cell. The same tree stands in the same place on every load and for every player
- Decoration lives in the client only. It is not sim state, it is not saved, and nothing in the game reads it

## Out of scope

- A resources overlay. Overlays come later
- Trees that block building or get cleared. That is gameplay and belongs to the milestone that adds building
- Wind, seasons and animated foliage

## Done when

- [x] The whole-map view shows no resource patches
- [x] Trees and grass appear near the camera and not over the whole map
- [x] Unit tests show placement is deterministic, stays on dry land and follows the forest mask
- [x] A Playwright walkthrough shows the same decoration after a reload, with screenshots

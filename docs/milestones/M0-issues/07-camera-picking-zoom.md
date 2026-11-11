# M0-07: Camera, ground picking and zoom bands

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 06.

## Goal

The player can move around the map and point at the ground, and the client knows which zoom band it is in.

## Scope

- Orbit, pan and zoom with mouse and keyboard. Limits keep the camera above the terrain and inside the map
- Zoom toward the point under the cursor
- `pickGround(screenX, screenY)` returning world metres, by ray against the height array and not against meshes
- A zoom band value of street, district or city, derived from camera height with the thresholds from the PRD as starting values in a config file
- A cursor marker on the ground under the pointer

## Out of scope

- Touch input, which is out of v1
- Anything that reacts to the zoom band. M0 only computes and shows it

## Done when

- [ ] A Playwright test clicks a known screen point with a fixed camera and gets world coordinates within 1 m of the expected value
- [ ] Picking still works at the map edge and on steep slopes
- [ ] The camera cannot go under the terrain or lose the map entirely
- [ ] The debug panel shows the current band and it changes at the configured heights

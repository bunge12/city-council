# M3-19: Ambient sound: wind and construction

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 02.

## Goal

The map is not silent. See the ambience table under "Sound" in the PRD.

## Scope

- A wind and open air layer that always plays, strongest in the city zoom band and faint at street zoom
- A construction layer heard while a building goes up in view, using the construction animation from #146. It is placed left or right by where the building sits on screen, and is heard in the street band only
- Both are synthesised in code, on the layer seam issue 02 left
- Both follow the ambience volume and the mute from issue 02
- Construction sounds share the voice cap. Ten buildings going up in view are a few voices, not ten

## Out of scope

- Traffic, industry, transit, street life, birds, water and the city hum, each of which arrives with the module that creates its source
- Music, which is M11
- Recordings

## Done when

- [ ] Unit tests for the layer volumes by zoom band, and for the pan from a screen position
- [ ] A Playwright test zooms from street to city and reads the wind layer's volume rising from the test hook
- [ ] A Playwright test watches a house go up at street zoom and reads the construction layer starting and stopping
- [ ] With the ambience volume at zero no layer is scheduled
- [ ] No audio file in the repo, and nothing changed in `packages/sim`
- [ ] Browser evidence on the pull request, as for issue 02

## Notes

Wind is filtered noise with a slow change in level. Construction is a few short percussive sounds at uneven intervals. Neither needs to be realistic. They need to be quiet enough to leave on for an hour.

The construction layer reads what the renderer is already animating, so it knows which buildings are in view without asking the sim.

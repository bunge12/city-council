# M4-17: City Hall in the client

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 13, 15.

## Goal

The player can place City Hall, see it grow, and click it to open the budget. See "Landmarks" and "Art direction" in the PRD.

## Scope

- A landmark tool in the build dock, shown once City Hall unlocks. It shows the footprint on the road side under the pointer, green or red from `planPlaceLandmark`, with the price and the reason, and sends `PlaceLandmark` on the click
- A model for City Hall made in code like the other buildings, at three stages, and in each zoom band: the near model, the plain box in the district band and the city band's block
- The construction animation from issue 136 when it is placed and at each stage
- A click on City Hall with no tool on opens the budget panel
- City Hall is a bulldoze target as a building. Its tag says "City-owned: demolition only" and gives the refund
- The hover readout gives its name, its stage and its upkeep

## Out of scope

- The other landmarks
- Land value and trips around it

## Done when

- [ ] A Playwright test passes the first milestone from a city file, places City Hall, finds the treasury charged and the cells unzonable, and clicks it to open the budget panel
- [ ] The same test reaches the next stage from a city file and finds the model changed
- [ ] The frame time at each zoom band on the 500,000 resident city is unchanged within noise with City Hall placed, with the numbers in the pull request
- [ ] Screenshots of the placement preview, each stage and the tag in the pull request
- [ ] Runs on WebGPU and on `?webgl`

## Notes

City Hall is the one building the player chooses to place, so it should read as civic at a glance at every band: a wide base, a central block and a dome or tower that rises with each stage. Keep it inside the M2 palette and lighting.

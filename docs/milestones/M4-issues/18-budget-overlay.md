# M4-18: Budget overlay

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 04, 06.

## Goal

The player can see which districts pay for which. See "A budget overlay" under "M4 Economy" in the PRD.

## Scope

- A sim function that gives each block's net income a year: the yearly tax of the buildings in it, less its share of the upkeep of the roads around it. Half a segment's upkeep goes to each block either side, as M4.md proposes. A segment with a block on one side only gives that block all of it
- Buildings and roads outside any closed block are summed per chunk instead, so a cul-de-sac on open ground still shows
- Derived on request from the blocks of M1-18, the tax function of issues 05 and 06 and the upkeep function of issue 04. Nothing in state
- An overlay entry in `OVERLAYS` with its button and a key. It colours each block on a diverging scale around zero, with a legend
- Pointing at a block gives its tax, its road upkeep and the net

## Out of scope

- Service upkeep, which M8 adds to each block's share
- A per-block budget in the panel

## Done when

- [ ] Unit tests on a small city give a compact block of density 2 a net above zero and a block on a long cul-de-sac one below it
- [ ] A test finds the blocks' and chunks' sums equal to the city's yearly tax less its road upkeep
- [ ] The overlay builds in under 50 ms on the 500,000 resident city, with the number in the pull request
- [ ] A Playwright test turns the overlay on and reads a block's figures against the sim's
- [ ] Screenshots of the overlay on a mixed town in the pull request

## Notes

This overlay is what makes "low density roughly breaks even" visible. Issue 19's tuning reads it.

Use a diverging scale with a neutral middle, so a block near zero does not look like a loss. The dataviz guidance has the palette.

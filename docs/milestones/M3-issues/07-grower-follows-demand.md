# M3-07: The grower follows demand

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 06.

## Goal

Buildings grow where demand asks for them and nowhere else.

## Scope

- The grower builds in a zone only while that zone's bar is above zero
- A mixed lot builds only while the residential and commercial bars are both above zero
- The pace of each zone follows its bar. The M2 deadline that fills any zoning in a game month goes
- Density is whatever the cell is zoned for. An R3 cell gets an R3 building as soon as residential demand is above zero. There is no check on how strong demand is
- The draw of which free cell goes first stays as M2 left it. Issue 25 replaces it with land value
- The pace and the caps are in `demand.json` and `buildings.json`. `fillDays` and the fields only the M2 pace used are removed
- If the grower's saved plan changes shape, `SNAPSHOT_VERSION` goes up with a migration and a test

## Out of scope

- Pops arriving, which is issue 08. Until it merges, homes are built and stay empty
- Holding back homes while the city has empty room, and workplaces while it has open jobs. Those rules need pops and jobs to count, so issues 08 and 09 add them
- Land value order, which is issue 25
- Redevelopment of built ground, which is issue 14
- The population milestone that unlocks painting densities 2 and 3, which is M4

## Done when

- [ ] A scenario test zones R1, C1 and I1 with the residential bar held below zero and finds no house built and shops and factories built
- [ ] A scenario test zones mixed ground and finds it built only when both bars are above zero
- [ ] A scenario test zones an empty R3 lot of 4 × 4 and finds a tower as soon as the residential bar is above zero, with no smaller building first
- [ ] The replay fixtures with zoning are refreshed, and the pull request says the grower's pace is why
- [ ] On the scale city with every cell zoned and every bar at 100, the grower's worst tick is inside its 5 ms share, with the number in the pull request

## Notes

M2's tests and walkthroughs lean on "zone it and it fills". With demand in front, an R1 street in an empty city still fills, because of the pull from outside in issue 06. Other zones need residents first. Tests that want the old behaviour hold the bars up with the test helper from issue 06.

The M2 walkthrough paints all five zones on an empty city and waits for each to build. It will need demand held up, or a city file with residents. Fix it here and say how.

The limit the PRD records under "The grower", where a strip of gaps that fit no lot wastes draws, is still there. Issue 25 replaces the draw and should end it.

# M4-10: Displacement lowers satisfaction

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 09.

## Goal

Expropriation hurts politically: the people moved and their neighbours like the city less for a while. See "Eminent domain" and "Satisfaction" in the PRD.

## Scope

- A satisfaction input from the expropriation records of issue 09. On a pop's daily visit, each record within the radius in `pops.json` lowers its target, scaled by the people the record displaced and fading in a straight line to nothing over a game year
- A displaced pop carries its own hit wherever it moved, as the PRD says. A mark on the pop row, the day it was displaced and how many were displaced with it, gives the hit on its visit. `SNAPSHOT_VERSION` goes up, with a migration that marks no one and a test
- Records are found through a coarse grid of them, derived and never saved, so a pop's visit reads the few nearby and not the whole list
- Redevelopment's displacement counts too, as the PRD's satisfaction table lists it. Decide its weight here, smaller than expropriation's, and record it in the PRD

## Out of scope

- The satisfaction overlay and the click-through that names the cause, which are M8
- Any change to who leaves. Lower scores already lead to leaving through M3-10

## Done when

- [ ] A test bulldozes an occupied house, finds its pop in a home across the city, and finds its score lower than its new neighbours'
- [ ] Unit tests give a pop near a fresh record, near an old one and far from any, and find the targets in that order
- [ ] A scenario test clears an occupied block and finds the neighbours' average score drop and recover over a game year
- [ ] A test finds the derived grid built at load equal to one kept through a session
- [ ] The SATISFACTION system's worst tick on the 500,000 resident city, against its share, is in the pull request
- [ ] A replay gives the same state hash

## Notes

The neighbours' hit is worked out from the records each day, which is why issue 09 keeps the place and the count. Only the displaced pop's own hit needs the mark.

The distance is the straight line from the pop's home's lot centre, with squared distances so no square root is needed.

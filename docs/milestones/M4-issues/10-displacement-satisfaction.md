# M4-10: Displacement lowers satisfaction

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 09.

## Goal

Expropriation hurts politically: the people moved and their neighbours like the city less for a while. See "Eminent domain" and "Satisfaction" in the PRD.

## Scope

- A satisfaction input from the expropriation records of issue 09. On a pop's daily visit, each record within the radius in `pops.json` lowers its target, scaled by the people the record displaced and fading in a straight line to nothing over a game year
- A displaced pop that moved across the city is no longer near its record. Decide here whether it carries the hit with it. That needs a mark on the pop row, a snapshot bump and a migration, so say why if it is worth it
- Records are found through a coarse grid of them, derived and never saved, so a pop's visit reads the few nearby and not the whole list
- Whether redevelopment's displacement counts, at a smaller weight. Decide it here and record it in the PRD

## Out of scope

- The satisfaction overlay and the click-through that names the cause, which are M8
- Any change to who leaves. Lower scores already lead to leaving through M3-10

## Done when

- [ ] Unit tests give a pop near a fresh record, near an old one and far from any, and find the targets in that order
- [ ] A scenario test clears an occupied block and finds the neighbours' average score drop and recover over a game year
- [ ] A test finds the derived grid built at load equal to one kept through a session
- [ ] The SATISFACTION system's worst tick on the 500,000 resident city stays inside its share, with the number in the pull request
- [ ] A replay gives the same state hash

## Notes

No pop row grows unless the decision above needs it. The hit is worked out from the records each day, which is why issue 09 keeps the place and the count.

The distance is the straight line from the pop's home's lot centre, with squared distances so no square root is needed.

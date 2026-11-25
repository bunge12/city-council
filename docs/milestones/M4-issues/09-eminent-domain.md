# M4-09: Eminent domain

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 03.

## Goal

Clearing an occupied building means paying its owner and its people, and the price is known before the click. See "Eminent domain" and "Removing things" in the PRD.

## Scope

- A function gives a building's compensation: for an occupied building, its value from issue 01, plus the relocation payment per resident or job displaced, plus the premium; for a vacant or abandoned one, the demolition cost only
- `BulldozeBuilding` charges it to the compensation line. So do `BulldozeRoad`, and `BuildRoad`, `BuildRoadGrid` and `UpgradeRoad` when they take buildings with them
- The plan functions return the compensation and its parts, so the bulldozer's tag and the road tool give the same number the command charges. The overdraft check from issue 03 counts it
- Rezoning charges nothing, and redevelopment by an owner charges nothing
- An expropriation record in state for each building removed this way with people in it: the tick, the lot's centre, the people displaced and the player. Records older than a game year are dropped. The list is capped, with the cap in `economy.json`
- `SNAPSHOT_VERSION` goes up, with a migration that gives an older city an empty list, and a test

## Out of scope

- The satisfaction hit, which is issue 10
- The tag's new lines in the client, which are issue 16
- City-owned buildings, which issue 13 adds with demolition only

## Done when

- [ ] Unit tests price an occupied house, an occupied tower, a vacant shop and an abandoned factory
- [ ] A test bulldozes a road with buildings on it and finds the treasury moved by the road's cost plus every building's compensation
- [ ] A test finds the plan's price equal to the charge for every command that removes buildings
- [ ] A test steps a game year past a record and finds it dropped
- [ ] `BulldozeBuilding` at its cap of 5,000 over occupied buildings stays inside the tick, with the time in the pull request
- [ ] A replay gives the same state hash

## Notes

The pops in a cleared building are displaced as M3-12 already does. This issue only puts a price on it.

A tower downtown costs many times a house at the edge, because value follows land value and floor space. Record the two prices on the scale city in the pull request.

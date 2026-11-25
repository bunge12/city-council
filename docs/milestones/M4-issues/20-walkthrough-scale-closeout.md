# M4-20: M4 walkthrough, scale checkpoints and close-out

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: all other M4 issues.

## Goal

The M4 exit test runs automatically, the three scale cities hold up with money in them, and the milestone is closed.

## Scope

- One Playwright walkthrough that performs the fifteen exit test steps in M4.md, on the WebGPU path where the CI browser supports it and on `?webgl`
- Screenshots from the walkthrough saved as CI artifacts and published as browser evidence on the pull request
- The scale checkpoints, on the cities from M3-20 at 50,000, 200,000 and 500,000 residents, each given a treasury, rates, a loan and City Hall. On each, measure and record: the time per tick of the tax sweep, upkeep and satisfaction with its new inputs, worker time per tick against the 20 ms budget, one `BulldozeBuilding` at its cap over occupied buildings with compensation, the budget overlay's build time, the budget panel's open time, the size of a game day's deltas, snapshot size, autosave time, tab memory against the 500 MB budget, the time to open each city against the 30 s target, and frame time in each zoom band at Low and at Balanced
- A save and resume test: run a scripted session with taxes, charges, a loan, a milestone and an expropriation straight through, and separately save and reload half way. The final hashes must match
- The soak run passes with money in the city
- Update the PRD with every decision M4 made, and tick the M4 row in the roadmap
- Update the README's "Where it stands"

## Out of scope

- Further tuning, beyond what issue 19 did
- Traffic on the scale cities, which is M5

## Done when

- [ ] The walkthrough passes in CI on the pull request and against the deployed page
- [ ] The two scenario tests the exit test names pass
- [ ] Every measurement is recorded in the pull request and under "M4 exit numbers" in the PRD, and anything over budget has an issue
- [ ] The save and resume hashes match
- [ ] The M4 row in the PRD roadmap is ticked and `docs/milestones/M5.md` is opened as the next task

## Notes

Several exit steps wait on the sim: a month's close in step 4, a milestone in step 9. The budget overlay's cul-de-sac in step 13 needs a city file that isolates it, as issue 18 says. Start those from city files built in Node that are a game day short of the event, as the M3 walkthrough does, and run at 4x. Everything the step itself checks still goes through the page's own tools.

Steps 2, 7 and 9 read sounds from the test hook M3-02 added. A headless browser plays nothing.

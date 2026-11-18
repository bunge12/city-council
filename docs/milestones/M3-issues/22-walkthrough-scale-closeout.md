# M3-22: M3 walkthrough, scale checkpoints and close-out

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: all other M3 issues.

## Goal

The M3 exit test runs automatically, the three scale cities hold up, and the milestone is closed.

## Scope

- One Playwright walkthrough that performs the fifteen exit test steps in M3.md, on the WebGPU path where the CI browser supports it and on `?webgl`
- Screenshots from the walkthrough saved as CI artifacts and published as browser evidence on the pull request
- The scale checkpoints, on the cities from issue 20 at 50,000, 200,000 and 500,000 residents. On each, measure and record: the time per tick of demand, the grower, arrivals, job matching, satisfaction, vacancy, turnover and land value, worker time per tick against the 20 ms budget, one `BulldozeBuilding` at its cap over occupied buildings, the travel table's rebuild after one `BuildRoad` on each city, the size of a game day's deltas, snapshot size, autosave time, tab memory against the 500 MB budget, the time to open each city against the 30 s target, and frame time in each zoom band at Low and at Balanced
- A save and resume test: run a scripted session with arrivals, job matching, leaving, turnover and redevelopment straight through, and separately save and reload half way. The final hashes must match
- The soak run from issue 20 passes
- The carried issues #162 to #166 are closed or moved on with a reason
- Update the PRD with every decision M3 made, and tick the M3 row in the roadmap
- Update the README's "Where it stands"

## Out of scope

- Traffic on the scale cities, which is M5
- Further tuning, beyond what issue 21 did
- Frame time on a real machine of each reference class, if #165 is still open. Record what was measured and on what

## Done when

- [ ] The walkthrough passes in CI on the pull request and against the deployed page
- [ ] The two scenario tests the exit test names pass: a city with no jobs loses population, and a street of houses dips and recovers
- [ ] Every measurement is recorded in the pull request and under "M3 exit numbers" in the PRD, and anything over budget has an issue
- [ ] The save and resume hashes match
- [ ] The M3 row in the PRD roadmap is ticked and `docs/milestones/M4.md` is opened as the next task

## Notes

Several exit steps wait on the sim: a stall in step 2, abandonment in step 9, redevelopment in step 11. Start those from city files built in Node that are a game day short of the event, as the M2 walkthrough starts from built streets, and run at 4x. Everything the step itself checks still goes through the page's own tools.

Step 13 reads sounds from the test hook issue 02 added. A headless browser plays nothing.

The scale checkpoints are measured at Low and Balanced. The reference classes were decided at the M2 close-out. If no machine of either class is to hand, name the machine each number came from, as M2 did.

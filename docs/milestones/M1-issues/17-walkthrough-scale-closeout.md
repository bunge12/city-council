# M1-17: M1 walkthrough, scale check and close-out

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: all earlier M1 issues.

## Goal

The M1 exit test runs automatically, the network holds up at full size, and the milestone is closed.

## Scope

- One Playwright walkthrough that performs the ten exit test steps in M1.md, on the WebGPU path where the CI browser supports it and on `?webgl`
- Screenshots from the walkthrough saved as CI artifacts and published as browser evidence on the pull request
- A script that generates a 30,000 segment network through commands, with a mix of grids, curves and bridges
- On that network, measure and record: time to apply one `BuildRoad` that crosses ten segments, time for a cross-map route, worker time per tick against the 20 ms budget, frame time in each zoom band, snapshot size and tab memory
- A save and resume test: run a scripted session straight through, and separately save and reload half way. The final hashes must match
- The soak script from M0 extended to build and bulldoze roads while it runs
- Check the three things M7 needs: segments carry a network type, segments carry a vertical level, and curve and slope limits come from the road type. A test builds a segment of each network type through the internal functions and routes with the filter
- Update the PRD with every decision M1 made, and move snapping to zoning cells into the M2 section

## Out of scope

- The two-tab spike, which runs after M1 closes
- Tuning road prices and speeds

## Done when

- [ ] The walkthrough passes in CI on the pull request and against the deployed page
- [ ] Every measurement is recorded in the pull request, and anything over budget has an issue
- [ ] The save and resume hashes match
- [ ] The M1 row in the PRD roadmap is ticked and `docs/milestones/M2.md` is opened as the next task

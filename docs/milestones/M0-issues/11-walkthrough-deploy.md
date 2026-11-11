# M0-11: M0 walkthrough test and static deploy

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: all earlier M0 issues.

## Goal

The M0 exit test runs automatically, and the game is reachable at a public address.

## Scope

- One Playwright walkthrough that performs the seven exit test steps in M0.md, run against both the WebGPU path where the CI browser supports it and the `?webgl` path
- Screenshots from the walkthrough saved as CI artifacts
- A soak script that runs the sim headless at 4x for one hour of game time and reports tick time and memory
- Choose static hosting. GitHub Pages is the default. Record the choice and the reason in the PRD
- A deploy workflow that publishes the built client on every merge to the main branch
- Decide on SharedArrayBuffer. If it is wanted, confirm the host can send the cross-origin isolation headers it needs

## Out of scope

- A custom domain
- Anything server-side

## Done when

- [ ] The walkthrough passes in CI on the pull request
- [ ] The deployed page loads and passes the same walkthrough when pointed at the public address
- [ ] Cold load to an interactive map is under 5 seconds on broadband, measured and recorded
- [ ] The M0 row in the PRD roadmap is ticked and `docs/milestones/M1.md` is opened as the next task

# M3-16: Statistics panel

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 05, 11.

## Goal

The player can see how the city's population got to where it is. See "City statistics" in the PRD.

## Scope

- A statistics panel, opened from the top bar and by a shortcut
- A graph of population over time from the monthly history, with a range choice of 1, 10 and 100 game years
- The breakdowns from the running totals: residents by density, by education and by wealth, workers employed and unemployed, jobs offered and filled by commercial, office and industrial, pops with children, and buildings by zone and density
- Births, deaths, arrivals and departures for the last full game year and the year so far
- Any breakdown with a history can be put on the graph in place of population
- The graph is drawn in the page with SVG or canvas. No chart library unless it is small and MIT licensed
- Later modules add their own lines, so a series is one entry in a list: a label, a colour, where to read it and how to format it

## Out of scope

- Income and spending, average commute, mode share and satisfaction, which later milestones add
- Exporting the numbers
- Per-district or per-block statistics

## Done when

- [ ] Unit tests for the series reader: it gives the right samples for each range from a history that has wrapped
- [ ] A Playwright test loads a city file with fifty game years of history, opens the panel and checks the graph has drawn and the yearly figures match the sim's
- [ ] The same test switches the graph to unemployment and back
- [ ] The panel stays within its frame budget with the history full: opening it on the scale town takes under 100 ms, with the number in the pull request
- [ ] Screenshots of the panel at each range in the pull request
- [ ] No change to sim state, the snapshot version or the protocol version

## Notes

The city file for the test is built in Node by stepping the sim, as the M2 walkthrough's is.

Read the dataviz guidance before drawing the graph: one axis, labelled, no legend where a direct label will do, and colours that work in the page's theme.

A dip and recovery in one street's population is the story turnover tells, but the panel is city-wide. Leave districts for later.

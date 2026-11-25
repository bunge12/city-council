# M4-15: Budget panel

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 04, 07, 08, 11, 14.

## Goal

The player can see where the money comes from and where it goes, and change it. See "M4 Economy" in the PRD.

## Scope

- A budget panel, opened from the treasury in the top bar and by a shortcut, and from City Hall once issue 17 lands
- Income and expenses by line for last month and this month so far, with totals and the net. Development charges sit on their own lines, one per zone, apart from recurring tax, as the PRD asks
- Four tax sliders and five development charge sliders, each sending `SetTaxRate` or `SetDevelopmentCharge` and showing the range from the balance file. Each slider says what it does to its zone in one line
- A loans section: open loans with their balance, repayment and months left, the credit limit, a form to take a loan within it and a button to repay one
- A graph of monthly income, expenses and the treasury over the last year, from the history
- The statistics panel from M3-16 gains the treasury, income and expenses as series, one entry each in its list
- Figures in short form

## Out of scope

- The budget overlay, which is issue 18
- Service budget sliders, which are M8

## Done when

- [ ] Unit tests for the table from a set of ledger figures, and for the net
- [ ] A Playwright test opens the panel on a city file after a month's close and finds every line equal to the sim's, and income less expenses equal to the month's change in the treasury
- [ ] The same test moves the residential tax slider and finds the sim's rate changed, and takes and repays a loan
- [ ] The time to open the panel on the 500,000 resident city is in the pull request. The aim is under 100 ms. No test asserts it
- [ ] Screenshots of the panel with income, a loan and the graph in the pull request
- [ ] No change to sim state, the snapshot version or the protocol version

## Notes

Read the dataviz guidance before drawing the graph, as the statistics panel did.

The panel is ordinary web UI, so it reads the mirror and sends commands. It never works out a figure the sim already has.

# M4-16: Prices and locks in the tools

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 06, 09, 12, 14.

## Goal

Every tool says what an action costs before the click, and the zone tool says what is still locked. See "The price tag" under "Removing things" and "Eminent domain" in the PRD.

## Scope

- The road, grid and upgrade tools show the price in the warning colour, with the reason, when the treasury cannot cover it, from the state-level preview issue 03 added. They add the compensation for buildings the road would take, from the same preview
- The bulldozer's tag gives a building's compensation from the plan: its value, the relocation payment with the people and jobs it covers, and the premium, then the total. A vacant or abandoned building shows demolition only. A road drag's tag gives the road's demolition less its refund, plus the buildings' compensation, then the total
- The zone tool shows a locked density greyed out, with "Unlocks at 2,500 residents" or the milestone's own figure
- The hover readout gives a building's value and its yearly tax

## Out of scope

- City Hall's placement tool, which is issue 17
- Any client arithmetic. Every figure comes from a plan function or `buildingInfo`

## Done when

- [ ] Unit tests for the tag's lines from a plan with compensation, and from one with demolition only
- [ ] A Playwright test points the bulldozer at an occupied house and a vacant one, reads both tags and finds each total equal to the charge after the click
- [ ] The same test spends to the overdraft and finds the road tool's refusal and the "rejected" sound
- [ ] The same test opens the zone tool before density 2 unlocks and finds it greyed with its milestone
- [ ] Screenshots of each tag, the refused road and the locked density in the pull request
- [ ] No change to sim state, the snapshot version or the protocol version

## Notes

The PRD's rule is that the tag and the charge agree because they come from the same function. A test that compares them is the point of this issue.

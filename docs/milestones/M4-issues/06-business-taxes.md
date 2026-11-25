# M4-06: Business taxes

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 05.

## Goal

Shops, offices and factories pay tax on what they do, so a workplace with nobody in it pays nothing. See "M4 Economy" in the PRD.

## Scope

- Commercial tax on sales. A shop's sales follow its jobs filled, times sales per job from `economy.json`, scaled down when the city's shop jobs outnumber what its residents' spending power supports. Spending power is the M3-06 figure. Mixed buildings pay it on their shops
- Office tax on output, which follows jobs filled
- Industrial tax on output, which follows jobs filled while the building's road reaches an outside connection, and is zero while it does not
- Each is charged on the building's daily visit in the TAX sweep from issue 05, to its own line, with the exact daily share
- The function from issue 05 gives each building's yearly tax, now for every zone

## Out of scope

- Shopping trips, freight and congestion lowering what a business pays, which are M5
- The commands that change the rates, which are issue 07

## Done when

- [ ] Unit tests give a shop, an office and a factory a yearly tax from known jobs filled and rates
- [ ] A test cuts a factory's road off from the outside and finds its tax stop, then join it again and find it back
- [ ] A test with more shop jobs than spending power finds each shop's sales scaled down
- [ ] The TAX system's mean and worst tick on the 500,000 resident city are in the pull request, against the share issue 05 set in `budgets.json`
- [ ] A replay gives the same state hash

## Notes

"Business tax follows activity" is the rule. M4 has no trips, so jobs filled stands in for activity. When M5 adds trips and freight, only the base changes and the rates stay.

Spending power comes from the running totals M3 keeps. Read them, do not recount.

# M4-07: Tax rates feed demand and satisfaction

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 06.

## Goal

The player sets four tax rates, and each one pushes back on the zone it taxes. See "M4 Economy" and "Satisfaction" in the PRD.

## Scope

- A `SetTaxRate` command with a zone and a rate, refused outside the range in `economy.json`. It carries the player id and is logged like every command
- Each rate is a signed part of its zone's demand bar: zero at the default rate, below zero above it, above zero below it, with the weight in `demand.json`. The part shows in the bar's tooltip from M3-15 with no client change
- The residential rate is an input to each pop's satisfaction, on its daily visit, with the weight in `pops.json`. A higher rate lowers the score, more for a wealthy pop, as the PRD's satisfaction section says
- The rates go in the delta, and the protocol version goes up. They are state since issue 02, so the snapshot version does not

## Out of scope

- The sliders, which are in the budget panel, issue 15
- Development charge rates, which are issue 08

## Done when

- [ ] Unit tests set each rate and find its bar's tax part with the right sign, and the parts still add up to the bar
- [ ] A scenario test raises the residential rate in a growing town and finds arrivals slow and tax income per resident rise
- [ ] A test finds a wealthy pop's score fall more than a poor one's for the same rate
- [ ] `SetTaxRate` outside the range is refused with a reason
- [ ] A replay gives the same state hash

## Notes

The rule in the PRD's risks table is one or two new inputs to demand per module. Tax is the one M4 adds. Keep its weight small enough that the default rate leaves M3's balance alone.

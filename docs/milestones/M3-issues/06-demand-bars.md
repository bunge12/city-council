# M3-06: Demand bars

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 04.

## Goal

Four numbers say what the city wants more of. See "Four demand bars" in the PRD.

## Scope

- Four values in state, residential, commercial, office and industrial, each from -100 to 100
- A demand system in the step that recomputes them on the first tick of each game day, from the running totals only
- Residential rises with open jobs and falls with unemployment
- Commercial rises with resident spending power and available workers, and falls when shop jobs outnumber the customers to fill them. Spending power is residents weighted by wealth
- Office rises with medium and high education workers without office jobs, and with the residents and businesses that buy services
- Industrial rises with unemployed low and medium education workers and with commercial buildings that need goods, and needs a route to an outside connection
- Whether a piece of the road network has a route to an outside connection: a derived answer per connected piece, from the routing graph of M1-15, kept current as roads change. Issue 08 reads it per home
- Open office jobs count against industrial demand, so a dense city leans on offices. See the notes
- A pull from outside holds the residential bar above zero until the city has a set number of residents
- Each bar also keeps its inputs as signed parts, so the client can say what pushes it up and down
- Every weight is in `demand.json`
- A test helper in `packages/sim/test` that holds the bars at chosen values through a run, so tests of the grower and of arrivals do not need a working economy
- The four values and their parts go in the delta. `SNAPSHOT_VERSION` and the protocol version go up, with a migration and a test

## Out of scope

- Acting on the bars. The grower is issue 07 and arrivals are issue 08
- Average satisfaction as an input to the residential bar, which issue 10 adds
- Residential tax, commutes and services as inputs, which arrive in M4, M5 and M8
- The UI, which is issue 15

## Done when

- [ ] Unit tests set the totals by hand and check each bar's sign: an empty city wants homes, a city of homes with no jobs does not, a city with unemployed workers wants industry and shops, a city with more shop jobs than workers does not want shops
- [ ] A test checks every bar stays within -100 to 100 for extreme totals
- [ ] A test checks the parts of each bar add up to the bar
- [ ] A replay gives the same bars on the same ticks
- [ ] The system's tick time shows in the debug panel as its own system, and is under 0.1 ms

## Notes

The bars read totals, never pops, so the cost does not grow with the city.

On offices standing in for industry: the PRD's land check under "Jobs per building" shows a dense city cannot hold a real share of industrial jobs. The proposal is that industrial demand is driven by workers who have no job of any kind, so office jobs that employ medium education workers lower it. Issue 21 tunes it.

Bars that jump from 80 to -80 in a day make a city flicker. Move each bar part of the way to its new value per day, with the share in `demand.json`.

Arithmetic here is add, subtract, multiply and divide. A replay on another machine, and a city moved to a server, must reach the same bars, so rule 6 applies.

# M3-08: Pops move in

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 05, 06, 07.

## Goal

People arrive in the city and fill its homes.

## Scope

- An arrivals system in the step. While the residential bar is above zero, new pops arrive each game day and take free room in homes
- The number arriving follows the bar, up to a cap in `demand.json`. The starting cap gives about 17,000 new residents a game year at full demand, from "Pacing" in the PRD
- Arrivals are spread over the ticks of the day, not all on the first
- A home takes newcomers only if its road has a route to an outside connection, read from issue 06's answer. See the notes
- Free room in standing buildings fills before more is built: the grower builds no home while the city's empty room is above a set share of its capacity, in `demand.json`. See "Turnover" in the PRD
- The day's plan of arrivals is state, so a city saved mid-day resumes the same. `SNAPSHOT_VERSION` goes up, with a migration and a test
- A newcomer's size, education, wealth and children are drawn from the generator in state with the mix in `pops.json`. Size is within the cap for the home's density and the room left
- Newcomers arrive without a job. Issue 09 finds them one
- Each arrival adds to the year's arrivals count from issue 04
- The reason a home stays empty is available to the client: no demand, or no route to the outside

## Out of scope

- Jobs, which are issue 09
- Leaving, which is issue 10
- Land value shaping a newcomer's wealth, which issue 25 adds
- Schools shaping education, which is M8

## Done when

- [ ] A scenario test builds a street from an outside connection, zones it R1 and finds houses with people in them after a set number of game days, households of different sizes
- [ ] A scenario test builds a street joined to nothing and finds its houses built and empty
- [ ] A scenario test finds homes stop being built once empty room passes the share, and start again when it fills
- [ ] A scenario test fills a tower and finds several pops, each within the size cap
- [ ] The totals equal the recount at the end of each test
- [ ] A replay of a recorded log gives the same pops and the same state hash
- [ ] A city saved and reloaded while people arrive hashes the same as one that never stopped
- [ ] The system's tick time shows in the debug panel, with its worst tick at the arrivals cap in the pull request

## Notes

On the outside rule: the PRD says positive demand "brings pops in through the outside connections". Taking that literally gives the connections a job before traffic exists, and gives a new player a first lesson: join your street to the highway.

The single family home draws 1 to 4 residents as capacity in M2, while the PRD says it has room for four. With pops, capacity and people are separate at last. Decide here whether the home's capacity becomes a flat 4 and the draw moves to the pop, and update "Residential building types" in the PRD.

Which home a newcomer takes is drawn from the generator in state among homes with room. Issue 25 weights that draw by land value.

# M1-05: Road deltas in the protocol and the mirror

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 03.

## Goal

The client's read-only copy of the city has the road network in it and stays current without a full snapshot every tick.

## Scope

- The delta message carries the nodes and segments that were added, changed or removed since the last delta
- The sim records what a step changed, and the host drains that list after each step, the same way it reads new log entries
- The change list is not game state. It is left out of the hash and the save, and a city behaves the same whether or not a host reads it
- `SimMirror` applies road deltas to its copy and tells listeners which 500 m chunks changed
- A snapshot message still carries the whole network, for first load and for a client that spots a gap
- `PROTOCOL_VERSION` goes up

## Out of scope

- Drawing roads, which is issue 06
- Sending deltas only for chunks near the camera. That waits for multiplayer

## Done when

- [ ] A mirror fed a snapshot and then 1,000 ticks of deltas from random road commands equals the sim's network, array for array
- [ ] A tick with no road changes adds no road data to its delta
- [ ] A mirror that misses a delta detects the gap and asks for a snapshot
- [ ] Removing a segment and reusing its id in the same tick reaches the mirror as the new segment, not the old one
- [ ] The client protocol tests pass with the new version

## Notes

The PRD target is that a placed road reaches other players within 250 ms. In single player the delta leaves on the step that applies the command, so the worker path is well inside that.

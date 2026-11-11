# M0-04: Sim host: Web Worker and the message protocol

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 02.

## Goal

The sim runs in a Web Worker, and the client talks to it through an interface that a WebSocket can later implement unchanged.

## Scope

- A `SimTransport` interface in the client with `send(message)` and `onMessage(handler)`. Nothing above it knows whether the other end is a worker or a socket
- A `WorkerTransport` implementation and the worker entry file that hosts `sim`
- Messages to the sim: `command`, `requestSnapshot`. Messages from the sim: `snapshot`, `delta`, `commandResult`
- The worker drives the tick loop from real time, 10 ticks per second at 1x and scaled by speed, catching up after a stall by at most a few ticks so a background tab does not explode on return
- Snapshots transfer typed array buffers without copying where the browser allows. Deltas carry only what changed, which in M0 is the tick, the speed and new log entries
- A client-side `SimMirror` that holds the read-only copy of state and applies snapshots and deltas
- Per-system tick timings reported from the worker for the debug panel

## Out of scope

- The server and the WebSocket transport, which come with the multiplayer spike
- SharedArrayBuffer. It needs cross-origin isolation headers, so decide on it with hosting in issue 11

## Done when

- [ ] A Vitest test drives the same protocol with an in-memory transport and no worker
- [ ] A Playwright test shows the tick advancing in the page and a `NoOp` round-tripping to a `commandResult`
- [ ] Pausing stops the tick. 4x runs four times as many ticks per second as 1x, within tolerance
- [ ] The message types are defined once, in `sim`, and imported by both ends

## Notes

Keep message shapes boring and versioned. They become the network protocol.

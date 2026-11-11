# M0-10: UI shell, speed controls and debug panel

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: 04, 07.

## Goal

The page has its frame: a top bar, the controls M0 needs, and the debug panel later modules will lean on.

## Scope

- React mounted over the canvas, with Zustand for UI state only. Sim state reaches React through selectors on the `SimMirror` and is never copied into the store
- Top bar with the city name, the game date derived from the tick, and pause, 1x, 2x and 4x. The buttons send `SetSpeed` commands
- A city menu: new city from a seed, save, load from the local list, download, import
- Debug panel, toggled by a key: ticks per second, tick time per system against the 20 ms budget, frame time, memory where the browser reports it, camera position, zoom band, cursor world coordinates, renderer backend
- An activity log view listing recent commands with tick and player id, and a button that sends `NoOp`
- Number formatting helper for money in short form, such as $3.2B and $480M, with tests. Nothing uses it until M4

## Out of scope

- Build tools, overlays and budget panels
- Visual design beyond clean and legible

## Done when

- [ ] Every exit test step in M0.md can be performed through this UI
- [ ] A lint rule or test shows no React component imports sim state types for writing
- [ ] Keyboard shortcuts for speed work and are listed in the debug panel
- [ ] Screenshots attached to the pull request

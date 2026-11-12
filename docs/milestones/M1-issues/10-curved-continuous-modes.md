# M1-10: Curved and continuous drawing modes

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 08, 09.

## Goal

The road tool has the three drawing modes the PRD lists: straight, curved and continuous.

## Scope

- A mode picker on the road tool, with a shortcut for each mode
- Curved mode takes three clicks: start, a point that sets the direction, end. The preview shows the curve as the cursor moves
- When a curve starts from the end of an existing road, it leaves in line with that road by default
- Continuous mode starts the next segment where the last one ended, and keeps going until Escape or a double click
- Each segment in continuous mode is its own `BuildRoad` command, so each is its own log entry and its own undo step
- Snapping from issue 08 applies to every click in every mode
- The preview shows a refused curve in red with the reason, including a curve that is too tight
- Length and cost in the preview follow the curve

## Out of scope

- Free-hand drawing
- Editing a curve after it is built. Bulldoze and redraw

## Done when

- [ ] A Playwright walkthrough draws a curved avenue that ends on an existing node, and a three-segment road in continuous mode
- [ ] A curve drawn from a road end has no visible kink at the join
- [ ] Switching mode or tool part way through a road cancels it and leaves nothing behind
- [ ] A rejection part way through a continuous road keeps the segments already built and stops there
- [ ] Screenshots attached to the pull request

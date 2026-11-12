# M1-21: Grid tool

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 08, 20.

## Goal

A player lays out a street grid with one drag and one click. See "Grid tool" in the PRD.

## Scope

- A grid tool in the toolbar, with a shortcut listed with the others
- Drag out a rectangle. Started on an existing road, the rectangle takes that road's angle. Started on open ground, it is square to the map and a modifier key rotates it during the drag
- The corners use the node and segment snaps from issue 08
- Block depth and width in cells, twelve deep by default, and the road type from the road type picker
- The preview runs `planRoadGrid` on the mirror. It shows every street, where streets stop at water or steep ground, the junctions with existing roads, the street count and the total cost
- A grid the sim would refuse shows red with the reason, and a click on it sends nothing
- A click on Confirm, or Enter, sends one `BuildRoadGrid`. Escape or a right-click drops the rectangle
- The sent grid stays on screen until the delta with the real roads arrives, as the road tool does since issue 07
- Tool state lives in the UI store and never touches sim state

## Out of scope

- The eminent domain cost in the preview, which waits for buildings in M2 and money in M4
- Editing a grid after it is built. Undo and redraw
- Curved grids

## Done when

- [ ] A Playwright walkthrough drags a rectangle off an existing street, confirms, and sees a grid joined to that street, with one entry in the activity log
- [ ] One Ctrl+Z removes the whole grid
- [ ] A rectangle dragged over water shows the cut streets in the preview before the click, and builds what the preview showed
- [ ] A grid over the cap shows the reason and cannot be confirmed
- [ ] Screenshots of the preview and the built grid attached to the pull request

## Notes

The preview recomputes on every pointer move. `planRoadGrid` at the cap has to fit in a frame. If it does not, plan on a short delay after the pointer stops and show the plain rectangle until then.

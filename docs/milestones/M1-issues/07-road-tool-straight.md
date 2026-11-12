# M1-07: Road tool: straight drawing, preview and cost

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 06.

## Goal

A player can draw straight roads with the mouse. This is the first playable slice of M1.

## Scope

- A build toolbar with a road tool and a picker for street, avenue and one-way
- Click to set the start, move to see a preview, click again to send `BuildRoad`. Escape or right-click cancels
- The preview is drawn at the real width of the road type and turns red when the road would be refused, with the reason next to the cursor
- The client checks the preview with the same validation function the sim exports, run against the mirror. The sim still has the final say
- The preview shows the length and the build cost from the balance data, in the short money format from M0
- While the command is in flight the preview stays. An accepted command swaps it for the real road. A rejection removes it and shows the reason
- A crossing shows a marker where the intersection will form
- Camera controls keep working while the tool is active, and a click that ends a camera drag does not place a road
- Tool state lives in the UI store. It never touches sim state

## Out of scope

- Snapping beyond joining an existing node, which is issue 08
- Curved and continuous modes, upgrade and bulldoze
- Charging the cost

## Done when

- [ ] A Playwright walkthrough draws a street, crosses it with an avenue, and sees a four-way junction and two log entries
- [ ] The walkthrough tries a road into water and sees the reason and no new log entry
- [ ] The cost shown equals length times the price in the balance file
- [ ] Keyboard shortcuts for the tool and the road types work and are listed with the others
- [ ] Screenshots attached to the pull request

## Notes

In multiplayer the answer to a command arrives later than it does from a worker. Build the in-flight state now so the tool does not change when the server arrives.

# M1-09: Curved segments in the sim and the renderer

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 06.

## Goal

A segment can be a curve, and everything that worked for straight segments works for curved ones.

## Scope

- `BuildRoad` takes an optional control point. With one, the segment is a single quadratic curve between its two nodes
- Curve maths in the sim uses only add, subtract, multiply, divide and `Math.sqrt`
- Length is measured on a fixed subdivision of the curve, so every machine gets the same number
- A curve tighter than the minimum radius of its road type is refused with a reason
- Slope and water checks sample along the curve
- Crossing and splitting work between any mix of straight and curved segments. A split curve becomes two curves that trace the original path
- The spatial index stores curves by their bounds, and nearest-point queries work on them
- The renderer draws curves with enough subdivisions to look smooth at street level and fewer when far away, and junctions with curved arms have no gaps

## Out of scope

- The drawing modes that produce curves, which are issue 10. This issue is tested through commands and a fixture city
- Arcs, splines and S-curves in one segment

## Done when

- [ ] Unit tests cover length, the radius limit, a curve crossing a line, a curve crossing a curve twice, and a split that keeps the shape within 1 cm
- [ ] The no-unjoined-crossings test from issue 04 passes on 500 random roads, half of them curved
- [ ] A replay fixture with curves produces its committed hash in Node and in the browser
- [ ] A Playwright screenshot of a fixture city with curved roads and a curved junction matches

## Notes

A quadratic curve keeps the sim to exact arithmetic, which is why the PRD's "single curve" is read this way. The minimum radius comes from the road type because rail in M7 needs wider curves than a street.

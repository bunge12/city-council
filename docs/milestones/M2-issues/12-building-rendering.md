# M2-12: Building rendering: generators, instancing and tint

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 02, 10.

## Goal

Buildings in the mirror appear on the map in the street band, in the look "Art direction" in the PRD describes.

## Scope

- One generator function per building type. It builds geometry from the footprint, the floor count, the roof shape and the window rhythm. No mesh or texture files
- Three or four variants per zone and density to start with. Plain shapes are fine
- A theme pack for the North American theme, holding the generators, the palettes and nothing from the sim. It is the only place that knows where a model came from
- Each model marks its tintable surfaces, such as wall, roof and trim. Each building picks a tint for each from its type's palette, worked out from the building's id
- Instanced drawing, one instanced mesh per variant, with the tint as per-instance colour
- The building material from issue 02's lighting, with shadows cast and received in Balanced and High
- Each building sits on its lot, faces its road and follows the terrain under it
- Buildings fill in by chunk from the camera outward. Building the meshes never stalls a frame
- Cells under a building are not drawn by the zoning overlay

## Out of scope

- The district and city bands, which are issue 13
- Surface detail from shaders beyond a flat tint and a simple window pattern
- A European theme, which is v2
- Authored models

## Done when

- [ ] A Playwright test loads a fixture city with every building type and screenshots match at Balanced and at Low
- [ ] The same building has the same colours after a reload, and a test checks the tint is a function of the id alone
- [ ] Adding one building touches one instance and rebuilds no chunk, shown by a counter in the debug panel
- [ ] Two houses of one type on one street show different colours
- [ ] Both the WebGPU path and `?webgl` render the same picture
- [ ] Screenshots attached to the pull request

## Notes

The sim's variant number picks the model, and the id picks the colours. Neither may come from `Math.random` on the client, or two players would see two different streets.

Ids are reused, so a new building on an old id gets the old colours. That is fine.

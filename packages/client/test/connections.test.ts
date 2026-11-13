// The outside connections on the client (issue M1-16): where the camera
// starts, and the marks drawn on each connection.
import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three/webgpu";
import { connectionEnd, createBareState, createState, generateTerrain, mapEdge } from "@city-council/sim";
import { START_VIEW } from "../src/camera/config";
import { createCameraRig } from "../src/camera/rig";
import { startPose, wholeMapPose } from "../src/camera/start-pose";
import { zoomBand } from "../src/camera/zoom-band";
import { CONNECTION_MARKS } from "../src/render/config";
import { buildConnectionMarks, connectionMarks } from "../src/render/connection-marks-geometry";

const SEED = 2026;
const state = createState(SEED);
const terrain = generateTerrain(SEED);

describe("the start view", () => {
  it("looks along the first connection's stub into the map, from the city band", () => {
    const pose = startPose(terrain, state.roads, state.connections);
    const edge = state.connections[0] ?? -1;
    const inner = connectionEnd(state.roads, edge);
    const r = state.roads;
    const ux = ((r.nodeX[inner] ?? 0) - (r.nodeX[edge] ?? 0)) / 200;
    const uz = ((r.nodeZ[inner] ?? 0) - (r.nodeZ[edge] ?? 0)) / 200;
    expect(pose.target[0]).toBeCloseTo((r.nodeX[inner] ?? 0) + ux * START_VIEW.lead, 6);
    expect(pose.target[2]).toBeCloseTo((r.nodeZ[inner] ?? 0) + uz * START_VIEW.lead, 6);
    // The camera looks in along the stub, swung off its line by START_VIEW.swing.
    const dx = pose.target[0] - pose.position[0];
    const dz = pose.target[2] - pose.position[2];
    expect(Math.acos((dx * ux + dz * uz) / Math.hypot(dx, dz))).toBeCloseTo(START_VIEW.swing, 9);

    const camera = new PerspectiveCamera(45, 16 / 9, 10, 60_000);
    const rig = createCameraRig(camera, terrain, () => ({ width: 1280, height: 720 }));
    rig.setPose(pose.position, pose.target);
    expect(zoomBand(rig.heightAboveGround())).toBe("city");
    // The edge node is in front of the camera and on screen.
    const p = camera.position.clone().set(r.nodeX[edge] ?? 0, 0, r.nodeZ[edge] ?? 0).project(camera);
    expect(Math.abs(p.x)).toBeLessThan(1);
    expect(Math.abs(p.y)).toBeLessThan(1);
  });

  it("shows the whole map on a city with no connections", () => {
    const bare = createBareState(SEED);
    expect(startPose(terrain, bare.roads, bare.connections)).toEqual(wholeMapPose(terrain));
  });
});

describe("connection marks", () => {
  it("put one disc on each connection, all on the map, pointing along its stub", () => {
    const marks = connectionMarks(state.roads, state.connections, () => 4);
    expect(marks).toHaveLength(state.connections.length);
    const edge = mapEdge(terrain);
    for (const m of marks) {
      const r = CONNECTION_MARKS.discPx * 4;
      expect(Math.hypot(m.x - m.edgeX, m.z - m.edgeZ)).toBeCloseTo(r, 6);
      for (const v of [m.x - r, m.z - r]) expect(v).toBeGreaterThanOrEqual(-1e-9);
      for (const v of [m.x + r, m.z + r]) expect(v).toBeLessThanOrEqual(edge + 1e-9);
      expect(Math.hypot(m.ux, m.uz)).toBeCloseTo(1, 12);
    }
  });

  it("size each mark by its own scale, in screen pixels", () => {
    const marks = connectionMarks(state.roads, state.connections, () => 1);
    const small = buildConnectionMarks(terrain, marks, marks.map(() => 1));
    const big = buildConnectionMarks(terrain, marks, marks.map(() => 10));
    expect(big.indices).toEqual(small.indices);
    const spread = (a: Float32Array) => {
      let max = 0;
      for (let i = 0; i < a.length; i += 3) max = Math.max(max, Math.abs((a[i] ?? 0) - (a[0] ?? 0)));
      return max;
    };
    const first = (a: Float32Array) => a.slice(0, 3 * (CONNECTION_MARKS.discSides + 1));
    expect(spread(first(big.positions))).toBeCloseTo(10 * spread(first(small.positions)), 1);
  });

  it("draw nothing for a city with no connections", () => {
    const bare = createBareState(SEED);
    expect(connectionMarks(bare.roads, bare.connections, () => 1)).toEqual([]);
  });
});

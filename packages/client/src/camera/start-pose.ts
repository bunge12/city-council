// The pose the camera starts in when a map is shown: looking at the first
// outside connection, or at the whole map when the city has none.

import { NONE, connectionEnd, heightAt, mapSize, type RoadNetwork, type Terrain } from "@city-council/sim";
import { START_VIEW } from "./config";
import type { ReadonlyDeep } from "../protocol/mirror";

type Vec3 = [number, number, number];

/** The whole map from the south, the view before a city had connections. */
export function wholeMapPose(terrain: Terrain): { position: Vec3; target: Vec3 } {
  const size = mapSize(terrain);
  return { position: [size / 2, size * 0.7, size * 1.32], target: [size / 2, 0, size * 0.47] };
}

/**
 * A view of the first connection in `connections`: the camera behind its
 * edge node and swung off the stub's line, looking into the map at a point
 * `lead` metres past the stub's inner end.
 */
export function startPose(
  terrain: Terrain,
  net: ReadonlyDeep<RoadNetwork>,
  connections: ArrayLike<number>,
): { position: Vec3; target: Vec3 } {
  const edge = connections.length > 0 ? (connections[0] ?? NONE) : NONE;
  const inner = connectionEnd(net as RoadNetwork, edge);
  if (inner === NONE) return wholeMapPose(terrain);
  const ex = net.nodeX[edge] ?? 0;
  const ez = net.nodeZ[edge] ?? 0;
  const ix = net.nodeX[inner] ?? 0;
  const iz = net.nodeZ[inner] ?? 0;
  const len = Math.hypot(ix - ex, iz - ez);
  const ux = (ix - ex) / len;
  const uz = (iz - ez) / len;
  const tx = ix + ux * START_VIEW.lead;
  const tz = iz + uz * START_VIEW.lead;
  const ty = heightAt(terrain, tx, tz);
  const flat = START_VIEW.distance * Math.cos(START_VIEW.pitch);
  // Back along the stub, swung round by `swing`.
  const c = Math.cos(START_VIEW.swing);
  const s = Math.sin(START_VIEW.swing);
  const bx = -ux * c + uz * s;
  const bz = -uz * c - ux * s;
  return {
    position: [tx + bx * flat, ty + START_VIEW.distance * Math.sin(START_VIEW.pitch), tz + bz * flat],
    target: [tx, ty, tz],
  };
}

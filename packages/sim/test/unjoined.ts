// The check every crossing test ends with: no two segments on one network
// and level meet except at a node they share.

import { quadsMeetAwayFrom, segmentQuad } from "../src/roads/curve";
import { NONE, isSegment, segmentIdLimit, type RoadNetwork } from "../src/roads/network";

/**
 * Pairs of live segments on the same network and level that meet anywhere
 * but a shared node, curves included. After any accepted command there must
 * be none.
 */
export function unjoinedCrossings(net: RoadNetwork): [number, number][] {
  const bad: [number, number][] = [];
  const limit = segmentIdLimit(net);
  for (let s = 0; s < limit; s++) {
    if (!isSegment(net, s)) continue;
    const a = net.segA[s] ?? NONE;
    const b = net.segB[s] ?? NONE;
    const p = segmentQuad(net, s);
    for (let t = s + 1; t < limit; t++) {
      if (!isSegment(net, t) || net.segNetwork[t] !== net.segNetwork[s] || net.segLevel[t] !== net.segLevel[s]) continue;
      const c = net.segA[t] ?? NONE;
      const d = net.segB[t] ?? NONE;
      const shared = [a, b]
        .filter((n) => n === c || n === d)
        .map((n) => ({ x: net.nodeX[n] ?? 0, z: net.nodeZ[n] ?? 0 }));
      if (quadsMeetAwayFrom(p, segmentQuad(net, t), shared)) bad.push([s, t]);
    }
  }
  return bad;
}

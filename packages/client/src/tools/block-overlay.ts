// The debug panel's block overlay (issue M1-18). With it on, every block the
// sim finds is outlined on the map with its area beside it, so a player can
// close a loop of roads and watch the block appear, then bulldoze a side and
// watch it go.
//
// The blocks come from `blockIndexOf`, the sim's own face walk, run on the
// mirror's read-only copy of the roads, which `applyRoadDelta` keeps
// current. They are read again whenever the mirror's roads change. Nothing
// here writes sim state.

import {
  blockIndexOf,
  listBlocks,
  quadPoint,
  segmentQuad,
  type Block,
  type RoadNetwork,
} from "@city-council/sim";
import { roadTypeOf, type RoadNet } from "../render/road-geometry";
import type { PreviewShape } from "../render/road-preview-geometry";
import { BLOCK_OVERLAY } from "./config";

/** The block overlay's part of the UI store. */
export interface BlockOverlayState {
  /** Whether the overlay is on. */
  showBlocks: boolean;
  /** The blocks on the mirror's roads as they are now, or null while the overlay is off. */
  blocks: readonly Block[] | null;
}

export const INITIAL_BLOCK_OVERLAY: BlockOverlayState = { showBlocks: false, blocks: null };

/** What the controller needs from the page. */
export interface BlockOverlayHost {
  get(): BlockOverlayState;
  set(patch: Partial<BlockOverlayState>): void;
  /** The mirror's roads, or null before the first snapshot. */
  net(): RoadNet | null;
}

function asNetwork(net: RoadNet): RoadNetwork {
  // The block walk only reads the network. The index it keeps is derived
  // data, outside the mirror's copy of state.
  return net as unknown as RoadNetwork;
}

/** The blocks of `net`, by ascending id. */
export function blocksOf(net: RoadNet): Block[] {
  return listBlocks(blockIndexOf(asNetwork(net)));
}

/** Turns the overlay on and off and keeps its blocks current. Holds no state of its own. */
export class BlockOverlayController {
  private readonly host: BlockOverlayHost;

  constructor(host: BlockOverlayHost) {
    this.host = host;
  }

  toggle(): void {
    const on = !this.host.get().showBlocks;
    this.host.set({ showBlocks: on, blocks: null });
    this.refresh();
  }

  /** Reads the blocks again from the mirror's roads. Call on every change to them. */
  refresh(): void {
    const s = this.host.get();
    if (!s.showBlocks) return;
    const net = this.host.net();
    this.host.set({ blocks: net ? blocksOf(net) : null });
  }
}

/**
 * The outline of every block: a thin strip along each segment that bounds
 * one. A segment between two blocks, or walked out and back as a dead end,
 * is drawn once.
 */
export function blockShapes(net: RoadNet, blocks: readonly Block[]): PreviewShape[] {
  const seen = new Set<number>();
  const out: PreviewShape[] = [];
  for (const block of blocks) {
    for (const seg of block.segments) {
      if (seen.has(seg)) continue;
      seen.add(seg);
      const q = segmentQuad(asNetwork(net), seg);
      const straight = q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2;
      out.push({
        ax: q.ax,
        az: q.az,
        bx: q.bx,
        bz: q.bz,
        control: straight ? null : { x: q.cx, z: q.cz },
        width: roadTypeOf(net, seg).width * BLOCK_OVERLAY.widthScale,
        look: "block",
        junctions: [],
        bridges: [],
      });
    }
  }
  return out;
}

/**
 * Where a block's label goes: the centroid of its boundary, with each curve
 * followed through a few points. For a block bent round on itself the
 * centroid can fall outside it; a debug label can live with that.
 */
export function blockLabelPoint(net: RoadNet, block: Block): { x: number; z: number } {
  const xs: number[] = [];
  const zs: number[] = [];
  block.segments.forEach((seg, i) => {
    const q = segmentQuad(asNetwork(net), seg);
    const forward = block.forward[i] ?? true;
    const straight = q.cx === (q.ax + q.bx) / 2 && q.cz === (q.az + q.bz) / 2;
    const steps = straight ? 1 : BLOCK_OVERLAY.labelCurveSteps;
    for (let k = 0; k < steps; k++) {
      const t = forward ? k / steps : 1 - k / steps;
      const p = quadPoint(q, t);
      xs.push(p.x);
      zs.push(p.z);
    }
  });
  let twice = 0;
  let cx = 0;
  let cz = 0;
  const n = xs.length;
  const ox = xs[0] ?? 0;
  const oz = zs[0] ?? 0;
  for (let i = 0; i < n; i++) {
    const x0 = (xs[i] ?? 0) - ox;
    const z0 = (zs[i] ?? 0) - oz;
    const x1 = (xs[(i + 1) % n] ?? 0) - ox;
    const z1 = (zs[(i + 1) % n] ?? 0) - oz;
    const cross = x0 * z1 - x1 * z0;
    twice += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (twice === 0) return { x: ox, z: oz };
  return { x: ox + cx / (3 * twice), z: oz + cz / (3 * twice) };
}

/** An area as the overlay shows it, such as "40,000 m²". */
export function formatArea(squareMetres: number): string {
  return `${Math.round(squareMetres).toLocaleString("en-US")} m²`;
}

/** What the debug panel says about the overlay. */
export function blocksReadout(s: BlockOverlayState): string {
  if (!s.showBlocks) return "off";
  if (!s.blocks) return "waiting for roads";
  if (s.blocks.length === 0) return "no blocks";
  return s.blocks.length === 1 ? "1 block" : `${s.blocks.length} blocks`;
}

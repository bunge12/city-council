// The North American theme (PRD, "Art direction"): the generators in
// generators.ts and the palettes in palettes.json. It reads the building
// types' and the landmarks' lot sizes from the sim's balance, and nothing
// else from the sim.

import { BUILDING_TYPES, LANDMARKS, ZONING_BALANCE } from "@city-council/sim";
import type { ModelArrays } from "../model";
import { landmarkTypeId, type Palette, type Theme } from "../theme";
import { GENERATORS, LANDMARK_GENERATORS } from "./generators";
import palettes from "./palettes.json" with { type: "json" };

function hex(value: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`palettes.json: ${value} is not a #rrggbb colour`);
  return parseInt(value.slice(1), 16);
}

function palette(name: string): Palette {
  const family = (palettes.families as Record<string, { wall: string[]; roof: string[]; trim: string[] } | undefined>)[name];
  if (!family) throw new Error(`palettes.json: no family ${name}`);
  const read = (list: string[], part: string) => {
    if (list.length === 0) throw new Error(`palettes.json: family ${name} has no ${part} colours`);
    return list.map(hex);
  };
  return { wall: read(family.wall, "wall"), roof: read(family.roof, "roof"), trim: read(family.trim, "trim") };
}

const FAMILIES = new Map(Object.keys(palettes.families).map((name) => [name, palette(name)]));
const TYPES = new Map(BUILDING_TYPES.map((t) => [t.id, t]));
/** The landmarks' lots, by `landmarkTypeId` of their ids (M4-17). */
const LANDMARK_LOTS = new Map(LANDMARKS.map((l) => [landmarkTypeId(l.id), l]));
/** Every generator, the building types' and the landmarks'. */
const ALL_GENERATORS = { ...GENERATORS, ...LANDMARK_GENERATORS };

// Every type the sim knows has a generator and a palette, checked when the
// theme loads, so a type added to buildings.json without a model fails at
// once and not when the first one grows.
for (const t of BUILDING_TYPES) {
  if (!GENERATORS[t.id]) throw new Error(`the North American theme has no generator for ${t.id}`);
  const family = (palettes.types as Record<string, string | undefined>)[t.id];
  if (!family || !FAMILIES.has(family)) throw new Error(`the North American theme has no palette for ${t.id}`);
}
// And every landmark, so the central station added to economy.json in M7 fails here until it has a model.
for (const l of LANDMARKS) {
  const id = landmarkTypeId(l.id);
  if (!LANDMARK_GENERATORS[id]) throw new Error(`the North American theme has no generator for the ${l.name}`);
  const family = (palettes.types as Record<string, string | undefined>)[id];
  if (!family || !FAMILIES.has(family)) throw new Error(`the North American theme has no palette for the ${l.name}`);
}

const FALLBACK: Palette = { wall: [0xcccccc], roof: [0x777777], trim: [0xeeeeee] };

export const NORTH_AMERICAN: Theme = {
  name: "North American",
  modelCount: (typeId) => ALL_GENERATORS[typeId]?.models ?? 1,
  model(typeId, model, widthCells, depthCells): ModelArrays {
    const gen = ALL_GENERATORS[typeId] ?? GENERATORS["single-family-home"];
    if (!gen) throw new Error("no generator");
    const cell = ZONING_BALANCE.cellSize;
    return gen.generate({ w: widthCells * cell, d: depthCells * cell }, model);
  },
  modelDepth(typeId) {
    const landmark = LANDMARK_LOTS.get(typeId);
    if (landmark) return landmark.depth;
    const t = TYPES.get(typeId);
    return t ? Math.round((t.depth[0] + t.depth[1]) / 2) : 2;
  },
  palette(typeId) {
    const family = (palettes.types as Record<string, string | undefined>)[typeId];
    return (family && FAMILIES.get(family)) || FALLBACK;
  },
  fixed: {
    glass: hex(palettes.fixed.glass),
    glassTints: palettes.fixed.glassTints.map(hex),
    sky: hex(palettes.fixed.sky),
    paving: hex(palettes.fixed.paving),
  },
};

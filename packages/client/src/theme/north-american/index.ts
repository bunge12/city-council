// The North American theme (PRD, "Art direction"): the generators in
// generators.ts and the palettes in palettes.json. It reads the building
// types' lot sizes from the sim's balance, and nothing else from the sim.

import { BUILDING_TYPES, ZONING_BALANCE } from "@city-council/sim";
import type { ModelArrays } from "../model";
import type { Palette, Theme } from "../theme";
import { GENERATORS } from "./generators";
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

// Every type the sim knows has a generator and a palette, checked when the
// theme loads, so a type added to buildings.json without a model fails at
// once and not when the first one grows.
for (const t of BUILDING_TYPES) {
  if (!GENERATORS[t.id]) throw new Error(`the North American theme has no generator for ${t.id}`);
  const family = (palettes.types as Record<string, string | undefined>)[t.id];
  if (!family || !FAMILIES.has(family)) throw new Error(`the North American theme has no palette for ${t.id}`);
}

const FALLBACK: Palette = { wall: [0xcccccc], roof: [0x777777], trim: [0xeeeeee] };

export const NORTH_AMERICAN: Theme = {
  name: "North American",
  modelCount: (typeId) => GENERATORS[typeId]?.models ?? 1,
  model(typeId, model, widthCells, depthCells): ModelArrays {
    const gen = GENERATORS[typeId] ?? GENERATORS["single-family-home"];
    if (!gen) throw new Error("no generator");
    const cell = ZONING_BALANCE.cellSize;
    return gen.generate({ w: widthCells * cell, d: depthCells * cell }, model);
  },
  modelDepth(typeId) {
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

import { BUILDING_TYPES, ZONING_BALANCE, type BuildingGround, type BuildingInfo } from "@city-council/sim";
import { useBuildingHover } from "./store";

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

function residentsOf(n: number): string {
  return n === 1 ? "1 resident" : `${n.toLocaleString("en-US")} residents`;
}

/**
 * The lines the readout shows for a building: its type, then zone and
 * density, lot size and residents. Given `living`, the people living there
 * now, a home says them against its room, as the bulldozer's tag does for
 * the people a click would displace (M3-12); without it, its room.
 */
export function buildingLines(b: BuildingInfo, living?: number): { title: string; detail: string } {
  const type = BUILDING_TYPES[b.type];
  const zone = ZONING_BALANCE.zones[b.zone - 1];
  const lot = `lot ${b.width} × ${b.depth} cells`;
  const home = (type?.residents[1] ?? 0) > 0;
  const residents = !home
    ? "no residents"
    : living === undefined
      ? residentsOf(b.residents)
      : living === 0
        ? `nobody living here, room for ${b.residents.toLocaleString("en-US")}`
        : `${residentsOf(living)}, room for ${b.residents.toLocaleString("en-US")}`;
  return {
    title: type?.name ?? "Building",
    detail: `${zone?.name ?? "?"} ${zone?.letter ?? "?"}${b.density} · ${lot} · ${residents}`,
  };
}

/**
 * What the readout says of a building's ground when it is no longer zoned
 * as it was built (M3-14), or null when it is: on ground zoned for
 * something else it stands as a permitted existing use and the ground
 * rebuilds under its zoning once it is abandoned; on ground zoned up its
 * owner may redevelop.
 */
export function groundLine(ground: BuildingGround | null): string | null {
  if (!ground || ground.kind === "as-built") return null;
  const zone = ZONING_BALANCE.zones[ground.zone - 1];
  const label = zone ? `${zone.name} ${zone.letter}${ground.density}` : null;
  if (ground.kind === "zoned-up") return `Zoned up to ${label ?? "?"} · may redevelop`;
  return label ? `Permitted existing use · rebuilds as ${label} once abandoned` : "Permitted existing use · its ground is no longer zoned";
}

/**
 * Next to the cursor over a building while no tool is on (issue M2-15): its
 * type, zone and density, lot size in cells and residents. The bulldozer
 * shows the same (issue 116). When its ground is zoned for something else,
 * or zoned up, a third line says so (M3-14). The numbers are on data
 * attributes too, for tests.
 */
export function BuildingReadout() {
  const hover = useBuildingHover((s) => s.hover);
  if (!hover) return null;
  const b = hover.building;
  const { title, detail } = buildingLines(b);
  const ground = groundLine(hover.ground);
  return (
    <div
      className="road-readout building-readout"
      id="building-readout"
      role="status"
      data-building={String(b.id)}
      data-type={BUILDING_TYPES[b.type]?.id ?? ""}
      data-zone={String(b.zone)}
      data-density={String(b.density)}
      data-width={String(b.width)}
      data-depth={String(b.depth)}
      data-residents={String(b.residents)}
      data-ground={hover.ground?.kind ?? ""}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">{title}</div>
      <div className="detail">{detail}</div>
      {ground ? <div className="detail ground">{ground}</div> : null}
    </div>
  );
}

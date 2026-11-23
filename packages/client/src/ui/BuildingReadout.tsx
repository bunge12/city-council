import { BUILDING_TYPES, ZONING_BALANCE, type BuildingInfo } from "@city-council/sim";
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
 * Next to the cursor over a building while no tool is on (issue M2-15): its
 * type, zone and density, lot size in cells and residents. The bulldozer
 * shows the same (issue 116). The numbers are on data attributes too, for
 * tests.
 */
export function BuildingReadout() {
  const hover = useBuildingHover((s) => s.hover);
  if (!hover) return null;
  const b = hover.building;
  const { title, detail } = buildingLines(b);
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
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">{title}</div>
      <div className="detail">{detail}</div>
    </div>
  );
}

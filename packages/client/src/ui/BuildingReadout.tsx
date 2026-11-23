import { BUILDING_TYPES, ZONING_BALANCE, type BuildingGround, type BuildingInfo } from "@city-council/sim";
import { useBuildingHover } from "./store";

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

/** Why no newcomer would move into a home, as the mirror's `whyNoNewcomers` says (M3-08). */
export type NoNewcomers = "abandoned" | "noRoute" | "noDemand" | null;

/**
 * Who is in a building, from the mirror (issue M3-17): the people living
 * there, its jobs filled, and why no newcomer would move in. Each is left
 * out where the caller does not know it.
 */
export interface Occupants {
  people: number;
  filled?: number;
  why?: NoNewcomers;
}

/** What the state line says a reason for an empty home is. */
const WHY: Record<"noRoute" | "noDemand", string> = {
  noRoute: "no road to an outside connection",
  noDemand: "nobody is moving to the city",
};

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function residentsOf(n: number): string {
  return n === 1 ? "1 resident" : `${count(n)} residents`;
}

/** The people line for a home: who lives there against its room, or its room alone when `people` is not known. */
function homeLine(b: BuildingInfo, people: number | undefined): string {
  const room = b.residents;
  // An abandoned home offers no room (M3-24), though its lot holds it.
  if (b.abandoned) return "no room offered";
  if (people === undefined) return residentsOf(room);
  return people === 0 ? `nobody living here, room for ${count(room)}` : `${residentsOf(people)}, room for ${count(room)}`;
}

/** The jobs line for a workplace: jobs filled against jobs offered, or the jobs alone when `filled` is not known. */
function jobsLine(b: BuildingInfo, filled: number | undefined): string {
  // An abandoned workplace offers none (M3-24), though its lot holds them.
  if (b.abandoned) return "no jobs offered";
  if (filled === undefined) return b.jobs === 1 ? "1 job" : `${count(b.jobs)} jobs`;
  return `${count(filled)} of ${count(b.jobs)} ${b.jobs === 1 ? "job" : "jobs"} filled`;
}

/**
 * The lines the readout shows for a building: its type, then zone and
 * density, lot size and who is in it, then its state when it is not
 * ordinary (issue M3-17). A home gives the people living there against its
 * room, a workplace its jobs filled against its jobs offered, and a mixed
 * building both. The state line says when it is vacant or abandoned, or a
 * home stands empty and why no newcomer would come. Without `occupants`, a
 * home says its room, as the bulldozer's tag does for several buildings.
 */
export function buildingLines(b: BuildingInfo, occupants?: Occupants): { title: string; detail: string; state: string | null } {
  const type = BUILDING_TYPES[b.type];
  const zone = ZONING_BALANCE.zones[b.zone - 1];
  const lot = `lot ${b.width} × ${b.depth} cells`;
  const home = (type?.residents[1] ?? 0) > 0;
  // A workplace by its type, so an abandoned one, which offers no jobs, still says it is one.
  const work = (type?.jobsPerCell ?? 0) > 0;
  const people = [home ? homeLine(b, occupants?.people) : null, work ? jobsLine(b, occupants?.filled) : null].filter((s) => s !== null);
  return {
    title: type?.name ?? "Building",
    detail: `${zone?.name ?? "?"} ${zone?.letter ?? "?"}${b.density} · ${lot} · ${people.length > 0 ? people.join(" · ") : "no residents"}`,
    state: stateLine(b, home, work, occupants),
  };
}

/** The state line, or null for a building in ordinary use. */
function stateLine(b: BuildingInfo, home: boolean, work: boolean, occupants: Occupants | undefined): string | null {
  if (b.abandoned) return "Abandoned";
  const why = home && occupants?.why && occupants.why !== "abandoned" ? WHY[occupants.why] : null;
  if (b.vacant) return why ? `Vacant · ${why}` : "Vacant";
  // A mixed building with people at work in it is not empty, though nobody lives there.
  if (home && occupants?.people === 0 && why && !(work && (occupants.filled ?? 0) > 0)) return `Empty · ${why}`;
  return null;
}

/** The state a building's data attribute names: `abandoned`, `vacant` or `inUse`. */
export function useName(b: BuildingInfo): "abandoned" | "vacant" | "inUse" {
  return b.abandoned ? "abandoned" : b.vacant ? "vacant" : "inUse";
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
 * type, zone and density, lot size in cells, who is in it and, when it is
 * not in ordinary use, its state (issue M3-17). When its ground is zoned
 * for something else, or zoned up, a line says so (M3-14). The bulldozer
 * shows the same (issue 116). The numbers are on data attributes too, for
 * tests.
 */
export function BuildingReadout() {
  const hover = useBuildingHover((s) => s.hover);
  if (!hover) return null;
  const b = hover.building;
  const o = hover.occupants;
  const { title, detail, state } = buildingLines(b, o);
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
      data-people={String(o.people)}
      data-jobs={String(b.jobs)}
      data-filled={String(o.filled ?? 0)}
      data-use={useName(b)}
      data-why={o.why ?? ""}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">{title}</div>
      <div className="detail">{detail}</div>
      {state && (
        <div className="state" id="building-state">
          {state}
        </div>
      )}
      {ground ? <div className="detail ground">{ground}</div> : null}
    </div>
  );
}

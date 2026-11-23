// Issue M3-17: what the building readout and the bulldozer's tag say about
// who is in a building, from its row in each state.
import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, type BuildingInfo } from "@city-council/sim";
import { buildingLines, useName } from "../src/ui/BuildingReadout";

/** A building row as the mirror gives it, of type `typeId`, in use unless `over` says otherwise. */
function row(typeId: string, over: Partial<BuildingInfo> = {}): BuildingInfo {
  const type = BUILDING_TYPES.findIndex((t) => t.id === typeId);
  const t = BUILDING_TYPES[type];
  return {
    id: 7,
    firstSeg: 0,
    firstSide: 0,
    firstPlace: 0,
    dir: 0,
    width: 2,
    depth: 4,
    backSeg: 0,
    backSide: 0,
    backPlace: 0,
    backDir: 0,
    backDepth: 0,
    zone: 1,
    density: t?.density ?? 1,
    type,
    residents: 4,
    jobs: 0,
    variant: 0,
    builtAt: 0,
    corners: null,
    chunk: 0,
    vacant: false,
    abandoned: false,
    ...over,
  };
}

/** A type of `zone` that houses people and offers jobs too, if the data has one. */
const mixed = BUILDING_TYPES.find((t) => (t.residents[1] ?? 0) > 0 && t.jobsPerCell > 0);
const shop = BUILDING_TYPES.find((t) => t.zone === "commercial" && (t.residents[1] ?? 0) === 0 && t.jobsPerCell > 0);

describe("the building readout's lines (issue M3-17)", () => {
  it("gives a lived-in home's people against its room, and no state", () => {
    const lines = buildingLines(row("single-family-home"), { people: 3, filled: 0, why: null });
    expect(lines.title).toBe("Single family home");
    expect(lines.detail).toBe("Residential R1 · lot 2 × 4 cells · 3 residents, room for 4");
    expect(lines.state).toBeNull();
  });

  it("says one resident in the singular", () => {
    expect(buildingLines(row("single-family-home"), { people: 1 }).detail).toMatch(/· 1 resident, room for 4$/);
  });

  it("says a home built and empty is empty, and why no newcomer comes", () => {
    expect(buildingLines(row("single-family-home"), { people: 0, why: "noRoute" })).toMatchObject({
      detail: "Residential R1 · lot 2 × 4 cells · nobody living here, room for 4",
      state: "Empty · no road to an outside connection",
    });
    expect(buildingLines(row("single-family-home"), { people: 0, why: "noDemand" }).state).toBe("Empty · nobody is moving to the city");
    // Empty with newcomers on their way: nothing to explain.
    expect(buildingLines(row("single-family-home"), { people: 0, why: null }).state).toBeNull();
  });

  it("says a vacant home is vacant, with the reason when there is one", () => {
    const vacant = row("single-family-home", { vacant: true });
    expect(buildingLines(vacant, { people: 0, why: null })).toMatchObject({ detail: "Residential R1 · lot 2 × 4 cells · nobody living here, room for 4", state: "Vacant" });
    expect(buildingLines(vacant, { people: 0, why: "noRoute" }).state).toBe("Vacant · no road to an outside connection");
  });

  it("says an abandoned home is abandoned, whatever reason the mirror gives", () => {
    const lines = buildingLines(row("single-family-home", { abandoned: true }), { people: 0, why: "abandoned" });
    expect(lines.detail).toBe("Residential R1 · lot 2 × 4 cells · no room offered");
    expect(lines.state).toBe("Abandoned");
  });

  it("gives a workplace's jobs filled against its jobs offered", () => {
    expect(shop).toBeDefined();
    const b = row(shop?.id ?? "", { zone: 2, residents: 0, jobs: 12 });
    expect(buildingLines(b, { people: 0, filled: 5, why: null })).toMatchObject({ detail: expect.stringMatching(/^Commercial C\d · lot 2 × 4 cells · 5 of 12 jobs filled$/), state: null });
    expect(buildingLines(row(shop?.id ?? "", { zone: 2, residents: 0, jobs: 1 }), { people: 0, filled: 0 }).detail).toMatch(/· 0 of 1 job filled$/);
    expect(buildingLines({ ...b, vacant: true }, { people: 0, filled: 0 }).state).toBe("Vacant");
  });

  it("says an abandoned workplace offers no jobs", () => {
    const b = row(shop?.id ?? "", { zone: 2, residents: 0, jobs: 0, abandoned: true });
    expect(buildingLines(b, { people: 0, filled: 0 })).toMatchObject({ detail: expect.stringMatching(/· no jobs offered$/), state: "Abandoned" });
  });

  it("gives both for a building that is a home and a workplace", () => {
    expect(mixed).toBeDefined();
    const b = row(mixed?.id ?? "", { residents: 40, jobs: 6 });
    expect(buildingLines(b, { people: 12, filled: 2 }).detail).toMatch(/· 12 residents, room for 40 · 2 of 6 jobs filled$/);
    // Nobody living there but people at work: not empty.
    expect(buildingLines(b, { people: 0, filled: 2, why: "noRoute" }).state).toBeNull();
    expect(buildingLines(b, { people: 0, filled: 0, why: "noRoute" }).state).toBe("Empty · no road to an outside connection");
  });

  it("gives a home's room alone, and a workplace's jobs, where who is in it is not known", () => {
    expect(buildingLines(row("single-family-home")).detail).toMatch(/· 4 residents$/);
    expect(buildingLines(row(shop?.id ?? "", { zone: 2, residents: 0, jobs: 12 })).detail).toMatch(/· 12 jobs$/);
  });

  it("names the state for the data attribute", () => {
    expect(useName(row("single-family-home"))).toBe("inUse");
    expect(useName(row("single-family-home", { vacant: true }))).toBe("vacant");
    expect(useName(row("single-family-home", { abandoned: true }))).toBe("abandoned");
  });
});

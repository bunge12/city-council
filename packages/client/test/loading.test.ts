import { describe, expect, it } from "vitest";
import { DERIVED_STAGES } from "@city-council/sim";
import { LOAD_STAGES, LoadingProgress, progressAt } from "../src/ui/loading";

// The loading screen while a saved city opens (issue #327).
describe("the loading screen's stages", () => {
  it("run the save, every stage prepareDerived names in its order, then the page's own", () => {
    expect(LOAD_STAGES.map((s) => s.stage)).toEqual(["reading", ...DERIVED_STAGES, "map", "view"]);
  });

  it("start the bar at 0 and move it forward, short of the end", () => {
    const starts = LOAD_STAGES.map((s) => progressAt(s.stage));
    expect(starts[0]).toBe(0);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1] ?? 1);
    expect(starts[starts.length - 1]).toBeLessThan(1);
  });
});

describe("LoadingProgress", () => {
  const clock = () => {
    let t = 0;
    return () => (t += 10);
  };

  it("stays down until something puts it up, and advance alone does not", () => {
    const p = new LoadingProgress(clock());
    expect(p.advance("cells")).toBe(false);
    expect(p.visible).toBe(false);
    expect(p.shown).toBeNull();
    expect(p.show("reading")).toBe(true);
    expect(p.shown).toEqual({ stage: "reading", label: "Reading the save", progress: 0 });
  });

  it("moves only forward, so a stage that comes late at a seam changes nothing", () => {
    const p = new LoadingProgress(clock());
    p.show("reading");
    expect(p.advance("travel")).toBe(true);
    expect(p.advance("cells")).toBe(false);
    expect(p.show("reading")).toBe(false);
    expect(p.shown?.stage).toBe("travel");
    expect(p.times).toEqual([
      { stage: "reading", at: 10 },
      { stage: "travel", at: 20 },
    ]);
  });

  it("comes down for good, and says whether it was up", () => {
    const p = new LoadingProgress(clock());
    p.show("reading");
    p.advance("view");
    expect(p.done()).toBe(true);
    expect(p.visible).toBe(false);
    expect(p.doneAt).toBe(30);
    expect(p.show("reading")).toBe(false);
    expect(p.done()).toBe(false);
  });

  it("a page that never put it up takes nothing down", () => {
    const p = new LoadingProgress(clock());
    expect(p.done()).toBe(false);
    expect(p.doneAt).toBeNull();
    expect(p.show("reading")).toBe(false);
  });
});

import type { BulldozePreview } from "../tools/bulldoze-tool";
import { buildingLines } from "./BuildingReadout";
import { formatClears, formatMoneyShort } from "./format";
import { useBulldozeHover } from "./store";

/** Gap between the tag and the point it stands over, CSS pixels. */
const GAP = 14;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n.toLocaleString("en-US")} ${many}`;
}

/** What the tag's first line says the click removes. */
export function bulldozeTitle(p: BulldozePreview): string {
  const n = p.ids.length;
  if (p.kind === "road") {
    // Part of one road (issue 86): say so, since the mark alone is easy to read as the whole road.
    const part = p.road?.sections.some((s) => s[0] > 0 || s[1] < 1) ?? false;
    if (n === 1) return part ? "Bulldoze this stretch of road" : "Bulldoze this road";
    return `Bulldoze ${plural(n, "road", "road segments")}`;
  }
  if (n === 1 && p.building) return buildingLines(p.building, p.residents).title;
  return `Bulldoze ${plural(n, "building", "buildings")}`;
}

/**
 * The bulldozer's price tag (issue 116), above whatever the pointer picked:
 * what a click removes, what it costs, and for a building that it cannot be
 * undone. A road lists the buildings that go with it. The price comes from
 * the target's plan, never from arithmetic here. The numbers are on data
 * attributes too, for tests.
 */
export function BulldozeTag() {
  const hover = useBulldozeHover((s) => s.hover);
  if (!hover) return null;
  const p = hover.preview;
  const clears = p.kind === "road" ? formatClears({ ids: [...p.buildings], residents: p.residents }, "Takes") : null;
  // A building's residents are the people living there, whom a click displaces (M3-12).
  const one = p.kind === "building" && p.ids.length === 1 && p.building ? buildingLines(p.building, p.residents) : null;
  const residents = p.kind === "building" && !one && p.residents > 0 ? `, ${plural(p.residents, "resident", "residents")}` : "";
  return (
    <div
      className={p.ok ? "road-readout bulldoze-tag" : "road-readout bulldoze-tag refused"}
      id="bulldoze-tag"
      role="status"
      data-kind={p.kind}
      data-ok={String(p.ok)}
      data-fixed={String(p.fixed)}
      data-ids={p.ids.join(",")}
      data-cost={String(p.cost)}
      data-buildings={String(p.buildings.length)}
      data-residents={String(p.residents)}
      data-undoable={String(p.undoable)}
      style={{ left: hover.x, top: hover.y - GAP }}
    >
      <div className="what">
        {bulldozeTitle(p)}
        {residents}
      </div>
      {one && <div className="detail">{one.detail}</div>}
      {p.ok && (
        <div className="price">
          {p.kind === "road" ? `${p.length.toFixed(0)} m · ` : ""}
          <span id="bulldoze-cost">{formatMoneyShort(p.cost)}</span>
        </div>
      )}
      {clears && (
        <div className="clears" id="bulldoze-clears">
          {clears}
        </div>
      )}
      {p.ok && !p.undoable && (
        <div className="no-undo" id="bulldoze-no-undo">
          Can&apos;t be undone
        </div>
      )}
      {!p.ok && (
        <div className="reason" id="bulldoze-reason">
          {p.reason}
        </div>
      )}
    </div>
  );
}

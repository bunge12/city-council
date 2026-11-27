import type { BulldozePreview } from "../tools/bulldoze-tool";
import { buildingLines, useName } from "./BuildingReadout";
import { formatClears, formatMoneyShort } from "./format";
import { bulldozeLines, type PriceLine } from "./price-lines";
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
  if (n === 1 && p.building) return buildingLines(p.building, { people: p.residents }).title;
  return `Bulldoze ${plural(n, "building", "buildings")}`;
}

/**
 * The bulldozer's price tag (issue 116), above whatever the pointer picked:
 * what a click removes, what it costs, and for a building that it cannot be
 * undone. A road lists the buildings that go with it. The price comes from
 * the target's plan, never from arithmetic here, part by part, then the
 * total (M4-16, price-lines.ts). When the treasury cannot pay, the price
 * stays, in the warning colour, with the sim's reason. The numbers are on
 * data attributes too, for tests.
 */
export function BulldozeTag() {
  const hover = useBulldozeHover((s) => s.hover);
  if (!hover) return null;
  const p = hover.preview;
  const clears = p.kind === "road" ? formatClears({ ids: [...p.buildings], residents: p.residents }, "Takes") : null;
  // A building's residents are the people living there, whom a click displaces (M3-12).
  const one = p.kind === "building" && p.ids.length === 1 && p.building ? buildingLines(p.building, { people: p.residents }) : null;
  const residents = p.kind === "building" && !one && p.residents > 0 ? `, ${plural(p.residents, "resident", "residents")}` : "";
  const lines = bulldozeLines(p);
  const reason = p.ok ? p.refusal : p.reason;
  return (
    <div
      className={reason === null ? "road-readout bulldoze-tag" : "road-readout bulldoze-tag refused"}
      id="bulldoze-tag"
      role="status"
      data-kind={p.kind}
      data-ok={String(p.ok)}
      data-fixed={String(p.fixed)}
      data-ids={p.ids.join(",")}
      data-cost={String(p.cost)}
      data-refusal={p.refusal ?? ""}
      data-value={String(p.compensation.value)}
      data-relocation={String(p.compensation.relocation)}
      data-premium={String(p.compensation.premium)}
      data-demolition={String(p.compensation.demolition)}
      data-road-demolition={String(p.demolition)}
      data-refund={String(p.refund)}
      data-split={String(p.split)}
      data-buildings={String(p.buildings.length)}
      data-residents={String(p.residents)}
      data-undoable={String(p.undoable)}
      data-use={p.kind === "building" && p.ids.length === 1 && p.building ? useName(p.building) : ""}
      style={{ left: hover.x, top: hover.y - GAP }}
    >
      <div className="what">
        {bulldozeTitle(p)}
        {residents}
      </div>
      {one && <div className="detail">{one.detail}</div>}
      {/* An abandoned or vacant building says so (issue M3-17). */}
      {one?.state && (
        <div className="state" id="bulldoze-state">
          {one.state}
        </div>
      )}
      {p.ok && lines.length > 0 && (
        <table className="price-lines" id="bulldoze-lines">
          <tbody>
            {lines.map((line, i) => (
              <PriceRow key={line.id} line={line} last={i === lines.length - 1} />
            ))}
          </tbody>
        </table>
      )}
      {clears && (
        <div className="clears" id="bulldoze-clears">
          {clears}
        </div>
      )}
      {/* Each part is charged its own plan, and pops the first part moves can land in the next (M4-09). */}
      {p.ok && p.split && (
        <div className="split" id="bulldoze-split">
          Sent in {p.commands.length} parts · the total can change as people move
        </div>
      )}
      {p.ok && !p.undoable && (
        <div className="no-undo" id="bulldoze-no-undo">
          Can&apos;t be undone
        </div>
      )}
      {reason !== null && (
        <div className="reason" id="bulldoze-reason">
          {reason}
        </div>
      )}
    </div>
  );
}

/** One line of the price: its label and amount. The last is the price charged, the total when there are parts. */
function PriceRow({ line, last }: { line: PriceLine; last: boolean }) {
  const amount = line.minus && line.amount > 0 ? `-${formatMoneyShort(line.amount)}` : formatMoneyShort(line.amount);
  return (
    <tr className={last ? `price line-${line.id}` : `line-${line.id}`} data-line={line.id} data-amount={String(line.amount)}>
      <th scope="row">{line.label}</th>
      <td>{last ? <span id="bulldoze-cost">{amount}</span> : amount}</td>
    </tr>
  );
}

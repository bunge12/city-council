import { SNAP } from "../tools/config";
import { formatMoneyShort } from "./format";
import { useRoadHover } from "./store";

/** A length in whole cells when it is one, otherwise to a tenth. */
export function formatCells(metres: number): string {
  const cells = Math.round((metres / SNAP.cellSize) * 10) / 10;
  const text = Number.isInteger(cells) ? String(cells) : cells.toFixed(1);
  return cells === 1 ? "1 cell" : `${text} cells`;
}

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

/**
 * Next to the cursor while a road is being drawn: its type, length in metres
 * and in cells, cost, how much of it is bridge, and angle to the road it
 * starts from, or the reason the sim would refuse it. The numbers are also on data attributes, in metres,
 * whole dollars and degrees, for tests.
 */
export function RoadReadout() {
  const hover = useRoadHover((s) => s.hover);
  if (!hover?.preview) return null;
  const { preview, snap } = hover;
  const length = `${preview.length.toFixed(0)} m`;
  const angle = snap?.angle ?? null;
  return (
    <div
      className={preview.ok ? "road-readout" : "road-readout refused"}
      id="road-readout"
      role="status"
      data-ok={String(preview.ok)}
      data-length={String(preview.length)}
      data-cost={String(preview.cost)}
      data-bridge={String(preview.bridgeLength)}
      data-type={preview.type.id}
      data-cells={String(preview.length / SNAP.cellSize)}
      data-angle={angle === null ? "" : String(angle)}
      data-snap={snap?.kind ?? "none"}
      data-square={String(snap?.square ?? false)}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">
        {preview.type.name}, {length} · <span id="road-cells">{formatCells(preview.length)}</span>
        {preview.ok && <> · <span id="road-cost">{formatMoneyShort(preview.cost)}</span></>}
      </div>
      {angle !== null && (
        <div className="angle" id="road-angle">
          {Math.round(angle)}° to the road{snap?.square ? ", square" : ""}
        </div>
      )}
      {preview.ok && preview.bridgeLength > 0 && (
        <div className="bridge" id="road-bridge">
          {preview.bridges.length === 1 ? "Bridge" : `${preview.bridges.length} bridges`}, {preview.bridgeLength.toFixed(0)} m
        </div>
      )}
      {preview.ok && preview.junctions.length > 0 && (
        <div className="junctions">
          {preview.junctions.length === 1 ? "1 junction" : `${preview.junctions.length} junctions`}
        </div>
      )}
      {!preview.ok && <div className="reason" id="road-reason">{preview.reason}</div>}
    </div>
  );
}

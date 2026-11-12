import { formatMoneyShort } from "./format";
import { useRoadHover } from "./store";

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

/**
 * Next to the cursor while a road is being drawn: its type, length and cost,
 * or the reason the sim would refuse it. The length and cost are also on
 * data attributes, in metres and whole dollars, for tests.
 */
export function RoadReadout() {
  const hover = useRoadHover((s) => s.hover);
  if (!hover?.preview) return null;
  const { preview } = hover;
  const length = `${preview.length.toFixed(0)} m`;
  return (
    <div
      className={preview.ok ? "road-readout" : "road-readout refused"}
      id="road-readout"
      role="status"
      data-ok={String(preview.ok)}
      data-length={String(preview.length)}
      data-cost={String(preview.cost)}
      data-type={preview.type.id}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">
        {preview.type.name}, {length}
        {preview.ok && <> · <span id="road-cost">{formatMoneyShort(preview.cost)}</span></>}
      </div>
      {preview.ok && preview.junctions.length > 0 && (
        <div className="junctions">
          {preview.junctions.length === 1 ? "1 junction" : `${preview.junctions.length} junctions`}
        </div>
      )}
      {!preview.ok && <div className="reason" id="road-reason">{preview.reason}</div>}
    </div>
  );
}

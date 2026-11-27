import { LANDMARKS } from "@city-council/sim";
import type { LandmarkPreview } from "../tools/landmark-tool";
import { formatMoneyShort } from "./format";
import { useLandmarkHover } from "./store";

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

/** The readout's lines for a plan: what a click places and its price, its lot and upkeep, and why it would be refused, if it would. */
export function landmarkLines(p: LandmarkPreview): { title: string; detail: string; reason: string | null } {
  const kind = LANDMARKS.find((l) => l.id === p.landmark);
  const lot = kind ? `${kind.width} × ${kind.depth} lot` : "";
  const upkeep = kind ? `Upkeep ${formatMoneyShort(kind.upkeepPerYear)} a year` : "";
  return { title: `Place ${p.name}`, detail: [lot, upkeep].filter((s) => s !== "").join(" · "), reason: p.reason ?? p.refusal };
}

/**
 * Next to the cursor while the landmark tool is over a road (M4-17): what a
 * click places and its price, its lot and its upkeep, and when the sim
 * would refuse it, or the treasury cannot pay, the price in the warning
 * colour with the reason. The figures come from `planPlaceLandmark` on the
 * copy. They are on data attributes too, for tests.
 */
export function LandmarkReadout() {
  const hover = useLandmarkHover((s) => s.hover);
  if (!hover) return null;
  const p = hover.preview;
  const { title, detail, reason } = landmarkLines(p);
  return (
    <div
      className={reason === null ? "road-readout landmark-readout" : "road-readout landmark-readout refused"}
      id="landmark-readout"
      role="status"
      data-landmark={p.landmark}
      data-ok={String(p.ok)}
      data-price={String(p.price)}
      data-refusal={p.refusal ?? ""}
      data-reason={p.reason ?? ""}
      data-cells={String(p.cells.length)}
      data-segment={String(p.payload.segment)}
      data-side={String(p.payload.side)}
      data-place={String(p.payload.place)}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">
        {title} · <span id="landmark-price">{formatMoneyShort(p.price)}</span>
      </div>
      <div className="detail">{detail}</div>
      {reason !== null && (
        <div className="reason" id="landmark-reason">
          {reason}
        </div>
      )}
    </div>
  );
}

import { LAND_VALUE_MAX, ROAD_TYPES } from "@city-council/sim";
import { landValueColour } from "../render/cell-geometry";
import { LAND_VALUE_SCALE } from "../render/config";
import { landValueLines } from "./land-value-text";
import { useLandValueHover, useUi } from "./store";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

/**
 * The land value overlay's legend (issue M3-18): its one sequential scale
 * as a bar from 0 to `LAND_VALUE_MAX`, with each stop's value under it.
 * The colours come from `LAND_VALUE_SCALE`, as the overlay's do. Shown
 * while the overlay is.
 */
export function LandValueLegend() {
  const on = useUi((s) => s.overlay === "landValue");
  if (!on) return null;
  const stops = LAND_VALUE_SCALE.stops;
  const gradient = `linear-gradient(to right, ${stops.map((s) => `${hex(s.colour)} ${(s.value / LAND_VALUE_MAX) * 100}%`).join(", ")})`;
  return (
    <section className="panel zone-legend land-value-legend" id="land-value-legend" aria-label="Land value legend">
      <h2>Land value</h2>
      <div
        className="scale"
        role="img"
        aria-label={`From ${hex(landValueColour(0))}, worth 0, to ${hex(landValueColour(LAND_VALUE_MAX))}, worth ${LAND_VALUE_MAX}`}
        style={{ background: gradient }}
      />
      <div className="ticks">
        {stops.map((s) => (
          <span key={s.value} style={{ left: `${(s.value / LAND_VALUE_MAX) * 100}%` }}>
            {s.value}
          </span>
        ))}
      </div>
      <p className="hint">Point at a cell to see what makes up its value. Ground under a building is not drawn.</p>
    </section>
  );
}

/**
 * Next to the cursor over a cell while the land value overlay is on and
 * no tool is: the cell's value and the parts it is made of. The value and
 * each part are on data attributes too, for tests.
 */
export function LandValueReadout() {
  const hover = useLandValueHover((s) => s.hover);
  if (!hover) return null;
  const v = hover.value;
  const { title, parts } = landValueLines(v, hover.roadType);
  return (
    <div
      className="road-readout land-value-readout"
      id="land-value-readout"
      role="status"
      data-value={String(v.value)}
      data-road={String(v.road)}
      data-road-type={ROAD_TYPES[hover.roadType]?.id ?? ""}
      data-water={String(v.water)}
      data-centre={String(v.centre)}
      data-pollution={String(v.pollution)}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">{title}</div>
      <div className="detail">{parts}</div>
    </div>
  );
}

import { ZONING_BALANCE } from "@city-council/sim";
import { cellColour } from "../render/cell-geometry";
import { CELLS } from "../render/config";
import { useUi } from "./store";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/**
 * The zoning overlay's legend (issue M2-06): each zone's colour at each
 * density, and the outline of a cell nobody has zoned. Shown while the
 * overlay is on. The colours come from `CELLS` in render/config.ts, the
 * same place the overlay takes them from.
 */
export function ZoneLegend() {
  const on = useUi((s) => s.zoningOverlay);
  if (!on) return null;
  return (
    <section className="panel zone-legend" id="zone-legend" aria-label="Zoning legend">
      <h2>Zoning</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Zone</th>
            {ZONING_BALANCE.densities.map((d) => (
              <th scope="col" key={d.level} title={`Density ${d.level}`}>
                {d.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ZONING_BALANCE.zones.map((zone, z) => (
            <tr key={zone.id} data-zone={zone.id}>
              <th scope="row">{zone.name}</th>
              {ZONING_BALANCE.densities.map((d) => (
                <td key={d.level}>
                  <span
                    className="swatch"
                    role="img"
                    aria-label={`${zone.name}, ${d.name.toLowerCase()} density (${zone.letter}${d.level})`}
                    title={`${zone.letter}${d.level}`}
                    style={{ background: hex(cellColour(z + 1, d.level)) }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        <span className="swatch outline" style={{ borderColor: hex(CELLS.unzoned) }} /> Not zoned. Blocked ground has no cells.
      </p>
    </section>
  );
}

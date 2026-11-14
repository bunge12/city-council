import { ZONE_CLEAR, ZONING_BALANCE } from "@city-council/sim";
import type { ZonePreview } from "../tools/zone-tool";
import { useZoneHover } from "./store";

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

function cells(n: number): string {
  return n === 1 ? "1 cell" : `${n} cells`;
}

/** The short name of a zone and density, such as "R1". */
export function zoneLabel(zone: string, density: number): string {
  const letter = ZONING_BALANCE.zones.find((z) => z.id === zone)?.letter ?? "?";
  return `${letter}${density}`;
}

/** What the readout says a click would do. */
export function zoneTitle(preview: ZonePreview): string {
  const n = preview.cells.length;
  if (preview.zone === ZONE_CLEAR) return `Clear ${cells(n)}`;
  return `Zone ${cells(n)} ${zoneLabel(preview.zone, preview.density)}`;
}

/**
 * Next to the cursor while the zone tool is over cells: how many a click
 * would change and to what, or why it would change none. The count is on a
 * data attribute too, for tests.
 */
export function ZoneReadout() {
  const hover = useZoneHover((s) => s.hover);
  if (!hover) return null;
  const { preview } = hover;
  return (
    <div
      className={preview.ok ? "road-readout zone-readout" : "road-readout zone-readout refused"}
      id="zone-readout"
      role="status"
      data-ok={String(preview.ok)}
      data-cells={String(preview.cells.length)}
      data-zone={preview.zone}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      {preview.ok ? (
        <div className="what">{zoneTitle(preview)}</div>
      ) : (
        <div className="reason" id="zone-reason">
          Nothing to change here
        </div>
      )}
    </div>
  );
}

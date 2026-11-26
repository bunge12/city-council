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
 * The readout's line about cells under buildings (#417), or null when the
 * stroke would change none: how many Shift would add, or with Shift held how
 * many it takes.
 */
export function builtNote(preview: ZonePreview): string | null {
  if (preview.built === 0) return null;
  const n = cells(preview.built);
  return preview.whole ? `Including ${n} under buildings; the buildings stay` : `Hold Shift to include ${n} under buildings`;
}

/**
 * The readout's line over mixed ground, which has no demand bar of its own
 * (issue M3-15). The grower reads each bar without its part for what is
 * already waiting (#420), so mixed can build while a bar shows 0.
 */
export const MIXED_NOTE = "Builds when residential and commercial demand are both above zero, not counting homes and jobs still filling";

/**
 * Next to the cursor while the zone tool is over cells: how many a click
 * would change and to what, or why it would change none, and over ground
 * the overlay marks, why no building fits there (issue M2-15). The count is
 * on a data attribute too, for tests.
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
      data-built={String(preview.built)}
      data-whole={String(preview.whole)}
      data-zone={preview.zone}
      data-lot-note={hover.lotNote ?? ""}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      {preview.ok ? (
        <div className="what">{zoneTitle(preview)}</div>
      ) : (
        <div className="reason" id="zone-reason">
          {preview.built > 0 ? "Only buildings here" : "Nothing to change here"}
        </div>
      )}
      {builtNote(preview) && (
        <div className="lot-note" id="zone-built-note">
          {builtNote(preview)}
        </div>
      )}
      {preview.zone === "mixed" && (
        <div className="lot-note" id="zone-mixed-note">
          {MIXED_NOTE}
        </div>
      )}
      {hover.lotNote && (
        <div className="lot-note" id="zone-lot-note">
          Nothing can grow here: {hover.lotNote}
        </div>
      )}
    </div>
  );
}

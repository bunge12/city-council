import type { EditPreview } from "../tools/edit-tool";
import { formatMoneyShort } from "./format";
import { useEditHover } from "./store";

/** Offset of the readout from the pointer, CSS pixels. */
const OFFSET = 18;

function count(n: number): string {
  return n === 1 ? "1 segment" : `${n} segments`;
}

/** What the readout's first line says the edit is. */
export function editTitle(preview: EditPreview): string {
  const n = preview.segments.length;
  if (preview.kind === "reverse") return "Reverse this one-way";
  if (preview.kind === "bulldoze") return n === 1 ? "Bulldoze this road" : `Bulldoze ${count(n)}`;
  const to = preview.type?.name.toLowerCase() ?? "?";
  return n === 1 ? `Upgrade to ${to}` : `Upgrade ${count(n)} to ${to}`;
}

/**
 * Next to the cursor while the bulldoze or upgrade tool is over a road:
 * what the click would do, its length and price, or the reason the sim
 * would refuse it. The numbers are on data attributes too, in metres and
 * whole dollars, for tests.
 */
export function EditReadout() {
  const hover = useEditHover((s) => s.hover);
  if (!hover) return null;
  const { preview } = hover;
  return (
    <div
      className={preview.ok ? "road-readout edit-readout" : "road-readout edit-readout refused"}
      id="edit-readout"
      role="status"
      data-kind={preview.kind}
      data-ok={String(preview.ok)}
      data-fixed={String(preview.fixed)}
      data-segments={preview.segments.join(",")}
      data-length={String(preview.length)}
      data-cost={String(preview.cost)}
      style={{ left: hover.x + OFFSET, top: hover.y + OFFSET }}
    >
      <div className="what">
        {editTitle(preview)}
        {preview.ok && (
          <>
            , {preview.length.toFixed(0)} m · <span id="edit-cost">{preview.cost === 0 ? "free" : formatMoneyShort(preview.cost)}</span>
          </>
        )}
      </div>
      {!preview.ok && (
        <div className="reason" id="edit-reason">
          {preview.reason}
        </div>
      )}
    </div>
  );
}

import { formatArea } from "../tools/block-overlay";
import { useBlockLabels } from "./store";

/**
 * The block overlay's area labels, each over its block on the map. The
 * block id and area in square metres are on data attributes, for tests.
 */
export function BlockLabels() {
  const labels = useBlockLabels((s) => s.labels);
  if (labels.length === 0) return null;
  return (
    <div className="block-labels" aria-label="Block areas">
      {labels.map((l) => (
        <div key={l.id} className="block-label" data-block={String(l.id)} data-area={String(l.area)} style={{ left: l.x, top: l.y }}>
          {formatArea(l.area)}
        </div>
      ))}
    </div>
  );
}

import { useSim } from "./hooks";
import { OVERLAYS } from "./overlays";
import { toggleOverlay, useUi } from "./store";

/**
 * The overlays, one button each, from the list in overlays.ts (issue
 * M3-18), in the top left corner under the top bar (issue #332). Zoning
 * comes with the zone tool, so it has no button. An overlay's legend opens
 * under this bar.
 */
export function OverlayBar() {
  const ready = useSim((s) => s !== null);
  const overlay = useUi((s) => s.overlay);
  return (
    <div className="panel overlay-bar" id="overlay-bar" role="group" aria-label="Overlays">
      {OVERLAYS.map((o) => (
        <button
          key={o.id}
          type="button"
          id={`overlay-${o.id}`}
          aria-pressed={overlay === o.id}
          disabled={!ready}
          title={o.title}
          onClick={() => toggleOverlay(o.id)}
        >
          {o.label} <kbd>{o.key}</kbd>
        </button>
      ))}
    </div>
  );
}

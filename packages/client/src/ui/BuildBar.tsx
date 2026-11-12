import { ROAD_TYPES } from "@city-council/sim";
import { FREE_HAND_KEY_LABEL, GUIDES } from "../tools/config";
import { TOOL_ROAD_TYPES } from "../tools/road-tool";
import { useServices, useSim } from "./hooks";
import { useUi } from "./store";

const TYPE_KEYS: Record<string, string> = { street: "Z", avenue: "X", oneWay: "C" };

function typeName(id: string): string {
  return ROAD_TYPES.find((t) => t.id === id)?.name ?? id;
}

/** The build toolbar: the road tool and its road type picker. */
export function BuildBar() {
  const { roadTool } = useServices();
  const ready = useSim((s) => s !== null);
  const tool = useUi((s) => s.tool);
  const roadType = useUi((s) => s.roadType);
  const drawing = useUi((s) => s.roadStart !== null);
  const pending = useUi((s) => s.roadPending.length);
  const note = useUi((s) => s.roadNote);
  const guides = useUi((s) => s.guides);
  const active = tool === "road";

  let hint = "Pick the road tool to draw roads.";
  if (active) {
    hint = drawing ? "Click to end the road. Esc or right-click drops it." : "Click on the map to start a road.";
    hint += ` Hold ${FREE_HAND_KEY_LABEL} to draw free-hand.`;
  }

  return (
    <section className="panel build-bar" id="build-bar" aria-label="Build">
      <div className="controls">
        <div className="tools" role="group" aria-label="Tools">
          <button
            type="button"
            id="road-tool"
            aria-pressed={active}
            disabled={!ready}
            title="Road tool (B)"
            onClick={() => roadTool.toggle()}
          >
            Road <kbd>B</kbd>
          </button>
        </div>
        <div className="road-types" role="group" aria-label="Road type">
          {TOOL_ROAD_TYPES.map((id) => (
            <button
              key={id}
              type="button"
              id={`road-type-${id}`}
              aria-pressed={active && roadType === id}
              disabled={!ready}
              title={`${typeName(id)} (${TYPE_KEYS[id] ?? ""})`}
              onClick={() => roadTool.pickType(id)}
            >
              {typeName(id)} <kbd>{TYPE_KEYS[id]}</kbd>
            </button>
          ))}
        </div>
        <div className="guides" role="group" aria-label="Guides">
          <span className="group-label">Snap</span>
          {GUIDES.map((g) => (
            <button
              key={g.id}
              type="button"
              id={`guide-${g.id}`}
              aria-pressed={guides[g.id]}
              title={g.title}
              onClick={() => roadTool.toggleGuide(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>
      <p className="hint" id="road-hint">
        {hint}
        {pending > 0 && <span id="road-pending"> Building {pending === 1 ? "1 road" : `${pending} roads`}…</span>}
      </p>
      {note && (
        <p className="road-note" id="road-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

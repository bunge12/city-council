import { ROAD_TYPES } from "@city-council/sim";
import { FREE_HAND_KEY_LABEL, GUIDES } from "../tools/config";
import { DRAW_MODES, TOOL_ROAD_TYPES, type DrawMode } from "../tools/road-tool";
import { useServices, useSim } from "./hooks";
import { useUi } from "./store";

const TYPE_KEYS: Record<string, string> = { street: "Z", avenue: "X", oneWay: "C" };

const MODES: Record<DrawMode, { label: string; key: string; title: string }> = {
  straight: { label: "Straight", key: "T", title: "Straight: click the start, then the end" },
  curved: { label: "Curved", key: "Y", title: "Curved: click the start, a point that sets the direction, then the end" },
  continuous: { label: "Continuous", key: "U", title: "Continuous: each click ends one segment and starts the next" },
};

/** What the hint says while the road tool is on. */
function toolHint(mode: DrawMode, drawing: boolean, curving: boolean): string {
  if (!drawing) return "Click on the map to start a road.";
  if (mode === "curved") {
    return curving
      ? "Click to end the curve. Esc or right-click drops it."
      : "Click to set the direction the curve leaves in. Esc or right-click drops it.";
  }
  if (mode === "continuous") return "Click to end this segment and start the next. Double-click, Esc or right-click to stop.";
  return "Click to end the road. Esc or right-click drops it.";
}

function typeName(id: string): string {
  return ROAD_TYPES.find((t) => t.id === id)?.name ?? id;
}

/** The build toolbar: the road tool and its road type picker. */
export function BuildBar() {
  const { roadTool } = useServices();
  const ready = useSim((s) => s !== null);
  const tool = useUi((s) => s.tool);
  const roadType = useUi((s) => s.roadType);
  const roadMode = useUi((s) => s.roadMode);
  const drawing = useUi((s) => s.roadStart !== null);
  const curving = useUi((s) => s.roadControl !== null);
  const pending = useUi((s) => s.roadPending.length);
  const note = useUi((s) => s.roadNote);
  const guides = useUi((s) => s.guides);
  const active = tool === "road";

  let hint = "Pick the road tool to draw roads.";
  if (active) {
    hint = toolHint(roadMode, drawing, curving);
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
        <div className="draw-modes" role="group" aria-label="Drawing mode">
          {DRAW_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              id={`draw-mode-${mode}`}
              aria-pressed={active && roadMode === mode}
              disabled={!ready}
              title={`${MODES[mode].title} (${MODES[mode].key})`}
              onClick={() => roadTool.pickMode(mode)}
            >
              {MODES[mode].label} <kbd>{MODES[mode].key}</kbd>
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

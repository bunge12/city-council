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

/** What the hint says while the bulldoze or upgrade tool is on. */
function editHint(tool: "bulldoze" | "upgrade", dragging: boolean, type: string): string {
  if (dragging) return "Release to apply to every road marked. Esc drops the drag.";
  const drag = "Drag across roads to take several at once. Shift-drag orbits.";
  if (tool === "bulldoze") return `Click a road to bulldoze it. ${drag}`;
  return `Click a road to upgrade it to ${type.toLowerCase()}. Right-click a one-way to reverse it. ${drag}`;
}

function typeName(id: string): string {
  return ROAD_TYPES.find((t) => t.id === id)?.name ?? id;
}

/** The build toolbar: the road, upgrade and bulldoze tools and the road type picker. */
export function BuildBar() {
  const { roadTool, editTool, undo, mirror } = useServices();
  const ready = useSim((s) => s !== null);
  const canUndo = useSim((s) => s?.undo.some((r) => r.playerId === mirror.playerId) ?? false);
  const undoNote = useUi((s) => s.undoNote);
  const tool = useUi((s) => s.tool);
  const roadType = useUi((s) => s.roadType);
  const roadMode = useUi((s) => s.roadMode);
  const drawing = useUi((s) => s.roadStart !== null);
  const curving = useUi((s) => s.roadControl !== null);
  const pending = useUi((s) => s.roadPending.length);
  const note = useUi((s) => s.roadNote);
  const guides = useUi((s) => s.guides);
  const dragging = useUi((s) => s.editDrag !== null);
  const editPending = useUi((s) => s.editPending.length);
  const editNote = useUi((s) => s.editNote);
  const active = tool === "road";
  const editing = tool === "bulldoze" || tool === "upgrade";

  let hint = "Pick the road tool to draw roads.";
  if (active) {
    hint = toolHint(roadMode, drawing, curving);
    hint += ` Hold ${FREE_HAND_KEY_LABEL} to draw free-hand.`;
  } else if (editing) {
    hint = editHint(tool, dragging, typeName(roadType));
  }
  const shownNote = editing ? editNote : note;

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
          <button
            type="button"
            id="upgrade-tool"
            aria-pressed={tool === "upgrade"}
            disabled={!ready}
            title="Upgrade tool (V): change a road to the type picked"
            onClick={() => editTool.toggle("upgrade")}
          >
            Upgrade <kbd>V</kbd>
          </button>
          <button
            type="button"
            id="bulldoze-tool"
            aria-pressed={tool === "bulldoze"}
            disabled={!ready}
            title="Bulldoze tool (N): remove roads"
            onClick={() => editTool.toggle("bulldoze")}
          >
            Bulldoze <kbd>N</kbd>
          </button>
          <button
            type="button"
            id="undo"
            disabled={!ready || !canUndo}
            title={canUndo ? "Undo your last road change (Ctrl+Z or Cmd+Z)" : "Nothing to undo"}
            onClick={() => void undo()}
          >
            Undo <kbd>Ctrl Z</kbd>
          </button>
        </div>
        <div className="road-types" role="group" aria-label="Road type">
          {TOOL_ROAD_TYPES.map((id) => (
            <button
              key={id}
              type="button"
              id={`road-type-${id}`}
              aria-pressed={(active || tool === "upgrade") && roadType === id}
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
        {editPending > 0 && <span id="edit-pending"> Applying {editPending === 1 ? "1 change" : `${editPending} changes`}…</span>}
      </p>
      {undoNote && (
        <p className="road-note" id="undo-note" role="status">
          {undoNote}
        </p>
      )}
      {shownNote && (
        <p className="road-note" id="road-note" role="status">
          {shownNote}
        </p>
      )}
    </section>
  );
}

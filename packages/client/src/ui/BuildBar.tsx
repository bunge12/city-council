import type { ReactNode } from "react";
import { ROAD_TYPES } from "@city-council/sim";
import { FREE_HAND_KEY_LABEL, GUIDES } from "../tools/config";
import { DRAW_MODES, TOOL_ROAD_TYPES, type DrawMode } from "../tools/road-tool";
import { GridPanel, gridHint } from "./GridPanel";
import { useServices, useSim } from "./hooks";
import { toggleZoningOverlay, useUi } from "./store";

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

/** One labelled row of buttons in a tool menu. */
function MenuGroup({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className={`menu-group ${id}`} role="group" aria-label={label}>
      <span className="group-label">{label}</span>
      <div className="menu-buttons">{children}</div>
    </div>
  );
}

/**
 * The build dock along the bottom edge. Its road button opens the road menu
 * above it, and the menu is hidden while no road tool is on, so the dock
 * stays short (issue 47). Bulldoze and upgrade are actions in the menu, and
 * the grid is a build mode beside straight, curved and continuous.
 */
export function BuildBar() {
  const { roadTool, gridTool, editTool } = useServices();
  const ready = useSim((s) => s !== null);
  const undoNote = useUi((s) => s.undoNote);
  const tool = useUi((s) => s.tool);
  const zoning = useUi((s) => s.zoningOverlay);
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
  const gridDrawn = useUi((s) => s.gridOrigin !== null);
  const gridDragging = useUi((s) => s.gridDragging);
  const gridOnRoad = useUi((s) => s.gridOnRoad);
  const gridPending = useUi((s) => s.gridPending.length);
  const gridNote = useUi((s) => s.gridNote);
  const active = tool === "road";
  const gridding = tool === "grid";
  const editing = tool === "bulldoze" || tool === "upgrade";
  const roadMenu = active || editing || gridding;

  let hint = "Pick the road tool to draw roads.";
  if (active) {
    hint = toolHint(roadMode, drawing, curving);
    hint += ` Hold ${FREE_HAND_KEY_LABEL} to draw free-hand.`;
  } else if (gridding) {
    hint = gridHint(gridDrawn, gridDragging, gridOnRoad);
  } else if (editing) {
    hint = editHint(tool, dragging, typeName(roadType));
  }
  const shownNote = editing ? editNote : gridding ? gridNote : note;

  // An action or the grid that is on goes back to drawing roads rather than closing the menu.
  const action = (id: "upgrade" | "bulldoze") => {
    editTool.toggle(id);
    if (tool === id) roadTool.toggle();
  };
  const grid = () => {
    gridTool.toggle();
    if (gridding) roadTool.toggle();
  };

  const roadTypes = (
    <MenuGroup label="Road type" id="road-types">
      {TOOL_ROAD_TYPES.map((id) => (
        <button
          key={id}
          type="button"
          id={`road-type-${id}`}
          aria-pressed={roadType === id}
          disabled={!ready}
          title={`${typeName(id)} (${TYPE_KEYS[id] ?? ""})`}
          onClick={() => roadTool.pickType(id)}
        >
          {typeName(id)} <kbd>{TYPE_KEYS[id]}</kbd>
        </button>
      ))}
    </MenuGroup>
  );

  return (
    <section className="panel build-bar" id="build-bar" aria-label="Build">
      <div className="dock" role="group" aria-label="Tools">
        <div className="dock-slot">
          {roadMenu && (
            <div className="panel tool-menu" id="road-menu" aria-label="Road tool options">
              <MenuGroup label="Actions" id="actions">
                <button
                  type="button"
                  id="upgrade-tool"
                  aria-pressed={tool === "upgrade"}
                  disabled={!ready}
                  title="Upgrade (V): change a road to the type picked"
                  onClick={() => action("upgrade")}
                >
                  Upgrade <kbd>V</kbd>
                </button>
                <button
                  type="button"
                  id="bulldoze-tool"
                  aria-pressed={tool === "bulldoze"}
                  disabled={!ready}
                  title="Bulldoze (N): remove roads"
                  onClick={() => action("bulldoze")}
                >
                  Bulldoze <kbd>N</kbd>
                </button>
              </MenuGroup>
              {tool !== "bulldoze" && roadTypes}
              {(active || gridding) && (
                <MenuGroup label="Build mode" id="draw-modes">
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
                  <button
                    type="button"
                    id="grid-tool"
                    aria-pressed={gridding}
                    disabled={!ready}
                    title="Grid (G): drag out a rectangle to lay a street grid"
                    onClick={grid}
                  >
                    Grid <kbd>G</kbd>
                  </button>
                </MenuGroup>
              )}
              {gridding && <GridPanel />}
              {active && (
                <MenuGroup label="Snapping" id="guides">
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
                </MenuGroup>
              )}
            </div>
          )}
          <button
            type="button"
            id="road-tool"
            aria-pressed={active}
            aria-expanded={roadMenu}
            aria-controls={roadMenu ? "road-menu" : undefined}
            disabled={!ready}
            title="Road tool (B)"
            onClick={() => roadTool.toggle()}
          >
            Road <kbd>B</kbd>
          </button>
        </div>
        <div className="dock-slot">
          <button
            type="button"
            id="zoning-overlay"
            aria-pressed={zoning}
            disabled={!ready}
            title="Zoning overlay (O): show the cells along every street and what each is zoned for"
            onClick={toggleZoningOverlay}
          >
            Zoning <kbd>O</kbd>
          </button>
        </div>
      </div>
      <p className="hint" id="road-hint">
        {hint}
        {pending > 0 && <span id="road-pending"> Building {pending === 1 ? "1 road" : `${pending} roads`}…</span>}
        {gridPending > 0 && <span id="grid-pending"> Building {gridPending === 1 ? "1 grid" : `${gridPending} grids`}…</span>}
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

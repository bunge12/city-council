import { useEffect, type ReactNode } from "react";
import { DENSITY_UNLOCKS, LANDMARKS, ROAD_TYPES, ZONING_BALANCE, type Unlock } from "@city-council/sim";
import { GUIDES } from "../tools/config";
import { BULLDOZE_TARGETS } from "../tools/bulldoze-tool";
import { DRAW_MODES, TOOL_ROAD_TYPES, type DrawMode } from "../tools/road-tool";
import { ZONE_DEPTHS, ZONE_MODES, type ZoneMode } from "../tools/zone-tool";
import { GridPanel } from "./GridPanel";
import { useLockNote, useServices, useSim } from "./hooks";
import { UnlockButton } from "./UnlockButton";
import { useUi } from "./store";

const TYPE_KEYS: Record<string, string> = {
  street: "Z",
  avenue: "X",
  oneWay: "C",
};

const MODES: Record<DrawMode, { label: string; key: string; title: string }> = {
  straight: {
    label: "Straight",
    key: "T",
    title: "Straight: click the start, then the end",
  },
  curved: {
    label: "Curved",
    key: "Y",
    title:
      "Curved: click the start, a point that sets the direction, then the end",
  },
  continuous: {
    label: "Continuous",
    key: "U",
    title: "Continuous: each click ends one segment and starts the next",
  },
};

/**
 * Where a road being drawn has got to, on the road menu for tests: the
 * menu no longer explains each step in words (issue #332), since the
 * buttons' tooltips say how each mode draws.
 */
function roadStep(mode: DrawMode, drawing: boolean, curving: boolean): string {
  if (!drawing) return "start";
  if (mode === "curved") return curving ? "end" : "direction";
  return mode === "continuous" ? "next" : "end";
}

const ZONE_MODE_LABELS: Record<ZoneMode, { label: string; title: string }> = {
  fill: {
    label: "Fill",
    title:
      "Fill: hover a road and click to zone the strip on that side, as deep as the depth picked",
  },
  brush: {
    label: "Brush",
    title: "Brush: click or drag over cells to zone the ones under the pointer",
  },
};

function typeName(id: string): string {
  return ROAD_TYPES.find((t) => t.id === id)?.name ?? id;
}

/** One labelled row of buttons in a tool menu. */
function MenuGroup({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
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
 * stays short (issue 47). Upgrade is an action in the menu, and the grid is
 * a build mode beside straight, curved and continuous. The bulldozer has its
 * own button beside the road's, with its filters in a menu above it (issue
 * 116). A tool's menu is centred over the dock (issue #332). Undo has no
 * button: it is Ctrl+Z or Cmd+Z.
 */
export function BuildBar() {
  const { roadTool, gridTool, editTool, bulldozeTool, zoneTool, landmarkTool } =
    useServices();
  const ready = useSim((s) => s !== null);
  const undoNote = useUi((s) => s.undoNote);
  const tool = useUi((s) => s.tool);
  const roadType = useUi((s) => s.roadType);
  const roadMode = useUi((s) => s.roadMode);
  const drawing = useUi((s) => s.roadStart !== null);
  const curving = useUi((s) => s.roadControl !== null);
  const pending = useUi((s) => s.roadPending.length);
  const note = useUi((s) => s.roadNote);
  const guides = useUi((s) => s.guides);
  const editPending = useUi((s) => s.editPending.length);
  const editNote = useUi((s) => s.editNote);
  const gridPending = useUi((s) => s.gridPending.length);
  const gridNote = useUi((s) => s.gridNote);
  const zonePick = useUi((s) => s.zonePick);
  const zoneDensity = useUi((s) => s.zoneDensity);
  const zoneErase = useUi((s) => s.zoneErase);
  const zoneMode = useUi((s) => s.zoneMode);
  const zoneDepth = useUi((s) => s.zoneDepth);
  const zonePending = useUi((s) => s.zonePending.length);
  const zoneNote = useUi((s) => s.zoneNote);
  const bulldozePending = useUi((s) => s.bulldozePending.length);
  const bulldozeNote = useUi((s) => s.bulldozeNote);
  const filters = useUi((s) => s.bulldozeFilters);
  const landmarkPick = useUi((s) => s.landmarkPick);
  const landmarkNote = useUi((s) => s.landmarkNote);
  const landmarkPending = useUi((s) => s.landmarkPending.length);
  const landmark = LANDMARKS.find((l) => l.id === landmarkPick);
  const placing = tool === "landmark";
  const zoning = tool === "zone";
  // A density the city has not opened yet cannot stay picked: a new or loaded city goes back to density 1 (M4-12).
  const pickedLocked = useLockNote(DENSITY_UNLOCKS[zoneDensity]) !== null;
  useEffect(() => {
    if (pickedLocked) zoneTool.dropLockedDensity();
  }, [pickedLocked, zoneTool]);
  const bulldozing = tool === "bulldoze";
  const active = tool === "road";
  const gridding = tool === "grid";
  const editing = tool === "upgrade";
  const roadMenu = active || editing || gridding;

  const anyPending =
    pending + gridPending + bulldozePending + editPending + zonePending + landmarkPending > 0;
  const shownNote = placing
    ? landmarkNote
    : editing
    ? editNote
    : bulldozing
      ? bulldozeNote
      : gridding
        ? gridNote
        : zoning
          ? zoneNote
          : note;

  // An action or the grid that is on goes back to drawing roads rather than closing the menu.
  const upgrade = () => {
    editTool.toggle("upgrade");
    if (tool === "upgrade") roadTool.toggle();
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
            <div
              className="panel tool-menu"
              id="road-menu"
              aria-label="Road tool options"
              data-step={active ? roadStep(roadMode, drawing, curving) : undefined}
            >
              <MenuGroup label="Actions" id="actions">
                <button
                  type="button"
                  id="upgrade-tool"
                  aria-pressed={tool === "upgrade"}
                  disabled={!ready}
                  title="Upgrade (V): click a road to change it to the type picked. Shift takes the whole road, a drag takes several, and a right-click reverses a one-way."
                  onClick={upgrade}
                >
                  Upgrade <kbd>V</kbd>
                </button>
              </MenuGroup>
              {roadTypes}
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
                    title="Grid (G): drag along one side of the grid, move to set how far it reaches, click, then Confirm or press Enter. Alt draws the side free-hand."
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
            title="Road tool (R): click to start a road and again to end it. Alt draws free-hand. Esc or a right-click drops it."
            onClick={() => roadTool.toggle()}
          >
            Road <kbd>R</kbd>
          </button>
        </div>
        <div className="dock-slot">
          {bulldozing && (
            <div
              className="panel tool-menu"
              id="bulldoze-menu"
              aria-label="Bulldozer options"
            >
              <MenuGroup label="Removes" id="bulldoze-filters">
                {BULLDOZE_TARGETS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    id={`bulldoze-filter-${t.id}`}
                    aria-pressed={filters[t.id]}
                    title={`${t.label}: ${filters[t.id] ? "the pointer picks them" : "the pointer passes over them"}`}
                    onClick={() => bulldozeTool.toggleFilter(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </MenuGroup>
            </div>
          )}
          <button
            type="button"
            id="bulldoze-tool"
            aria-pressed={bulldozing}
            aria-expanded={bulldozing}
            aria-controls={bulldozing ? "bulldoze-menu" : undefined}
            disabled={!ready}
            title="Bulldozer (B): click to remove what is under the pointer. Shift takes the whole road, and a drag takes every thing of the kind it starts on."
            onClick={() => bulldozeTool.toggle()}
          >
            Bulldoze <kbd>B</kbd>
          </button>
        </div>
        <div className="dock-slot">
          {zoning && (
            <div
              className="panel tool-menu"
              id="zone-menu"
              aria-label="Zone tool options"
            >
              <MenuGroup label="Zone" id="zone-picks">
                {ZONING_BALANCE.zones.map((z) => (
                  <button
                    key={z.id}
                    type="button"
                    id={`zone-${z.id}`}
                    aria-pressed={!zoneErase && zonePick === z.id}
                    title={z.name}
                    onClick={() => zoneTool.pickZone(z.id)}
                  >
                    {z.name}
                  </button>
                ))}
                <button
                  type="button"
                  id="zone-erase"
                  aria-pressed={zoneErase}
                  title="Erase: clear the zoning from cells"
                  onClick={() => zoneTool.toggleErase()}
                >
                  Erase
                </button>
              </MenuGroup>
              {!zoneErase && (
                <MenuGroup label="Density" id="zone-densities">
                  {ZONING_BALANCE.densities.map((d) => (
                    <UnlockButton
                      key={d.level}
                      unlock={DENSITY_UNLOCKS[d.level]}
                      id={`zone-density-${d.level}`}
                      aria-pressed={zoneDensity === d.level}
                      title={`${d.name} density`}
                      onClick={() => zoneTool.pickDensity(d.level)}
                    >
                      {d.level} {d.name}
                    </UnlockButton>
                  ))}
                </MenuGroup>
              )}
              <MenuGroup label="Paint" id="zone-modes">
                {ZONE_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    id={`zone-mode-${mode}`}
                    aria-pressed={zoneMode === mode}
                    title={ZONE_MODE_LABELS[mode].title}
                    onClick={() => zoneTool.pickMode(mode)}
                  >
                    {ZONE_MODE_LABELS[mode].label}
                  </button>
                ))}
              </MenuGroup>
              {zoneMode === "fill" && (
                <MenuGroup label="Depth" id="zone-depths">
                  {ZONE_DEPTHS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      id={`zone-depth-${d}`}
                      aria-pressed={zoneDepth === d}
                      title={`Fill ${d === 1 ? "1 cell" : `${d} cells`} back from the road ([ and ] step it)`}
                      onClick={() => zoneTool.setDepth(d)}
                    >
                      {d}
                    </button>
                  ))}
                </MenuGroup>
              )}
            </div>
          )}
          <button
            type="button"
            id="zone-tool"
            aria-pressed={zoning}
            aria-expanded={zoning}
            aria-controls={zoning ? "zone-menu" : undefined}
            disabled={!ready}
            title="Zone (K): show the cells along every street and what each is zoned for, and paint zones on them"
            onClick={() => zoneTool.toggle()}
          >
            Zone <kbd>K</kbd>
          </button>
        </div>
        <div className="dock-slot">
          {/* Greyed with the population that opens it until the milestone does (M4-12, M4-16). */}
          <UnlockButton
            unlock={landmark?.unlock as Unlock | undefined}
            id="landmark-tool"
            aria-pressed={placing}
            disabled={!ready}
            title={`${landmark?.name ?? "Landmark"} (H): point at a road to see the lot, its price and its upkeep, and click to build it on the side the pointer is`}
            onClick={() => landmarkTool.toggle()}
          >
            {landmark?.name ?? "Landmark"} <kbd>H</kbd>
          </UnlockButton>
        </div>
      </div>
      {anyPending && (
        <p className="hint" id="build-pending" role="status">
          {pending > 0 && (
            <span id="road-pending">
              {" "}
              Building {pending === 1 ? "1 road" : `${pending} roads`}…
            </span>
          )}
          {gridPending > 0 && (
            <span id="grid-pending">
              {" "}
              Building {gridPending === 1 ? "1 grid" : `${gridPending} grids`}…
            </span>
          )}
          {bulldozePending > 0 && (
            <span id="bulldoze-pending">
              {" "}
              Removing{" "}
              {bulldozePending === 1 ? "1 thing" : `${bulldozePending} things`}…
            </span>
          )}
          {editPending > 0 && (
            <span id="edit-pending">
              {" "}
              Applying{" "}
              {editPending === 1 ? "1 change" : `${editPending} changes`}…
            </span>
          )}
          {landmarkPending > 0 && (
            <span id="landmark-pending">
              {" "}
              Building {landmark?.name ?? "the landmark"}…
            </span>
          )}
          {zonePending > 0 && (
            <span id="zone-pending">
              {" "}
              Zoning {zonePending === 1 ? "1 stroke" : `${zonePending} strokes`}
              …
            </span>
          )}
        </p>
      )}
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

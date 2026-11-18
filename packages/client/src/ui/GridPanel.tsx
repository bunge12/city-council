import { useState } from "react";
import { GRID_TOOL } from "../tools/config";
import type { GridStage } from "../tools/grid-tool";
import { formatClears, formatMoneyShort } from "./format";
import { useServices, useSim } from "./hooks";
import { useUi } from "./store";

/** What the hint says while the grid tool is on. */
export function gridHint(stage: GridStage | null): string {
  if (stage === "side") return "Release to set the grid's first side. It snaps to the roads and zoning around it; hold Alt to draw free-hand.";
  if (stage === "depth") return "Move to set how far the grid reaches, then click or press Enter. Esc or right-click drops it.";
  if (stage === "placed") return "Confirm or press Enter to build the grid. Esc or right-click drops it.";
  return "Drag along one side of the grid, then move to set how far it reaches.";
}

/**
 * A block size in whole cells. What is typed stays as typed, so the field
 * can be cleared and retyped; each whole number in range is taken as it is
 * typed, and leaving the field shows the size in use. Enter builds the grid,
 * since the field keeps focus through a drag on the map, and Escape
 * does what it does on the map.
 */
function CellsField(props: { id: string; label: string; value: number; onCommit(cells: number): void; onEnter(): void; onEscape(): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label>
      {props.label}
      <input
        id={props.id}
        type="number"
        min={GRID_TOOL.minBlockCells}
        max={GRID_TOOL.maxBlockCells}
        step={1}
        value={draft ?? String(props.value)}
        onChange={(e) => {
          const text = e.currentTarget.value;
          setDraft(text);
          const cells = Number(text);
          if (text !== "" && Number.isInteger(cells) && cells >= GRID_TOOL.minBlockCells && cells <= GRID_TOOL.maxBlockCells) props.onCommit(cells);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          // Enter and Escape hand focus back to the map, so the keys work as they do there.
          if (e.key !== "Enter" && e.key !== "Escape") return;
          e.preventDefault();
          setDraft(null);
          e.currentTarget.blur();
          if (e.key === "Enter") props.onEnter();
          else props.onEscape();
        }}
      />
      cells
    </label>
  );
}

/**
 * The grid tool's part of the build bar: the block size in cells, and once
 * a rectangle is drawn, what the sim would build, the buildings it would
 * clear once it is placed (issue M2-15), and the Confirm button.
 * The numbers are also on data attributes, for tests.
 */
export function GridPanel() {
  const { gridTool } = useServices();
  const depth = useUi((s) => s.gridDepthCells);
  const width = useUi((s) => s.gridWidthCells);
  const stage = useUi((s) => s.gridStage);
  // Read for their changes: the preview below depends on them.
  useUi((s) => s.gridOrigin);
  useUi((s) => s.gridSideEnd);
  useUi((s) => s.gridReach);
  useUi((s) => s.roadType);
  useSim((s) => s?.tick ?? -1);
  const preview = gridTool.preview();

  const junctions = preview?.junctions.length ?? 0;
  const cuts = preview?.cuts.length ?? 0;
  const clears = formatClears(preview?.clears);
  return (
    <div className="grid-panel" id="grid-panel">
      <CellsField id="grid-depth" label="Depth" value={depth} onCommit={(v) => gridTool.setBlock("depth", v)} onEnter={() => gridTool.confirm()} onEscape={() => gridTool.escape()} />
      <CellsField id="grid-width" label="Width" value={width} onCommit={(v) => gridTool.setBlock("width", v)} onEnter={() => gridTool.confirm()} onEscape={() => gridTool.escape()} />
      {preview && (
        <span
          className={preview.ok ? "grid-summary" : "grid-summary refused"}
          id="grid-summary"
          role="status"
          data-ok={String(preview.ok)}
          data-streets={String(preview.streets.length)}
          data-length={String(preview.length)}
          data-cost={String(preview.cost)}
          data-junctions={String(junctions)}
          data-cuts={String(cuts)}
          data-clears={preview.clears ? String(preview.clears.ids.length) : ""}
          data-residents={preview.clears ? String(preview.clears.residents) : ""}
        >
          {preview.ok ? (
            <>
              {preview.streets.length === 1 ? "1 street" : `${preview.streets.length} streets`}, {preview.length.toFixed(0)} m ·{" "}
              <span id="grid-cost">{formatMoneyShort(preview.cost)}</span>
              {junctions > 0 && <> · {junctions === 1 ? "1 junction" : `${junctions} junctions`}</>}
              {cuts > 0 && <> · {cuts === 1 ? "1 street end cut" : `${cuts} street ends cut`} by water or slope</>}
              {clears !== null && (
                <>
                  {" "}
                  · <span id="grid-clears">{clears}</span>
                </>
              )}
            </>
          ) : (
            <span id="grid-reason">{preview.reason}</span>
          )}
        </span>
      )}
      {preview && stage === "placed" && (
        <>
          <button type="button" id="grid-confirm" disabled={!preview.ok} title="Build the grid (Enter)" onClick={() => gridTool.confirm()}>
            Confirm <kbd>Enter</kbd>
          </button>
          <button type="button" id="grid-drop" title="Drop the rectangle (Esc)" onClick={() => gridTool.cancel()}>
            Drop
          </button>
        </>
      )}
    </div>
  );
}

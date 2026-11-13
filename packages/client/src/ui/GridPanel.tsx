import { useState } from "react";
import { GRID_TOOL } from "../tools/config";
import { formatMoneyShort } from "./format";
import { useServices, useSim } from "./hooks";
import { useUi } from "./store";

/** What the hint says while the grid tool is on. */
export function gridHint(drawn: boolean, dragging: boolean, onRoad: boolean): string {
  if (dragging) {
    return onRoad
      ? "Release to set the rectangle. It keeps the angle of the road it started on."
      : "Release to set the rectangle. Hold Alt to turn it.";
  }
  if (drawn) return "Confirm or press Enter to build the grid. Esc or right-click drops it.";
  return "Drag out a rectangle. Start on a road to take its angle.";
}

/**
 * A block size in whole cells. What is typed stays as typed, so the field
 * can be cleared and retyped; each whole number in range is taken as it is
 * typed, and leaving the field shows the size in use. Enter builds the grid,
 * since the field keeps focus through a drag on the map.
 */
function CellsField(props: { id: string; label: string; value: number; onCommit(cells: number): void; onEnter(): void }) {
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
          if (e.key !== "Enter") return;
          e.preventDefault();
          setDraft(null);
          props.onEnter();
        }}
      />
      cells
    </label>
  );
}

/**
 * The grid tool's part of the build bar: the block size in cells, and once
 * a rectangle is drawn, what the sim would build and the Confirm button.
 * The numbers are also on data attributes, for tests.
 */
export function GridPanel() {
  const { gridTool } = useServices();
  const depth = useUi((s) => s.gridDepthCells);
  const width = useUi((s) => s.gridWidthCells);
  const dragging = useUi((s) => s.gridDragging);
  // Read for their changes: the preview below depends on them.
  useUi((s) => s.gridOrigin);
  useUi((s) => s.gridCorner);
  useUi((s) => s.gridDir);
  useUi((s) => s.roadType);
  useSim((s) => s?.tick ?? -1);
  const preview = gridTool.preview();

  const junctions = preview?.junctions.length ?? 0;
  const cuts = preview?.cuts.length ?? 0;
  return (
    <div className="grid-panel" id="grid-panel">
      <CellsField id="grid-depth" label="Depth" value={depth} onCommit={(v) => gridTool.setBlock("depth", v)} onEnter={() => gridTool.confirm()} />
      <CellsField id="grid-width" label="Width" value={width} onCommit={(v) => gridTool.setBlock("width", v)} onEnter={() => gridTool.confirm()} />
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
        >
          {preview.ok ? (
            <>
              {preview.streets.length === 1 ? "1 street" : `${preview.streets.length} streets`}, {preview.length.toFixed(0)} m ·{" "}
              <span id="grid-cost">{formatMoneyShort(preview.cost)}</span>
              {junctions > 0 && <> · {junctions === 1 ? "1 junction" : `${junctions} junctions`}</>}
              {cuts > 0 && <> · {cuts === 1 ? "1 street end cut" : `${cuts} street ends cut`} by water or slope</>}
            </>
          ) : (
            <span id="grid-reason">{preview.reason}</span>
          )}
        </span>
      )}
      {preview && !dragging && (
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

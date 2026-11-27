import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Speed } from "@city-council/sim";
import { ActivityLog } from "./ActivityLog";
import { BlockLabels } from "./BlockLabels";
import { BuildBar } from "./BuildBar";
import { CityMenu } from "./CityMenu";
import { DebugPanel } from "./DebugPanel";
import { BulldozeTag } from "./BulldozeTag";
import { BuildingReadout } from "./BuildingReadout";
import { EditReadout } from "./EditReadout";
import { ServicesContext, useServices, useSim } from "./hooks";
import { MilestoneNotice } from "./MilestoneNotice";
import { Notes } from "./Notes";
import { RoadReadout } from "./RoadReadout";
import type { AppServices } from "./services";
import { shortcutFor, toggledSpeed } from "./shortcuts";
import { LandValueLegend, LandValueReadout } from "./LandValue";
import { BudgetLegend, BudgetReadout } from "./Budget";
import { BudgetPanel } from "./BudgetPanel";
import { StatsPanel } from "./StatsPanel";
import { OverlayBar } from "./OverlayBar";
import { closeOverlay, setPanel, toggleBudget, toggleDebug, toggleLog, toggleOverlay, toggleStats, useUi } from "./store";
import { CityStatus, GameClock, SettingsMenu, TopBar } from "./TopBar";
import { PANEL_ELEMENTS, escapeTarget, type PanelId } from "./windows";
import { ZoneLegend } from "./ZoneLegend";
import { ZoneReadout } from "./ZoneReadout";
import { LandmarkReadout } from "./LandmarkReadout";
import "./ui.css";

/**
 * After Escape closes panel `id`, focus that was inside it goes back to the
 * button that opened it, where that button still shows, or leaves the page's
 * controls, so the next key still reaches the map.
 */
function refocus(id: PanelId): void {
  const panel = document.getElementById(PANEL_ELEMENTS[id]);
  const focused = document.activeElement;
  if (!panel || !(focused instanceof HTMLElement) || !panel.contains(focused)) return;
  const opener = document.querySelector<HTMLElement>(`[aria-controls="${panel.id}"]`);
  if (opener && !opener.closest("[hidden]")) opener.focus();
  else focused.blur();
}

/** Turns key presses into shortcut actions. Speed keys send `SetSpeed`, like the buttons. */
function useShortcuts(): void {
  const { sendCommand, roadTool, gridTool, editTool, bulldozeTool, routeTool, zoneTool, landmarkTool, undo } = useServices();
  const speed = useSim((s) => s?.speed ?? null);
  const lastRunning = useRef<Speed>(1);
  const current = useRef<Speed | null>(null);
  current.current = speed;
  if (speed !== null && speed !== 0) lastRunning.current = speed;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A field that answers Escape itself, as the grid's sizes do, has the last word.
      if (e.code === "Escape" && e.defaultPrevented) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const action = shortcutFor({
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        repeat: e.repeat,
        targetTag: target?.tagName ?? "",
        targetEditable: target?.isContentEditable ?? false,
      });
      if (!action) return;
      e.preventDefault();
      switch (action.kind) {
        case "speed":
          void sendCommand("SetSpeed", { speed: action.speed });
          return;
        case "togglePause":
          if (current.current !== null) {
            void sendCommand("SetSpeed", { speed: toggledSpeed(current.current, lastRunning.current) });
          }
          return;
        case "toggleDebug":
          toggleDebug();
          return;
        case "toggleLog":
          toggleLog();
          return;
        case "toggleStats":
          toggleStats();
          return;
        case "toggleBudget":
          toggleBudget();
          return;
        case "roadTool":
          roadTool.toggle();
          return;
        case "gridTool":
          gridTool.toggle();
          return;
        case "confirm":
          gridTool.confirm();
          return;
        case "bulldozeTool":
          bulldozeTool.toggle();
          return;
        case "upgradeTool":
          editTool.toggle("upgrade");
          return;
        case "zoneTool":
          zoneTool.toggle();
          return;
        case "landmarkTool":
          landmarkTool.toggle();
          return;
        case "overlay":
          toggleOverlay(action.id);
          return;
        case "zoneDepth":
          if (zoneTool.active()) zoneTool.stepDepth(action.by);
          return;
        case "roadType":
          roadTool.pickType(action.type);
          return;
        case "drawMode":
          roadTool.pickMode(action.mode);
          return;
        case "escape": {
          // The window opened last closes first: a panel, an overlay, or the tool on top with what it holds (issue #332).
          const top = escapeTarget(useUi.getState().windows);
          if (top === "overlay") {
            closeOverlay();
            return;
          }
          if (top !== null && top !== "tool") {
            setPanel(top, false);
            refocus(top);
            return;
          }
          if (!routeTool.escape() && !editTool.escape() && !bulldozeTool.escape() && !gridTool.escape() && !zoneTool.escape() && !landmarkTool.escape()) roadTool.escape();
          return;
        }
        case "undo":
          void undo();
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sendCommand, roadTool, gridTool, editTool, bulldozeTool, routeTool, zoneTool, landmarkTool, undo]);
}

function Shell() {
  useShortcuts();
  return (
    <>
      {/* First, so the panels sit over the labels. */}
      <BlockLabels />
      <TopBar />
      {/* Top left: the overlays, their legends, then notes to the player (issue #332). */}
      <div className="left-column">
        <OverlayBar />
        <ZoneLegend />
        <LandValueLegend />
        <BudgetLegend />
        <Notes />
      </div>
      {/* Top right: settings and statistics, and the panels they open, under their buttons. */}
      <div className="right-column">
        <SettingsMenu />
        <CityMenu />
        <StatsPanel />
        <BudgetPanel />
        <DebugPanel />
        <ActivityLog />
      </div>
      <CityStatus />
      <BuildBar />
      <GameClock />
      <MilestoneNotice />
      <RoadReadout />
      <EditReadout />
      <BulldozeTag />
      <ZoneReadout />
      <LandmarkReadout />
      <BuildingReadout />
      <LandValueReadout />
      <BudgetReadout />
    </>
  );
}

/** Mounts the UI shell over the canvas. */
export function mountUi(root: HTMLElement, services: AppServices): void {
  createRoot(root).render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <Shell />
      </ServicesContext.Provider>
    </StrictMode>,
  );
}

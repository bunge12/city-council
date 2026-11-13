import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Speed } from "@city-council/sim";
import { ActivityLog } from "./ActivityLog";
import { BuildBar } from "./BuildBar";
import { CityMenu } from "./CityMenu";
import { DebugPanel } from "./DebugPanel";
import { EditReadout } from "./EditReadout";
import { ServicesContext, useServices, useSim } from "./hooks";
import { Notes } from "./Notes";
import { RoadReadout } from "./RoadReadout";
import type { AppServices } from "./services";
import { shortcutFor, toggledSpeed } from "./shortcuts";
import { toggleDebug, toggleLog } from "./store";
import { TopBar } from "./TopBar";
import "./ui.css";

/** Turns key presses into shortcut actions. Speed keys send `SetSpeed`, like the buttons. */
function useShortcuts(): void {
  const { sendCommand, roadTool, editTool } = useServices();
  const speed = useSim((s) => s?.speed ?? null);
  const lastRunning = useRef<Speed>(1);
  const current = useRef<Speed | null>(null);
  current.current = speed;
  if (speed !== null && speed !== 0) lastRunning.current = speed;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const action = shortcutFor({
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
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
        case "roadTool":
          roadTool.toggle();
          return;
        case "bulldozeTool":
          editTool.toggle("bulldoze");
          return;
        case "upgradeTool":
          editTool.toggle("upgrade");
          return;
        case "roadType":
          roadTool.pickType(action.type);
          return;
        case "drawMode":
          roadTool.pickMode(action.mode);
          return;
        case "escape":
          if (!editTool.escape()) roadTool.escape();
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sendCommand, roadTool, editTool]);
}

function Shell() {
  useShortcuts();
  return (
    <>
      <TopBar />
      <div className="left-column">
        <Notes />
        <CityMenu />
      </div>
      <div className="right-column">
        <DebugPanel />
        <ActivityLog />
      </div>
      <BuildBar />
      <RoadReadout />
      <EditReadout />
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

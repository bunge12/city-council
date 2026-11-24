// The loading screen's DOM (issue #327). Plain elements, not React: the
// page shows a stage and then blocks its main thread on the next, so the
// stage must be in the document before the browser paints, which a React
// render scheduled for later would miss.

import { LoadingProgress, type LoadStage, type LoadStageTime } from "./loading";

export interface LoadingScreen {
  /** True while the screen is up. */
  readonly visible: boolean;
  /** Puts the screen up at `stage`, or moves it on. Never moves back, and never comes back once down. */
  show(stage: LoadStage): void;
  /** Moves the screen on to `stage` while it is up. */
  advance(stage: LoadStage): void;
  /** Takes the screen down for good. */
  done(): void;
  /** When each stage began and when the screen came down, by `performance.now()`, for tests. */
  report(): { stages: LoadStageTime[]; doneAt: number | null };
}

/** A loading screen that puts itself in `parent` when it goes up. */
export function createLoadingScreen(parent: HTMLElement, now: () => number = () => performance.now()): LoadingScreen {
  const progress = new LoadingProgress(now);
  let root: HTMLElement | null = null;
  let fill: HTMLElement | null = null;
  let track: HTMLElement | null = null;
  let step: HTMLElement | null = null;

  const build = (): void => {
    root = document.createElement("div");
    root.className = "loading";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "loading-title");
    const card = document.createElement("div");
    card.className = "loading-card";
    const title = document.createElement("h1");
    title.id = "loading-title";
    title.textContent = "Opening the city";
    track = document.createElement("div");
    track.className = "loading-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-labelledby", "loading-title");
    fill = document.createElement("div");
    fill.className = "loading-fill";
    track.append(fill);
    step = document.createElement("p");
    step.className = "loading-step";
    card.append(title, track, step);
    root.append(card);
    parent.append(root);
  };

  const render = (): void => {
    const shown = progress.shown;
    if (!shown) return;
    if (!root) build();
    const percent = Math.round(shown.progress * 100);
    if (fill) fill.style.transform = `scaleX(${shown.progress})`;
    track?.setAttribute("aria-valuenow", String(percent));
    track?.setAttribute("aria-valuetext", shown.label);
    if (step) step.textContent = `${shown.label}…`;
    document.body.dataset["loadingStage"] = shown.stage;
    const seen = document.body.dataset["loadingStages"];
    document.body.dataset["loadingStages"] = seen ? `${seen},${shown.stage}` : shown.stage;
  };

  return {
    get visible() {
      return progress.visible;
    },
    show(stage) {
      if (progress.show(stage)) render();
    },
    advance(stage) {
      if (progress.advance(stage)) render();
    },
    done() {
      if (!progress.done()) return;
      root?.remove();
      root = fill = track = step = null;
      document.body.dataset["loadingStage"] = "";
    },
    report: () => ({ stages: [...progress.times], doneAt: progress.doneAt }),
  };
}

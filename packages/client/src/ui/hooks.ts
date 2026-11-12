// How components reach the page's services and the sim's state.

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { SimMirror } from "../protocol/mirror";
import type { SaveStatus } from "../save/channel";
import type { AppServices } from "./services";

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices needs a ServicesContext provider");
  return services;
}

/** The mirror's state: deeply read-only, or null before the first snapshot. */
export type MirrorState = SimMirror["state"];

/**
 * Reads sim state from the mirror and re-renders when the value changes.
 * `selector` must return a primitive or a value that is stable between
 * updates, such as a number or string; the mirror changes its copy in place,
 * so an object from inside it would never look new.
 */
export function useSim<T>(selector: (state: MirrorState) => T): T {
  const { mirror } = useServices();
  const subscribe = useCallback((listener: () => void) => mirror.subscribe(listener), [mirror]);
  return useSyncExternalStore(subscribe, () => selector(mirror.state));
}

/** The latest save status from the worker, or null before the city loads. */
export function useSaveStatus(): SaveStatus | null {
  const { saves } = useServices();
  const subscribe = useCallback((listener: () => void) => saves.subscribe(listener), [saves]);
  return useSyncExternalStore(subscribe, () => saves.status);
}

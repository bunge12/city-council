// Web Worker entry. Opens the saved city, hosts it, drives it from the
// worker's clock and saves it on an interval and when the page asks. City
// file downloads and imports go through the saver too.
import { AUTOSAVE_INTERVAL_MS } from "../save/config";
import { SAVES_CHANNEL, isSaveMessage, parseLoadFile, type FromSaver, type LoadFileMessage } from "../save/channel";
import { newCityFallback, openLatestCity, openLoadedFile, type OpenedCity } from "../save/load";
import { cityFromWorkerName, claimCity, loadsFileFromWorkerName } from "../save/lock";
import { Saver } from "../save/saver";
import { CityStore } from "../save/store";
import { serveClock, isClockMessage, type FromClock } from "./clock";
import { PUMP_INTERVAL_MS, SimHost } from "./host";
import { LOCAL_PLAYER_ID } from "./player";
import { bufferUntilListening, isSimMessage, portTransport, type MessagePortLike } from "./transport";

const port = self as unknown as MessagePortLike;
// The page asks for a snapshot as soon as it starts, before the save has
// loaded. Hold its messages until the host and saver are listening.
const simTransport = bufferUntilListening(portTransport(port, isSimMessage));
const saveTransport = bufferUntilListening(portTransport<FromSaver, unknown>(port, isSaveMessage));
// A test can hold the clock before the city has loaded, so it holds from the first step.
const clockTransport = bufferUntilListening(portTransport<FromClock, unknown>(port, isClockMessage));

/**
 * The city file the page fetched from its `?load=` address, when the page
 * named this worker to wait for one. Listened for before anything else, so
 * it cannot arrive unheard.
 */
const loadFile: Promise<LoadFileMessage> | null = loadsFileFromWorkerName(self.name)
  ? new Promise((resolve) => {
      const listener = (event: MessageEvent): void => {
        const file = parseLoadFile(event.data);
        if (!file) return;
        port.removeEventListener("message", listener);
        resolve(file);
      };
      port.addEventListener("message", listener);
    })
  : null;

async function start(): Promise<void> {
  let store: CityStore | null = null;
  let storeError: string | undefined;
  let city: OpenedCity;
  const opening = (seed: number): void => saveTransport.send({ channel: SAVES_CHANNEL, type: "opening", seed, requestId: null });
  try {
    store = await CityStore.open();
    city = loadFile
      ? await openLoadedFile(store, await loadFile, Date.now(), undefined, cityFromWorkerName(self.name), opening)
      : await openLatestCity(store, undefined, cityFromWorkerName(self.name), opening);
  } catch (error) {
    storeError = `saved cities could not be opened (${error instanceof Error ? error.message : String(error)})`;
    city = newCityFallback(`Saved cities could not be opened, so a new city was started. ${storeError}.`, undefined, opening);
  }

  // One tab per city: without the lock this worker hosts nothing, and the
  // page offers a different city. The sim transport then stays unanswered.
  const mine = await claimCity(city.id, navigator.locks);
  const host = mine ? new SimHost(city.state, simTransport, () => performance.now(), city.pagedLog, LOCAL_PLAYER_ID) : null;
  const saver = new Saver({
    store,
    ...(storeError === undefined ? {} : { storeError }),
    host,
    elsewhere: { seed: city.state.seed, tick: city.state.tick },
    transport: saveTransport,
    city: { id: city.id, name: city.name },
    logPagesStored: city.logPagesStored,
    loadedFrom: city.from,
    problem: city.problem,
    wallClock: () => Date.now(),
  });
  // Before the pump starts, so a hold sent as the page started is in place for the first step.
  serveClock(host, clockTransport);
  if (host) {
    setInterval(() => host.pump(), PUMP_INTERVAL_MS);
    setInterval(() => void saver.save("autosave"), AUTOSAVE_INTERVAL_MS);
  }
  await saver.start();
}

void start();

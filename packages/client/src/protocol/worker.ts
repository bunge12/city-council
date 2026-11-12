// Web Worker entry. Opens the saved city, hosts it, drives it from the
// worker's clock and saves it on an interval and when the page asks. City
// file downloads and imports go through the saver too.
import { AUTOSAVE_INTERVAL_MS } from "../save/config";
import { isSaveMessage } from "../save/channel";
import { newCityFallback, openLatestCity, type OpenedCity } from "../save/load";
import { Saver } from "../save/saver";
import { CityStore } from "../save/store";
import { PUMP_INTERVAL_MS, SimHost } from "./host";
import { LOCAL_PLAYER_ID } from "./player";
import { bufferUntilListening, portTransport, type MessagePortLike } from "./transport";

const port = self as unknown as MessagePortLike;
// The page asks for a snapshot as soon as it starts, before the save has
// loaded. Hold its messages until the host and saver are listening.
const simTransport = bufferUntilListening(portTransport(port, (data) => !isSaveMessage(data)));
const saveTransport = bufferUntilListening(portTransport(port, isSaveMessage));

async function start(): Promise<void> {
  let store: CityStore | null = null;
  let storeError: string | undefined;
  let city: OpenedCity;
  try {
    store = await CityStore.open();
    city = await openLatestCity(store);
  } catch (error) {
    storeError = `saved cities could not be opened (${error instanceof Error ? error.message : String(error)})`;
    city = newCityFallback(`Saved cities could not be opened, so a new city was started. ${storeError}.`);
  }

  const host = new SimHost(city.state, simTransport, () => performance.now(), city.pagedLog, LOCAL_PLAYER_ID);
  const saver = new Saver({
    store,
    ...(storeError === undefined ? {} : { storeError }),
    host,
    transport: saveTransport,
    city: { id: city.id, name: city.name },
    logPagesStored: city.logPagesStored,
    loadedFrom: city.from,
    problem: city.problem,
    wallClock: () => Date.now(),
  });
  setInterval(() => host.pump(), PUMP_INTERVAL_MS);
  setInterval(() => void saver.save("autosave"), AUTOSAVE_INTERVAL_MS);
  await saver.start();
}

void start();

// Web Worker entry. Hosts one city and drives it from the worker's clock.
import { createState } from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "./host";
import { portTransport, type MessagePortLike } from "./transport";

/** Seed for the city the worker starts with until saves land (issue 08). */
const DEFAULT_SEED = 1;

const port = self as unknown as MessagePortLike;
const host = new SimHost(createState(DEFAULT_SEED), portTransport(port), () => performance.now());
setInterval(() => host.pump(), PUMP_INTERVAL_MS);

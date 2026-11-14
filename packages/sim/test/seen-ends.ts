// Test helper for issue 94. BulldozeRoad and UpgradeRoad carry where each
// segment's ends were and its road type when the sender picked it, and the
// sim refuses the command when they have changed. Most tests are about
// something else, so these helpers fill `ends` and `types` in from the
// network as it is at the moment the command is sent, as the client does.
import { submit as submitRaw, segmentEnds, segmentTypeId, type Command, type CommandResult, type RoadNetwork, type SimState } from "../src/index";

const EDITS = new Set(["BulldozeRoad", "UpgradeRoad"]);

/** `payload` with `ends` and `types` for its segments as `net` has them now, unless it already has them. */
export function withEnds<T>(net: RoadNetwork, payload: T): T {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const segments = record["segments"];
  if (record["ends"] !== undefined || !Array.isArray(segments)) return payload;
  const ends = segments.map((seg) => (Number.isSafeInteger(seg) ? segmentEnds(net, seg as number) : [0, 0, 0, 0]));
  const types = segments.map((seg) => (Number.isSafeInteger(seg) ? segmentTypeId(net, seg as number) : ""));
  return { ...record, ends, types } as T;
}

/** `submit`, with `ends` filled in on a bulldoze or upgrade that has none. */
export function submit(state: SimState, command: Command): CommandResult {
  if (!EDITS.has(command.type)) return submitRaw(state, command);
  return submitRaw(state, { ...command, payload: withEnds(state.roads, command.payload) });
}

// The snapshot format. One byte layout for local saves, city files and,
// later, sending a city to a player who joins.
//
// Layout, little endian:
//
//   header, 40 bytes
//     0   4  magic "CITY"
//     4   2  format version (this byte layout)
//     6   2  state version (SNAPSHOT_VERSION of the sim that wrote it)
//     8   4  seed
//     12  4  section count
//     16  8  tick, float64
//     24  4  body length in bytes
//     28  4  reserved, zero
//     32  8  FNV-1a 64 of the body, high word then low word
//   body: sections, one after another, each starting on an 8-byte boundary
//     1   name length n
//     n   name, ASCII
//     1   kind (see KINDS)
//     4   data length in bytes
//     pad to 8
//     data
//     pad to 8
//
// Every typed array in state gets its own section, named by its path
// ("rng", later "roads.x"). Everything else is JSON in the "state" section,
// with each typed array replaced by a reference to its section. Entries the
// host has read out of live state go in the "pagedLog" section. JSON is
// stored as UTF-16 code units, so every string comes back exactly, the same
// units `hashState` reads.
//
// Format version 2 allows a snapshot with no "pagedLog" section: one whose
// paged-out entries are kept somewhere else, by whoever wrote it. A local
// save is written that way, so a save does not write the whole log again
// each time. Nothing else differs, and a snapshot that carries its paged
// log is still written as version 1, which older builds read.
//
// Typed array data is written in the platform's byte order. Every engine the
// game targets is little endian, as `hashState` already assumes.

import { Fnv64 } from "./hash";
import { isLogEntry, type LogEntry } from "./log";
import { migrateState } from "./migrate";
import { RNG_WORDS } from "./rng";
import { checkConnections } from "./roads/connections";
import { checkRoadNetwork, type RoadNetwork } from "./roads/network";
import { SNAPSHOT_VERSION, SPEEDS, type SimState } from "./state";
import { checkUndoHistory, heldIds, type UndoRecord } from "./undo";

/** Newest version of the byte layout above this build reads. Bump on any change to it. */
export const SNAPSHOT_FORMAT_VERSION = 2;
/** The layout version in which the paged log is always inside the snapshot. */
const FORMAT_LOG_INSIDE = 1;

/** "CITY" in ASCII. */
const MAGIC = [0x43, 0x49, 0x54, 0x59] as const;
const HEADER_BYTES = 40;

/** Why a snapshot was refused. */
export type SnapshotErrorCode =
  /** The bytes do not start like a snapshot at all. */
  | "not-a-snapshot"
  /** Written by a newer build. Nothing is wrong with it; this build cannot read it. */
  | "newer-version"
  /** Shorter than its header says, as when a download or write was cut off. */
  | "truncated"
  /** The checksum or the contents do not hold together. */
  | "corrupt";

/** A snapshot this build cannot read, with a message fit to show a player. */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/** What the header says, readable without decoding the rest. */
export interface SnapshotHeader {
  formatVersion: number;
  stateVersion: number;
  seed: number;
  tick: number;
}

/** A decoded snapshot, migrated to the current state version. */
export interface Snapshot {
  header: SnapshotHeader;
  state: SimState;
  /**
   * Log entries that left live state, oldest first. Entry `i` has absolute
   * index `i`, so this followed by `state.log` is the whole log. Empty when
   * `logDetached` is true.
   */
  pagedLog: LogEntry[];
  /**
   * True when the snapshot was written without its paged log. The first
   * `state.logOffset` entries are then wherever the writer keeps them, and
   * the caller must supply them to have the whole log.
   */
  logDetached: boolean;
}

type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint8ClampedArray
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

interface TypedArrayClass {
  readonly BYTES_PER_ELEMENT: number;
  readonly name: string;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): TypedArray;
  new (length: number): TypedArray;
}

/** Section kinds. 0 is JSON; the rest are typed arrays, by element type. */
const KIND_JSON = 0;
const KINDS: readonly (TypedArrayClass | null)[] = [
  null,
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
];

function kindOf(array: ArrayBufferView): number {
  const kind = KINDS.findIndex((type) => type !== null && array.constructor === type);
  if (kind < 1) throw new TypeError(`serialize: ${array.constructor.name} cannot go in a snapshot`);
  return kind;
}

interface Section {
  name: string;
  kind: number;
  bytes: Uint8Array;
}

// ---- JSON with the values plain JSON loses ----
//
// A reference to something JSON cannot hold is an object with a "$" key.
// A real object that has a "$" key of its own is wrapped, so it cannot be
// mistaken for one.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function encodeJson(value: unknown, path: string, sections: Section[]): Json {
  switch (typeof value) {
    case "undefined":
      return { $: "undefined" };
    case "boolean":
    case "string":
      return value;
    case "number":
      if (Number.isNaN(value)) return { $: "NaN" };
      if (value === Infinity) return { $: "Infinity" };
      if (value === -Infinity) return { $: "-Infinity" };
      if (Object.is(value, -0)) return { $: "-0" };
      return value;
    case "object":
      break;
    default:
      throw new TypeError(`serialize: ${path} is a ${typeof value}, which state must not hold`);
  }
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item, i) => encodeJson(item, `${path}.${i}`, sections));
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const kind = kindOf(value);
    sections.push({
      name: path,
      kind,
      bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    });
    return { $: "section", name: path };
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`serialize: ${path} is not plain data (CLAUDE.md rule 7)`);
  }
  const record = value as Record<string, unknown>;
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(record)) {
    out[key] = encodeJson(record[key], path === "" ? key : `${path}.${key}`, sections);
  }
  return Object.hasOwn(record, "$") ? { $: "object", value: out } : out;
}

function corrupt(message: string): SnapshotError {
  return new SnapshotError("corrupt", `This save is damaged: ${message}.`);
}

function decodeJson(value: Json, arrays: ReadonlyMap<string, TypedArray>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decodeJson(item, arrays));
  if (!Object.hasOwn(value, "$")) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = decodeJson(value[key] ?? null, arrays);
    return out;
  }
  switch (value["$"]) {
    case "undefined":
      return undefined;
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
    case "section": {
      const name = value["name"];
      const array = typeof name === "string" ? arrays.get(name) : undefined;
      if (!array) throw corrupt(`section "${String(name)}" is missing`);
      return array;
    }
    case "object": {
      const inner = value["value"];
      if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
        throw corrupt("a wrapped object holds no object");
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(inner)) out[key] = decodeJson(inner[key] ?? null, arrays);
      return out;
    }
    default:
      throw corrupt(`unknown value tag "${String(value["$"])}"`);
  }
}

function jsonSection(name: string, value: Json): Section {
  const text = JSON.stringify(value);
  const units = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  return { name, kind: KIND_JSON, bytes: new Uint8Array(units.buffer) };
}

function readJsonSection(section: Section): Json {
  if (section.bytes.byteLength % 2 !== 0) throw corrupt(`section "${section.name}" has an odd length`);
  // Copy so the code units are aligned whatever the section's offset.
  const units = new Uint16Array(section.bytes.slice().buffer);
  let text = "";
  const CHUNK = 8192;
  for (let i = 0; i < units.length; i += CHUNK) {
    text += String.fromCharCode(...units.subarray(i, i + CHUNK));
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw corrupt(`section "${section.name}" is not valid JSON`);
  }
}

// ---- Bytes ----

function align8(n: number): number {
  return n + ((8 - (n % 8)) % 8);
}

function checksum(bytes: Uint8Array): { hi: number; lo: number } {
  const h = new Fnv64();
  for (let i = 0; i < bytes.length; i++) h.byte(bytes[i] ?? 0);
  return { hi: h.hi, lo: h.lo };
}

function isUint32(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
}

/**
 * Writes `state` as snapshot bytes. `pagedLog` is every entry that has left
 * live state, so the save keeps the whole log; it must hold exactly
 * `state.logOffset` entries. The state is only read.
 */
export function serialize(state: SimState, pagedLog: readonly LogEntry[] = []): Uint8Array {
  return write(state, pagedLog);
}

/**
 * Writes `state` as snapshot bytes without the entries that have left live
 * state. For a host that stores those itself, once each, so that the cost
 * of a save does not grow with the length of the log. Whoever reads the
 * bytes back must supply the first `state.logOffset` entries.
 */
export function serializeDetached(state: SimState): Uint8Array {
  return write(state, null);
}

function write(state: SimState, pagedLog: readonly LogEntry[] | null): Uint8Array {
  if (pagedLog !== null && pagedLog.length !== state.logOffset) {
    throw new RangeError(
      `serialize: pagedLog has ${pagedLog.length} entries but ${state.logOffset} have left live state`,
    );
  }
  if (!isUint32(state.seed)) throw new RangeError(`serialize: seed ${state.seed} is not a 32-bit integer`);
  if (!Number.isSafeInteger(state.tick) || state.tick < 0) {
    throw new RangeError(`serialize: tick ${state.tick} is not a non-negative integer`);
  }
  if (!Number.isInteger(state.version) || state.version < 1 || state.version > 0xffff) {
    throw new RangeError(`serialize: state version ${state.version} does not fit the header`);
  }

  const arrays: Section[] = [];
  const fields = encodeJson(state, "", arrays);
  const logSections = pagedLog === null ? [] : [jsonSection("pagedLog", encodeJson(pagedLog, "pagedLog", arrays))];
  const sections = [jsonSection("state", fields), ...logSections, ...arrays];

  let bodyLength = 0;
  for (const section of sections) {
    if (section.name.length > 255 || !/^[\x20-\x7e]*$/.test(section.name)) {
      throw new RangeError(`serialize: section name "${section.name}" must be up to 255 ASCII characters`);
    }
    bodyLength = align8(align8(bodyLength + 1 + section.name.length + 1 + 4) + section.bytes.byteLength);
  }
  if (bodyLength > 0xffffffff) throw new RangeError("serialize: snapshot is larger than 4 GB");

  const out = new Uint8Array(HEADER_BYTES + bodyLength);
  const view = new DataView(out.buffer);
  let at = HEADER_BYTES;
  for (const section of sections) {
    out[at++] = section.name.length;
    for (let i = 0; i < section.name.length; i++) out[at++] = section.name.charCodeAt(i);
    out[at++] = section.kind;
    view.setUint32(at, section.bytes.byteLength, true);
    at = align8(at + 4);
    out.set(section.bytes, at);
    at = align8(at + section.bytes.byteLength);
  }

  out.set(MAGIC, 0);
  // The oldest layout version that can hold this snapshot.
  view.setUint16(4, pagedLog === null ? SNAPSHOT_FORMAT_VERSION : FORMAT_LOG_INSIDE, true);
  view.setUint16(6, state.version, true);
  view.setUint32(8, state.seed, true);
  view.setUint32(12, sections.length, true);
  view.setFloat64(16, state.tick, true);
  view.setUint32(24, bodyLength, true);
  view.setUint32(28, 0, true);
  const sum = checksum(out.subarray(HEADER_BYTES));
  view.setUint32(32, sum.hi, true);
  view.setUint32(36, sum.lo, true);
  return out;
}

/**
 * Reads and checks the header and checksum without decoding the sections.
 * Throws a `SnapshotError` for anything `deserialize` would refuse at that
 * level: not a snapshot, written by a newer build, cut short, or damaged.
 */
export function readSnapshotHeader(bytes: Uint8Array): SnapshotHeader {
  if (bytes.byteLength < 6 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new SnapshotError("not-a-snapshot", "This is not a City Council save.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint16(4, true);
  // A newer layout may move everything after the version, so stop here.
  if (formatVersion > SNAPSHOT_FORMAT_VERSION) {
    throw new SnapshotError(
      "newer-version",
      `This save uses file format ${formatVersion}, made by a newer version of the game. ` +
        `This version reads up to format ${SNAPSHOT_FORMAT_VERSION}. Update the game to open it.`,
    );
  }
  if (formatVersion < 1) throw corrupt(`file format ${formatVersion} does not exist`);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new SnapshotError("truncated", "This save is cut short: its header is incomplete.");
  }
  const stateVersion = view.getUint16(6, true);
  if (stateVersion > SNAPSHOT_VERSION) {
    throw new SnapshotError(
      "newer-version",
      `This save is from a newer version of the game (save version ${stateVersion}). ` +
        `This version reads up to save version ${SNAPSHOT_VERSION}. Update the game to open it.`,
    );
  }
  if (stateVersion < 1) throw corrupt(`save version ${stateVersion} does not exist`);
  const bodyLength = view.getUint32(24, true);
  if (bytes.byteLength < HEADER_BYTES + bodyLength) {
    throw new SnapshotError(
      "truncated",
      `This save is cut short: it should be ${HEADER_BYTES + bodyLength} bytes but is ${bytes.byteLength}.`,
    );
  }
  if (bytes.byteLength > HEADER_BYTES + bodyLength) throw corrupt("it has extra bytes after the end");
  const sum = checksum(bytes.subarray(HEADER_BYTES));
  if (sum.hi !== view.getUint32(32, true) || sum.lo !== view.getUint32(36, true)) {
    throw corrupt("its checksum does not match");
  }
  return {
    formatVersion,
    stateVersion,
    seed: view.getUint32(8, true),
    tick: view.getFloat64(16, true),
  };
}

function readSections(bytes: Uint8Array): Section[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(12, true);
  const sections: Section[] = [];
  let at = HEADER_BYTES;
  for (let s = 0; s < count; s++) {
    if (at + 1 > bytes.byteLength) throw corrupt("a section runs past the end");
    const nameLength = bytes[at++] ?? 0;
    if (at + nameLength + 5 > bytes.byteLength) throw corrupt("a section runs past the end");
    let name = "";
    for (let i = 0; i < nameLength; i++) name += String.fromCharCode(bytes[at++] ?? 0);
    const kind = bytes[at++] ?? 0;
    const length = view.getUint32(at, true);
    at = align8(at + 4);
    if (at + length > bytes.byteLength) throw corrupt(`section "${name}" runs past the end`);
    if (kind >= KINDS.length) throw corrupt(`section "${name}" has unknown kind ${kind}`);
    sections.push({ name, kind, bytes: bytes.subarray(at, at + length) });
    at = align8(at + length);
  }
  return sections;
}

function toTypedArray(section: Section): TypedArray {
  const type = KINDS[section.kind];
  if (!type) throw corrupt(`section "${section.name}" is not an array`);
  if (section.bytes.byteLength % type.BYTES_PER_ELEMENT !== 0) {
    throw corrupt(`section "${section.name}" is not a whole number of ${type.name} elements`);
  }
  // A copy with its own buffer, so state owns its memory and can transfer it.
  const copy = section.bytes.slice();
  return new type(copy.buffer, 0, copy.byteLength / type.BYTES_PER_ELEMENT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkLogEntry(entry: unknown, where: string): void {
  if (!isLogEntry(entry)) throw corrupt(`${where} is not a log entry`);
}

/**
 * A queued command is applied by the first step after loading, so one that
 * is not a command would throw there, on every step, in a city that then
 * cannot run. A city file can come from anyone.
 */
function checkPendingCommand(command: unknown, where: string): void {
  if (
    !isRecord(command) ||
    !Number.isSafeInteger(command["seq"]) ||
    typeof command["playerId"] !== "string" ||
    typeof command["type"] !== "string"
  ) {
    throw corrupt(`${where} is not a command`);
  }
}

/** Checks the decoded state has the current shape, so a bad save fails here and not later in play. */
function checkState(state: Record<string, unknown>, pagedLog: unknown[] | null, header: SnapshotHeader): void {
  const { tick, seed, rng, speed, pending, log, logOffset, roads, undo, connections } = state;
  if (!Number.isSafeInteger(tick) || (tick as number) < 0) throw corrupt("its tick is not a whole number");
  if (!isUint32(seed)) throw corrupt("its seed is not a 32-bit integer");
  if (tick !== header.tick || seed !== header.seed) throw corrupt("its header does not match its contents");
  if (!(rng instanceof Uint32Array) || rng.length !== RNG_WORDS) throw corrupt("its random generator is malformed");
  if (!(SPEEDS as readonly unknown[]).includes(speed)) throw corrupt(`its speed ${String(speed)} is not a game speed`);
  if (!Array.isArray(pending) || !Array.isArray(log)) throw corrupt("its command queue or log is not a list");
  if (!Number.isSafeInteger(logOffset) || (logOffset as number) < 0) throw corrupt("its log offset is not a whole number");
  if (pagedLog !== null && logOffset !== pagedLog.length) {
    throw corrupt("its log offset does not match the entries saved with it");
  }
  pagedLog?.forEach((entry, i) => checkLogEntry(entry, `paged log entry ${i}`));
  log.forEach((entry, i) => checkLogEntry(entry, `log entry ${i}`));
  pending.forEach((command, i) => checkPendingCommand(command, `queued command ${i}`));
  const undoProblem = checkUndoHistory(undo);
  if (undoProblem !== null) throw corrupt(`its undo history is malformed: ${undoProblem}`);
  const roadProblem = checkRoadNetwork(roads, heldIds(undo as UndoRecord[]));
  if (roadProblem !== null) throw corrupt(`its road network is malformed: ${roadProblem}`);
  const connectionProblem = checkConnections(connections, roads as RoadNetwork);
  if (connectionProblem !== null) throw corrupt(`its outside connections are malformed: ${connectionProblem}`);
}

/**
 * Reads snapshot bytes back into state, migrated to the current
 * `SNAPSHOT_VERSION`. Throws a `SnapshotError` with a message fit to show a
 * player when the bytes are not a snapshot, are from a newer build, are cut
 * short or are damaged. The bytes are only read.
 */
export function deserialize(bytes: Uint8Array): Snapshot {
  const header = readSnapshotHeader(bytes);
  const sections = readSections(bytes);
  const arrays = new Map<string, TypedArray>();
  const json = new Map<string, Json>();
  for (const section of sections) {
    if (arrays.has(section.name) || json.has(section.name)) throw corrupt(`section "${section.name}" appears twice`);
    if (section.kind === KIND_JSON) json.set(section.name, readJsonSection(section));
    else arrays.set(section.name, toTypedArray(section));
  }
  const fields = json.get("state");
  const paged = json.get("pagedLog");
  // Only the newer layout may leave the paged log out.
  const logDetached = paged === undefined && header.formatVersion > FORMAT_LOG_INSIDE;
  if (fields === undefined || (paged === undefined && !logDetached)) throw corrupt("a required section is missing");
  const raw = decodeJson(fields, arrays);
  const pagedLog = paged === undefined ? null : decodeJson(paged, arrays);
  if (!isRecord(raw) || raw["version"] !== header.stateVersion) {
    throw corrupt("its state does not match its header");
  }
  if (pagedLog !== null && !Array.isArray(pagedLog)) throw corrupt("its paged log is not a list");
  let state: SimState;
  try {
    state = migrateState(raw as { version: number } & Record<string, unknown>);
  } catch (error) {
    throw corrupt(`it could not be upgraded (${error instanceof Error ? error.message : String(error)})`);
  }
  checkState(state as unknown as Record<string, unknown>, pagedLog, header);
  return { header, state, pagedLog: (pagedLog ?? []) as LogEntry[], logDetached };
}

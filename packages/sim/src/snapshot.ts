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
//     32  8  checksum of the body, high word then low word
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
// Format version 3 changes the checksum and nothing else. Versions 1 and 2
// use FNV-1a 64, which takes the body a byte at a time: 7 ms for the 3.3 MB
// of a 30,000 segment city, a third of a tick, and more as the city grows.
// Version 3 takes the body four bytes at a time (`WordChecksum`) and is
// several times faster. A snapshot without its paged log, which is what an
// autosave writes between ticks, is written as version 3. Builds from
// before it refuse such a save as one from a newer version.
//
// Typed array data is written in the platform's byte order. Every engine the
// game targets is little endian, as `hashState` already assumes.

import { checkBuildings, type BuildingState } from "./buildings/buildings";
import { checkPops } from "./pops/pops";
import { Fnv64 } from "./hash";
import { isLogEntry, type LogEntry } from "./log";
import { migrateState } from "./migrate";
import { RNG_WORDS } from "./rng";
import { checkConnections } from "./roads/connections";
import { checkRoadNetwork, type RoadNetwork } from "./roads/network";
import { SNAPSHOT_VERSION, SPEEDS, type SimState } from "./state";
import { checkUndoHistory, heldIds, type UndoRecord } from "./undo";
import { checkCells } from "./zoning/cells";

/** Newest version of the byte layout above this build reads. Bump on any change to it. */
export const SNAPSHOT_FORMAT_VERSION = 3;
/** The layout version in which the paged log is always inside the snapshot. */
const FORMAT_LOG_INSIDE = 1;
/** The first layout version whose checksum is `WordChecksum`. */
const FORMAT_WORD_CHECKSUM = 3;

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

/** Whether JSON holds `value` as it is. Checked before a path is built for it, since most values are these. */
function isPlainJson(value: unknown): value is boolean | string | number {
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  return typeof value === "string" || typeof value === "boolean";
}

/**
 * `value` as JSON can hold it, its typed arrays moved to `sections`. A part
 * of `value` that JSON holds as it is comes back as itself, not as a copy:
 * most of a state's JSON is its log and undo records, which are such parts,
 * and copying them on every save cost more than writing them. The result is
 * only read, by `JSON.stringify`.
 */
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
  if (Array.isArray(value)) {
    const items = value as unknown[];
    /** The copy, made at the first item that needs encoding. */
    let out: Json[] | null = null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isPlainJson(item)) continue;
      const encoded = encodeJson(item, `${path}.${i}`, sections);
      if (encoded === item) continue;
      out ??= items.slice() as Json[];
      out[i] = encoded;
    }
    return out ?? (items as Json[]);
  }
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
  let out: { [key: string]: Json } | null = null;
  let hasDollar = false;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (key === "$") hasDollar = true;
    const item = record[key];
    if (isPlainJson(item)) continue;
    const encoded = encodeJson(item, path === "" ? key : `${path}.${key}`, sections);
    if (encoded === item) continue;
    out ??= { ...record } as { [key: string]: Json };
    out[key] = encoded;
  }
  const fields = out ?? (record as { [key: string]: Json });
  return hasDollar ? { $: "object", value: fields } : fields;
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

/** A section still to be written: a typed array's bytes, or JSON text that goes straight into the output. */
interface Part {
  name: string;
  kind: number;
  byteLength: number;
  source: Uint8Array | string;
}

function arrayPart(section: Section): Part {
  return { name: section.name, kind: section.kind, byteLength: section.bytes.byteLength, source: section.bytes };
}

function jsonPart(name: string, value: Json): Part {
  const text = JSON.stringify(value);
  return { name, kind: KIND_JSON, byteLength: text.length * 2, source: text };
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

const WORD_PRIME_A = 0x01000193;
const WORD_PRIME_B = 0x9e3779b1 | 0;

/**
 * The format 3 checksum: two 32-bit sums over the body read as
 * little-endian 32-bit words. One is FNV-1a 32 with a word where it has a
 * byte; the other turns its sum five bits before each word, so the two do
 * not miss the same change. Each step is one to one in the sum, so no
 * change to a single word goes unseen. Integer operations only, the same in
 * every engine. Taken a run at a time, so a save can take it between
 * ticks: the runs added in order give the sum of the whole body.
 */
class WordChecksum {
  private a = 0x811c9dc5 | 0;
  private b = 0xcbf29ce4 | 0;

  /** Adds `bytes`, which must be a whole number of words long. */
  add(bytes: Uint8Array): void {
    // A view of words has to start on a word boundary of its buffer.
    const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
    const words = new Int32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
    let a = this.a;
    let b = this.b;
    for (let i = 0; i < words.length; i++) {
      const word = words[i] ?? 0;
      a = Math.imul(a ^ word, WORD_PRIME_A);
      b = Math.imul(((b << 5) | (b >>> 27)) ^ word, WORD_PRIME_B);
    }
    this.a = a;
    this.b = b;
  }

  sum(): { hi: number; lo: number } {
    return { hi: this.a >>> 0, lo: this.b >>> 0 };
  }
}

/** A body's checksum taken a run at a time, as layout version `formatVersion` defines it. */
interface BodyChecksum {
  add(bytes: Uint8Array): void;
  sum(): { hi: number; lo: number };
}

function bodyChecksum(formatVersion: number): BodyChecksum {
  if (formatVersion >= FORMAT_WORD_CHECKSUM) return new WordChecksum();
  const h = new Fnv64();
  return { add: (bytes) => h.bytes(bytes), sum: () => ({ hi: h.hi, lo: h.lo }) };
}

/** The checksum of a snapshot body, as layout version `formatVersion` defines it. */
function checksum(bytes: Uint8Array, formatVersion: number): { hi: number; lo: number } {
  const sum = bodyChecksum(formatVersion);
  sum.add(bytes);
  return sum.sum();
}

/**
 * The checksum a snapshot's header should hold for its body, as 16 hex
 * digits: the header's high word, then its low word. For tests and tools
 * that edit snapshot bytes; `bytes` needs a readable format version and a
 * body of the length its layout asks for.
 */
export function snapshotChecksum(bytes: Uint8Array): string {
  const formatVersion = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);
  const sum = checksum(bytes.subarray(HEADER_BYTES), formatVersion);
  return sum.hi.toString(16).padStart(8, "0") + sum.lo.toString(16).padStart(8, "0");
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
  return finish(write(state, pagedLog));
}

/**
 * Writes `state` as snapshot bytes without the entries that have left live
 * state. For a host that stores those itself, once each, so that the cost
 * of a save does not grow with the length of the log. Whoever reads the
 * bytes back must supply the first `state.logOffset` entries.
 */
export function serializeDetached(state: SimState): Uint8Array {
  return finish(write(state, null));
}

/** The work of one snapshot, a part for each `next()`. The last part returns the bytes. */
export type SnapshotSteps = Generator<undefined, Uint8Array, undefined>;

/**
 * `serializeDetached` a part at a time, to the same bytes. Writing a large
 * city takes longer than a host has between two ticks, so a host does one
 * part between ticks: each `next()` does one, and the last returns the
 * bytes. `state` must not change until then. A host whose sim steps on
 * meanwhile passes a copy from `captureState`.
 */
export function serializeDetachedSteps(state: SimState, into?: SnapshotBuffer): SnapshotSteps {
  return write(state, null, into);
}

/**
 * An output buffer a host keeps between saves (issue #158), so that writing
 * a large city does not allocate a fresh buffer of its size every autosave.
 * The bytes a save returns are then a view into it, valid until the next
 * save written into the same buffer: the host must be done with them first.
 * Not state.
 */
export interface SnapshotBuffer {
  buffer: ArrayBuffer | null;
}

/** `serialize` a part at a time. See `serializeDetachedSteps`. */
export function serializeSteps(state: SimState, pagedLog: readonly LogEntry[] = []): SnapshotSteps {
  return write(state, pagedLog);
}

function finish(steps: SnapshotSteps): Uint8Array {
  for (;;) {
    const part = steps.next();
    if (part.done) return part.value;
  }
}

/**
 * Writes code units `from` to `to` of `text`. A function of its own, so the
 * engine compiles this loop on its first long run and not along with all
 * of `write`.
 */
function writeUnits(text: string, units: Uint16Array, from: number, to: number): void {
  for (let i = from; i < to; i++) units[i - from] = text.charCodeAt(i);
}

/**
 * How many bytes one part of a save lays out and takes the checksum of
 * (issue #204). Both cost about the same per byte, so a part's time is set
 * by its bytes, however big the city: 2 MB is about 2 ms on the development
 * container, against the 16 MB in one part that took 8 to 11 ms on the
 * 30,000 segment city and up to 11.4 ms on CI. The format 1 checksum takes
 * a byte at a time and costs about four times as much, so a part of a city
 * file holds a quarter of that. JSON text is written a code unit at a time,
 * so it counts `TEXT_COST` times its bytes. Not balance: these change when
 * the bytes are written, never what they are.
 */
const PART_BYTES = 2 * 1024 * 1024;
const PART_BYTES_BYTE_CHECKSUM = PART_BYTES / 4;
/** What a byte of JSON text costs to write, in bytes of a typed array: its code units are written one at a time. */
const TEXT_COST = 4;

function floor8(n: number): number {
  return n - (n % 8);
}

// The parts are the stages that take time on a large city, each a fraction
// of a tick on 30,000 segments (issue #83): find the typed arrays, write the
// JSON text, then lay out the bytes and take their checksum, a run of at
// most `partBytes` bytes per part.
function* write(
  state: SimState,
  pagedLog: readonly LogEntry[] | null,
  into?: SnapshotBuffer,
  partBytes?: number,
): SnapshotSteps {
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
  // The header is written last, from what the state held when this began.
  const { seed, tick, version } = state;
  // A snapshot with its log inside stays readable by every build. One
  // without is the save taken between ticks, so it gets the fast checksum.
  const formatVersion = pagedLog === null ? SNAPSHOT_FORMAT_VERSION : FORMAT_LOG_INSIDE;
  const perPart =
    partBytes ?? (formatVersion >= FORMAT_WORD_CHECKSUM ? PART_BYTES : PART_BYTES_BYTE_CHECKSUM);
  // Runs end on 8-byte boundaries, so every run the checksum takes is whole words.
  const runBytes = Math.max(8, floor8(perPart));

  const arrays: Section[] = [];
  const fields = encodeJson(state, "", arrays);
  const pagedFields = pagedLog === null ? null : encodeJson(pagedLog, "pagedLog", arrays);
  yield;

  const logParts = pagedFields === null ? [] : [jsonPart("pagedLog", pagedFields)];
  const parts = [jsonPart("state", fields), ...logParts, ...arrays.map(arrayPart)];
  yield;

  let bodyLength = 0;
  for (const part of parts) {
    if (part.name.length > 255 || !/^[\x20-\x7e]*$/.test(part.name)) {
      throw new RangeError(`serialize: section name "${part.name}" must be up to 255 ASCII characters`);
    }
    bodyLength = align8(align8(bodyLength + 1 + part.name.length + 1 + 4) + part.byteLength);
  }
  if (bodyLength > 0xffffffff) throw new RangeError("serialize: snapshot is larger than 4 GB");

  const size = HEADER_BYTES + bodyLength;
  let out: Uint8Array;
  if (into) {
    // A kept buffer holds the last save's bytes, so every byte this layout
    // does not write, the header and the padding, is cleared as it goes.
    if (!into.buffer || into.buffer.byteLength < size) into.buffer = new ArrayBuffer(Math.ceil((size * 1.25) / 8) * 8);
    out = new Uint8Array(into.buffer, 0, size);
    out.fill(0, 0, HEADER_BYTES);
  } else {
    out = new Uint8Array(size);
  }
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const sum = bodyChecksum(formatVersion);
  let at = HEADER_BYTES;
  /** Where the checksum has got to, and where this part's run ends. Both on 8-byte boundaries. */
  let summed = HEADER_BYTES;
  let limit = summed + runBytes;
  for (const part of parts) {
    out[at++] = part.name.length;
    for (let i = 0; i < part.name.length; i++) out[at++] = part.name.charCodeAt(i);
    out[at++] = part.kind;
    view.setUint32(at, part.byteLength, true);
    out.fill(0, at + 4, align8(at + 4));
    at = align8(at + 4);
    const { source, byteLength } = part;
    // Data starts on an 8-byte boundary of `out`, and a run that stops
    // short of the data's end stops on one, so the code units can be
    // written in place, in the platform's order, and the checksum takes
    // whole words.
    for (let done = 0; done < byteLength; ) {
      if (at >= limit) {
        sum.add(out.subarray(summed, at));
        summed = at;
        limit = at + runBytes;
        yield;
      }
      if (typeof source === "string") {
        // A code unit at a time costs several times a copy, so text takes a
        // share of the part's bytes and the rest of the part is charged for it.
        const run = Math.min(byteLength - done, Math.max(8, floor8((limit - at) / TEXT_COST)));
        writeUnits(source, new Uint16Array(out.buffer, out.byteOffset + at, run / 2), done / 2, (done + run) / 2);
        at += run;
        done += run;
        limit = Math.max(align8(at), limit - align8((TEXT_COST - 1) * run));
      } else {
        const run = Math.min(byteLength - done, limit - at);
        out.set(source.subarray(done, done + run), at);
        at += run;
        done += run;
      }
    }
    out.fill(0, at, align8(at));
    at = align8(at);
  }
  sum.add(out.subarray(summed, at));

  out.set(MAGIC, 0);
  view.setUint16(4, formatVersion, true);
  view.setUint16(6, version, true);
  view.setUint32(8, seed, true);
  view.setUint32(12, parts.length, true);
  view.setFloat64(16, tick, true);
  view.setUint32(24, bodyLength, true);
  view.setUint32(28, 0, true);
  const { hi, lo } = sum.sum();
  view.setUint32(32, hi, true);
  view.setUint32(36, lo, true);
  return out;
}

/**
 * `serializeDetachedSteps` or `serializeSteps` with parts of `partBytes`
 * bytes, so a test can split a small state into many parts. Not on the
 * sim's entry.
 */
export function serializeStepsOf(
  state: SimState,
  pagedLog: readonly LogEntry[] | null,
  partBytes: number,
  into?: SnapshotBuffer,
): SnapshotSteps {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) throw new RangeError(`serializeStepsOf: partBytes ${partBytes} must be a whole number of bytes, 1 or more`);
  return write(state, pagedLog, into, partBytes);
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
  if (formatVersion >= FORMAT_WORD_CHECKSUM && bodyLength % 4 !== 0) throw corrupt("its length is not a whole number of words");
  const sum = checksum(bytes.subarray(HEADER_BYTES), formatVersion);
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

/** Whether `value` is a `GrowthState`: five whole numbers, the day at least -1 and the rest at least 0. */
function isGrowth(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { quota, day, deadline, free, used } = value;
  const whole = (v: unknown, least: number) => Number.isSafeInteger(v) && (v as number) >= least;
  return Object.keys(value).length === 5 && whole(quota, 0) && whole(day, -1) && whole(deadline, 0) && whole(free, 0) && whole(used, 0);
}

/** Checks the decoded state has the current shape, so a bad save fails here and not later in play. */
function checkState(state: Record<string, unknown>, pagedLog: unknown[] | null, header: SnapshotHeader): void {
  const { tick, seed, rng, speed, pending, log, logOffset, roads, undo, connections, balance, cells, cellsReadyAt, cellReads, buildings, growth, pops } = state;
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
  if (typeof balance !== "string") throw corrupt("its balance stamp is not text");
  const cellProblem = checkCells(cells, roads as RoadNetwork);
  if (cellProblem !== null) throw corrupt(`its zoning cells are malformed: ${cellProblem}`);
  if (!Number.isSafeInteger(cellsReadyAt) || (cellsReadyAt as number) < 0) throw corrupt("the tick its zoning cells settle by is not a whole number");
  if (!Number.isSafeInteger(cellReads) || (cellReads as number) < 0) throw corrupt("its count of cell commands this tick is not a whole number");
  const buildingProblem = checkBuildings(buildings, roads as RoadNetwork, tick as number);
  if (buildingProblem !== null) throw corrupt(`its buildings are malformed: ${buildingProblem}`);
  if (!isGrowth(growth)) throw corrupt("the grower's plan for the day is malformed");
  const popProblem = checkPops(pops, buildings as BuildingState);
  if (popProblem !== null) throw corrupt(`its pops are malformed: ${popProblem}`);
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

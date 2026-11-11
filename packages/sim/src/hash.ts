// A stable 64-bit FNV-1a hash over the whole state. The state is walked in a
// fixed order (object keys sorted) and every value is fed in as bytes with a
// type tag, so two states hash the same only if they hold the same data.
//
// The 64-bit multiply is done on two 32-bit halves with integer operations,
// one exact division and Math.floor, so the result is the same in every
// engine (CLAUDE.md rule 6) and no BigInt is needed on the hot path.

// FNV-1a 64-bit offset basis 0xcbf29ce484222325, split into halves.
const OFFSET_HI = 0xcbf29ce4;
const OFFSET_LO = 0x84222325;
// FNV 64-bit prime is 2^40 + 0x1b3.
const PRIME_LO = 0x1b3;
const TWO_POW_32 = 4294967296;

const TAG_UNDEFINED = 0;
const TAG_NULL = 1;
const TAG_FALSE = 2;
const TAG_TRUE = 3;
const TAG_NUMBER = 4;
const TAG_NAN = 5;
const TAG_STRING = 6;
const TAG_ARRAY = 7;
const TAG_OBJECT = 8;
const TAG_TYPED_ARRAY = 9;

class Fnv64 {
  hi = OFFSET_HI;
  lo = OFFSET_LO;
  private readonly scratch = new DataView(new ArrayBuffer(8));

  byte(b: number): void {
    const lo = (this.lo ^ (b & 0xff)) >>> 0;
    // (hi * 2^32 + lo) * (2^40 + 0x1b3) mod 2^64
    const loProduct = lo * PRIME_LO; // below 2^41, exact in a float64
    const carry = Math.floor(loProduct / TWO_POW_32);
    this.lo = loProduct >>> 0;
    this.hi = (Math.imul(this.hi, PRIME_LO) + carry + (lo << 8)) >>> 0;
  }

  u32(x: number): void {
    this.byte(x);
    this.byte(x >>> 8);
    this.byte(x >>> 16);
    this.byte(x >>> 24);
  }

  f64(x: number): void {
    // Explicit little endian, so the bytes do not depend on the machine.
    this.scratch.setFloat64(0, x, true);
    for (let i = 0; i < 8; i++) this.byte(this.scratch.getUint8(i));
  }

  str(s: string): void {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) {
      const unit = s.charCodeAt(i);
      this.byte(unit);
      this.byte(unit >>> 8);
    }
  }

  hex(): string {
    return this.hi.toString(16).padStart(8, "0") + this.lo.toString(16).padStart(8, "0");
  }
}

function isTypedArray(value: object): value is ArrayBufferView & { length: number } {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function feed(h: Fnv64, value: unknown, path: string): void {
  switch (typeof value) {
    case "undefined":
      h.byte(TAG_UNDEFINED);
      return;
    case "boolean":
      h.byte(value ? TAG_TRUE : TAG_FALSE);
      return;
    case "number":
      // NaN has many bit patterns and engines may write any of them.
      if (Number.isNaN(value)) {
        h.byte(TAG_NAN);
      } else {
        h.byte(TAG_NUMBER);
        h.f64(value);
      }
      return;
    case "string":
      h.byte(TAG_STRING);
      h.str(value);
      return;
    case "object":
      break;
    default:
      throw new TypeError(`hashState: ${path} is a ${typeof value}, which state must not hold`);
  }
  if (value === null) {
    h.byte(TAG_NULL);
    return;
  }
  if (Array.isArray(value)) {
    h.byte(TAG_ARRAY);
    h.u32(value.length);
    for (let i = 0; i < value.length; i++) feed(h, value[i], `${path}[${i}]`);
    return;
  }
  if (isTypedArray(value)) {
    h.byte(TAG_TYPED_ARRAY);
    h.str(value.constructor.name);
    h.u32(value.byteLength);
    // Raw element bytes in the platform's order. Every engine the game
    // targets is little endian.
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (let i = 0; i < bytes.length; i++) h.byte(bytes[i] ?? 0);
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`hashState: ${path} is not plain data (CLAUDE.md rule 7)`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  h.byte(TAG_OBJECT);
  h.u32(keys.length);
  for (const key of keys) {
    h.str(key);
    feed(h, record[key], `${path}.${key}`);
  }
}

/**
 * 64-bit FNV-1a over every field of `value`, as 16 lowercase hex digits.
 * Takes the whole SimState, or any plain data in the same shape rules.
 * Throws on anything state must not hold: functions, class instances,
 * Maps, symbols, bigints.
 */
export function hashState(value: unknown): string {
  const h = new Fnv64();
  feed(h, value, "state");
  return h.hex();
}

/** 64-bit FNV-1a of raw bytes, as 16 hex digits. Exposed for tests. */
export function fnv1a64(bytes: Uint8Array): string {
  const h = new Fnv64();
  for (let i = 0; i < bytes.length; i++) h.byte(bytes[i] ?? 0);
  return h.hex();
}

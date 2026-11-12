import { inflateSync } from "node:zlib";

// Just enough PNG decoding to read back a Playwright screenshot: 8-bit RGB
// or RGBA, not interlaced. Lets a test check what is on screen without
// pulling in an image library.

export interface Image {
  width: number;
  height: number;
  /** RGBA, row by row. */
  rgba: Uint8Array;
}

export function decodePng(png: Uint8Array): Image {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (out[(y - 1) * stride + x - channels] ?? 0) : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = ((line[x] ?? 0) + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: out };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i] ?? 0;
    rgba[j + 1] = out[i + 1] ?? 0;
    rgba[j + 2] = out[i + 2] ?? 0;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/** Share of pixels further than `tolerance` (summed over R, G and B) from `colour`. */
export function shareUnlike(image: Image, colour: readonly [number, number, number], tolerance = 30): number {
  let unlike = 0;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    const d =
      Math.abs((image.rgba[i * 4] ?? 0) - colour[0]) +
      Math.abs((image.rgba[i * 4 + 1] ?? 0) - colour[1]) +
      Math.abs((image.rgba[i * 4 + 2] ?? 0) - colour[2]);
    if (d > tolerance) unlike++;
  }
  return unlike / pixels;
}

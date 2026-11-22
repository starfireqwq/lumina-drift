/**
 * Whole-factor resizing of RGBA pixels, for the filters that work on a smaller copy: glow's halo and
 * the quick drafts shown while a big layer's preview is still being worked out. No imports, no DOM.
 */

export interface PixelImage {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/** Shrinks by a whole `factor`: each pixel is the average of the block it covers (the last row and column of blocks may be cut short) */
export function downscale(pixels: ArrayLike<number>, width: number, height: number, factor: number): PixelImage {
  const f = Math.max(1, Math.floor(factor));
  const sw = Math.ceil(width / f), sh = Math.ceil(height / f);
  const output = new Uint8Array(sw * sh * 4);
  const sums = new Uint32Array(sw * 4);
  const column = new Int32Array(width);
  for (let x = 0; x < width; x++) column[x] = Math.floor(x / f) * 4;
  for (let sy = 0; sy < sh; sy++) {
    sums.fill(0);
    const top = sy * f, bottom = Math.min(height, top + f);
    for (let y = top; y < bottom; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = row + x * 4, o = column[x];
        sums[o] += pixels[i]; sums[o + 1] += pixels[i + 1]; sums[o + 2] += pixels[i + 2]; sums[o + 3] += pixels[i + 3];
      }
    }
    const rows = bottom - top;
    const out = sy * sw * 4;
    for (let sx = 0; sx < sw; sx++) {
      const n = (Math.min(width, (sx + 1) * f) - sx * f) * rows;
      const half = n >> 1;
      for (let k = 0; k < 4; k++) output[out + sx * 4 + k] = ((sums[sx * 4 + k] + half) / n) | 0;
    }
  }
  return { pixels: output, width: sw, height: sh };
}

/**
 * Stretches a picture that was shrunk by `factor` back to `width` × `height`, sampling between its
 * pixels (bilinear, pixel centres lined up, edges held). Rows are stretched sideways once each and
 * then mixed, so every output value costs one blend. With `keep`, an output pixel whose block is 0
 * in `keep.near` (one value per small pixel) is copied from `keep.original` instead.
 */
export function upscale(small: ArrayLike<number>, sw: number, sh: number, width: number, height: number, factor: number,
  keep?: { original: Uint8Array; near: Uint8Array }) {
  const output = new Uint8Array(width * height * 4);
  if (!sw || !sh) return output;
  const len = width * 4;
  // Which block each output column and row falls in, and the small rows with anything to stretch
  const block = new Int32Array(width);
  for (let x = 0; x < width; x++) block[x] = Math.min(sw - 1, Math.floor(x / factor));
  const rowNeeded = new Uint8Array(sh);
  if (keep) {
    for (let p = 0; p < keep.near.length; p++) if (keep.near[p]) rowNeeded[Math.floor(p / sw)] = 1;
  }
  const colA = new Int32Array(width), colB = new Int32Array(width), colT = new Float32Array(width);
  const place = (at: number, size: number) => {
    const f = (at + 0.5) / factor - 0.5;
    return f < 0 ? 0 : f > size - 1 ? size - 1 : f;
  };
  for (let x = 0; x < width; x++) {
    const fx = place(x, sw);
    const a = Math.floor(fx);
    colA[x] = a * 4;
    colB[x] = Math.min(sw - 1, a + 1) * 4;
    colT[x] = fx - a;
  }
  let upper = new Float32Array(len), lower = new Float32Array(len);
  let upperRow = -1, lowerRow = -1;
  const stretch = (sy: number, into: Float32Array) => {
    const base = sy * sw * 4;
    for (let x = 0; x < width; x++) {
      const a = base + colA[x], b = base + colB[x], t = colT[x], o = x * 4;
      for (let k = 0; k < 4; k++) into[o + k] = small[a + k] + (small[b + k] - small[a + k]) * t;
    }
  };
  for (let y = 0; y < height; y++) {
    const row = y * len;
    const nearRow = Math.min(sh - 1, Math.floor(y / factor));
    if (keep && !rowNeeded[nearRow]) {
      output.set(keep.original.subarray(row, row + len), row);
      continue;
    }
    const fy = place(y, sh);
    const ya = Math.floor(fy), yb = Math.min(sh - 1, ya + 1), t = fy - ya;
    if (upperRow !== ya) {
      if (lowerRow === ya) {
        [upper, lower] = [lower, upper];
        upperRow = ya;
        lowerRow = -1;
      } else {
        stretch(ya, upper);
        upperRow = ya;
      }
    }
    if (lowerRow !== yb) {
      stretch(yb, lower);
      lowerRow = yb;
    }
    if (!keep) {
      for (let i = 0; i < len; i++) output[row + i] = (upper[i] + (lower[i] - upper[i]) * t + 0.5) | 0;
      continue;
    }
    const { original, near } = keep;
    const nearBase = nearRow * sw;
    for (let x = 0; x < width; x++) {
      const o = x * 4, i = row + o;
      if (near[nearBase + block[x]]) {
        for (let k = 0; k < 4; k++) output[i + k] = (upper[o + k] + (lower[o + k] - upper[o + k]) * t + 0.5) | 0;
      } else {
        output[i] = original[i]; output[i + 1] = original[i + 1]; output[i + 2] = original[i + 2]; output[i + 3] = original[i + 3];
      }
    }
  }
  return output;
}

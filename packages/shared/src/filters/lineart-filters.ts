/**
 * Line-art fixes (修正線稿) and the distance transform they share with the outline effect. Pure
 * functions on premultiplied RGBA (they change alpha), no DOM. Written from the textbook methods:
 * an exact Euclidean distance transform (lower envelope of parabolas, two separable passes) and
 * flood-fill labelling of connected regions.
 */
import { hexToRgb } from '../color/pigment-blend';

/** Alpha from which a pixel counts as ink (line) rather than paper */
export const INK_ALPHA = 128;
const FAR = 1e20;

export interface DistanceField {
  /** Squared distance from each pixel to the nearest marked pixel (FAR when there is none) */
  dist2: Float32Array;
  /** Index of that nearest marked pixel (−1 when there is none) */
  nearest: Int32Array;
}

/** One line of the transform: squared distances `f` in, the lower envelope out (with its sites) */
function envelope(f: Float64Array, n: number, d: Float64Array, site: Int32Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    site[q] = v[k];
  }
}

/** Exact Euclidean distance from every pixel to the nearest pixel where `marked` is non-zero */
export function distanceField(marked: Uint8Array, width: number, height: number): DistanceField {
  const count = width * height;
  const dist2 = new Float32Array(count);
  const nearest = new Int32Array(count);
  // Rows: the nearest marked pixel to the left or right on the same row
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (marked[row + x]) last = x;
      nearest[row + x] = last;
    }
    last = -1;
    for (let x = width - 1; x >= 0; x--) {
      if (marked[row + x]) last = x;
      const left = nearest[row + x];
      const pick = left < 0 ? last : last < 0 ? left : (x - left <= last - x ? left : last);
      nearest[row + x] = pick;
      dist2[row + x] = pick < 0 ? FAR : (x - pick) * (x - pick);
    }
  }
  // Columns: combine the rows' distances into the true 2D distance
  const f = new Float64Array(height);
  const d = new Float64Array(height);
  const site = new Int32Array(height);
  const columnX = new Int32Array(height);
  const v = new Int32Array(height);
  const z = new Float64Array(height + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = dist2[y * width + x];
      columnX[y] = nearest[y * width + x];
    }
    envelope(f, height, d, site, v, z);
    for (let y = 0; y < height; y++) {
      const p = y * width + x;
      const sx = columnX[site[y]];
      dist2[p] = d[y] >= FAR ? FAR : d[y];
      nearest[p] = sx < 0 || d[y] >= FAR ? -1 : site[y] * width + sx;
    }
  }
  return { dist2, nearest };
}

/** Pixels whose alpha reaches INK_ALPHA (or, with `invert`, those that do not) */
export function inkMap(pixels: Uint8Array | Uint8ClampedArray, invert = false) {
  const count = pixels.length / 4;
  const marked = new Uint8Array(count);
  for (let p = 0; p < count; p++) marked[p] = (pixels[p * 4 + 3] >= INK_ALPHA) !== invert ? 1 : 0;
  return marked;
}

/**
 * 線條粗細. Positive `amount` grows lines by that many pixels, taking the colour of the nearest
 * line pixel, with a soft edge. Negative shrinks them; `keepThin` keeps each line's middle (the
 * ridge of the distance to the paper) so thin lines thin out to about a pixel instead of vanishing.
 */
export function changeLineWidth(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, amount: number, keepThin: boolean) {
  const output = new Uint8Array(pixels);
  if (!amount) return output;
  const count = width * height;
  if (amount > 0) {
    const { dist2, nearest } = distanceField(inkMap(pixels), width, height);
    for (let p = 0; p < count; p++) {
      const q = nearest[p];
      if (q < 0 || q === p) continue;
      // The pixel spans d ± ½ from the line pixel's centre, whose own edge is ½ out: the new edge is amount + ½ out
      const cover = Math.min(1, Math.max(0, amount + 1 - Math.sqrt(dist2[p])));
      if (cover <= 0) continue;
      const inkAlpha = pixels[q * 4 + 3];
      const alpha = inkAlpha * cover;
      if (alpha <= pixels[p * 4 + 3]) continue;
      const scale = alpha / inkAlpha;
      output[p * 4] = Math.round(pixels[q * 4] * scale);
      output[p * 4 + 1] = Math.round(pixels[q * 4 + 1] * scale);
      output[p * 4 + 2] = Math.round(pixels[q * 4 + 2] * scale);
      output[p * 4 + 3] = Math.round(alpha);
    }
    return output;
  }
  const by = -amount;
  const { dist2 } = distanceField(inkMap(pixels, true), width, height);
  if (dist2[0] >= FAR) return output; // no paper anywhere: nothing has an edge
  const dist = new Float32Array(count);
  for (let p = 0; p < count; p++) dist[p] = Math.sqrt(dist2[p]);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : dist[y * width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const d = dist[p];
      // The paper's edge moves `by` pixels in: what is left of this pixel
      let keep = Math.min(1, Math.max(0, d - by));
      if (keep < 1 && keepThin && d > 0) {
        // A ridge: no lower than both neighbours across some direction, and higher than one of them
        for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          const a = at(x - dx, y - dy);
          const b = at(x + dx, y + dy);
          if (d >= a && d >= b && (d > a || d > b)) { keep = 1; break; }
        }
      }
      if (keep >= 1) continue;
      for (let k = 0; k < 4; k++) output[p * 4 + k] = Math.round(pixels[p * 4 + k] * keep);
    }
  }
  return output;
}

export type DespeckleMode = 'opaque' | 'onWhite' | 'fillAround' | 'fillCurrent';
const FAINT = 16;

/**
 * 去除雜點: finds connected regions no bigger than `size` × `size` pixels and
 * - opaque: clears small specks of paint;
 * - onWhite: paints small dark specks white (scanned art on a white page);
 * - fillAround: fills small clear holes with the colour around them;
 * - fillCurrent: fills small clear holes with `fill` (the current colour).
 * Holes touching the picture's edge are never filled.
 */
export function despeckle(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, size: number, mode: DespeckleMode, fill = '#000000') {
  const output = new Uint8Array(pixels);
  const count = width * height;
  const limit = Math.max(1, Math.round(size));
  const holes = mode === 'fillAround' || mode === 'fillCurrent';
  const candidate = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    const a = pixels[i + 3];
    if (holes) candidate[p] = a < FAINT ? 1 : 0;
    else if (mode === 'opaque') candidate[p] = a >= FAINT ? 1 : 0;
    else candidate[p] = a >= FAINT && (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) * 255 / a < 128 ? 1 : 0;
  }
  const seen = new Uint8Array(count);
  const stack = new Int32Array(count);
  const members = new Int32Array(limit * limit);
  const color = holes && mode === 'fillCurrent' ? hexToRgb(fill) : null;
  // Holes are 4-connected (a diagonal gap still closes them); specks 8-connected
  const steps = holes ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let start = 0; start < count; start++) {
    if (!candidate[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    let small = true;
    let edge = false;
    let held = 0;
    const around = [0, 0, 0, 0, 0];
    while (top) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (small && (maxX - minX >= limit || maxY - minY >= limit)) small = false;
      if (small) members[held++] = p;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
      for (const [dx, dy] of steps) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (candidate[n]) {
          if (!seen[n]) { seen[n] = 1; stack[top++] = n; }
        } else if (holes && small) {
          for (let k = 0; k < 4; k++) around[k] += pixels[n * 4 + k];
          around[4]++;
        }
      }
    }
    if (!small || (holes && edge)) continue;
    for (let m = 0; m < held; m++) {
      const i = members[m] * 4;
      if (mode === 'opaque') {
        output[i] = output[i + 1] = output[i + 2] = output[i + 3] = 0;
      } else if (mode === 'onWhite') {
        output[i] = output[i + 1] = output[i + 2] = pixels[i + 3];
      } else if (color) {
        output[i] = color.r;
        output[i + 1] = color.g;
        output[i + 2] = color.b;
        output[i + 3] = 255;
      } else if (around[4]) {
        for (let k = 0; k < 4; k++) output[i + k] = Math.round(around[k] / around[4]);
      }
    }
  }
  return output;
}

/**
 * 抽取線稿: the paper turns clear and the lines keep their darkness as opacity. `whiteRange`
 * (0–50 %) is how much near-white still counts as paper. With `keepColor` the colour is unmixed
 * from the paper (a light red becomes half-clear pure red); without it the lines turn black.
 */
export function extractLines(pixels: Uint8Array | Uint8ClampedArray, whiteRange: number, keepColor: boolean) {
  const output = new Uint8Array(pixels.length);
  const paper = 255 * (1 - Math.min(50, Math.max(0, whiteRange)) / 100);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (!a) continue;
    const r = pixels[i] * 255 / a;
    const g = pixels[i + 1] * 255 / a;
    const b = pixels[i + 2] * 255 / a;
    const ink = (c: number) => Math.min(1, Math.max(0, (paper - c) / paper));
    let line: number;
    let lr = 0, lg = 0, lb = 0;
    if (keepColor) {
      line = Math.max(ink(r), ink(g), ink(b));
      if (line > 0) {
        const unmix = (c: number) => Math.min(255, Math.max(0, paper - (paper - c) / line));
        lr = unmix(r);
        lg = unmix(g);
        lb = unmix(b);
      }
    } else {
      line = ink(0.299 * r + 0.587 * g + 0.114 * b);
    }
    const alpha = line * a;
    output[i] = Math.round(lr * alpha / 255);
    output[i + 1] = Math.round(lg * alpha / 255);
    output[i + 2] = Math.round(lb * alpha / 255);
    output[i + 3] = Math.round(alpha);
  }
  return output;
}

/** 統一線色: every painted pixel takes one colour (straight colour; alpha untouched) */
export function recolorLines(pixels: Uint8Array | Uint8ClampedArray, hex: string) {
  const output = new Uint8Array(pixels);
  const { r, g, b } = hexToRgb(hex);
  for (let i = 0; i < output.length; i += 4) {
    if (!output[i + 3]) continue;
    output[i] = r;
    output[i + 1] = g;
    output[i + 2] = b;
  }
  return output;
}

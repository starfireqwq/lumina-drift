/**
 * Effects (效果): radial colour split, mosaic, glow, outline, and the box blur several filters
 * build on. Pure functions on RGBA, no DOM. Radial split works on straight colour (alpha kept);
 * the others work on premultiplied colour because they change alpha.
 */
import { hexToRgb } from '../color/pigment-blend';
import { INK_ALPHA, distanceField, inkMap } from './lineart-filters';
import { downscale, upscale } from './resample';

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * One running-sum box blur of radius `r` (≥ 1, edges clamped) from `source` into `target`, through
 * `scratch` (all the same length). The rows are read first, so `target` may be `source`. All four
 * channels move together and the vertical pass walks whole rows with a row of column sums, which
 * keeps memory reads in order (about four times faster than a pass per channel and column).
 */
function boxBlurInto(source: ArrayLike<number>, width: number, height: number, r: number, scratch: Uint8Array, target: Uint8Array) {
  // sum / span rounded: a sum of whole numbers over an odd span never lands on .5
  const inv = 1 / (r * 2 + 1);
  const lastX = width - 1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let k = -r; k <= r; k++) {
      const i = row + (k < 0 ? 0 : k > lastX ? lastX : k) * 4;
      s0 += source[i]; s1 += source[i + 1]; s2 += source[i + 2]; s3 += source[i + 3];
    }
    for (let x = 0; x < width; x++) {
      const o = row + x * 4;
      scratch[o] = (s0 * inv + 0.5) | 0;
      scratch[o + 1] = (s1 * inv + 0.5) | 0;
      scratch[o + 2] = (s2 * inv + 0.5) | 0;
      scratch[o + 3] = (s3 * inv + 0.5) | 0;
      const out = row + (x - r < 0 ? 0 : x - r) * 4;
      const into = row + (x + r + 1 > lastX ? lastX : x + r + 1) * 4;
      s0 += source[into] - source[out];
      s1 += source[into + 1] - source[out + 1];
      s2 += source[into + 2] - source[out + 2];
      s3 += source[into + 3] - source[out + 3];
    }
  }
  const len = width * 4;
  const lastY = height - 1;
  const sums = new Int32Array(len);
  for (let k = -r; k <= r; k++) {
    const base = (k < 0 ? 0 : k > lastY ? lastY : k) * len;
    for (let i = 0; i < len; i++) sums[i] += scratch[base + i];
  }
  for (let y = 0; y < height; y++) {
    const row = y * len;
    const out = (y - r < 0 ? 0 : y - r) * len;
    const into = (y + r + 1 > lastY ? lastY : y + r + 1) * len;
    for (let i = 0; i < len; i++) {
      target[row + i] = (sums[i] * inv + 0.5) | 0;
      sums[i] += scratch[into + i] - scratch[out + i];
    }
  }
  return target;
}

/** Running-sum box blur on each RGBA channel, radius ≥ 1, edges clamped */
export function boxBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number) {
  const r = Math.max(1, Math.round(radius));
  return boxBlurInto(pixels, width, height, r, new Uint8Array(pixels.length), new Uint8Array(pixels.length));
}

/** Three box blurs of radius `r` in a row (two buffers in all) */
export function tripleBoxBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number) {
  const r = Math.max(1, Math.round(radius));
  const scratch = new Uint8Array(pixels.length);
  const output = boxBlurInto(pixels, width, height, r, scratch, new Uint8Array(pixels.length));
  boxBlurInto(output, width, height, r, scratch, output);
  return boxBlurInto(output, width, height, r, scratch, output);
}

/** Three box blurs in a row: close to a Gaussian of about `radius` */
export function softBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number) {
  return tripleBoxBlur(pixels, width, height, Math.max(1, Math.round(radius / 2)));
}

/**
 * 放射狀色差 (straight colour): red is drawn in towards the centre and blue pushed out, growing
 * with distance; `amount` is the split in pixels at the picture's corners.
 */
export function radialChromatic(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, cx: number, cy: number, amount: number) {
  const output = new Uint8Array(pixels);
  const k = amount / Math.max(1, Math.hypot(width, height) / 2);
  if (!k) return output;
  const clampX = (x: number) => Math.min(width - 1, Math.max(0, Math.round(x)));
  const clampY = (y: number) => Math.min(height - 1, Math.max(0, Math.round(y)));
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!pixels[i + 3]) continue;
      const dx = x - cx;
      output[i] = pixels[(clampY(cy + dy * (1 - k)) * width + clampX(cx + dx * (1 - k))) * 4];
      output[i + 2] = pixels[(clampY(cy + dy * (1 + k)) * width + clampX(cx + dx * (1 + k))) * 4 + 2];
    }
  }
  return output;
}

/** 馬賽克: square cells from the canvas's top-left corner, each the average of what it covers */
export function mosaic(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, cell: number) {
  const size = Math.max(2, Math.round(cell));
  const output = new Uint8Array(pixels.length);
  for (let top = 0; top < height; top += size) {
    const bottom = Math.min(height, top + size);
    for (let left = 0; left < width; left += size) {
      const right = Math.min(width, left + size);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const i = (y * width + x) * 4;
          r += pixels[i];
          g += pixels[i + 1];
          b += pixels[i + 2];
          a += pixels[i + 3];
        }
      }
      const n = (bottom - top) * (right - left);
      const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) output.set(avg, (y * width + x) * 4);
      }
    }
  }
  return output;
}

/**
 * 發光: what is brighter than `threshold` is blurred into a halo of about `radius` and screened
 * back over the picture at `strength` % (the halo can spill onto clear pixels).
 */
export function glow(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number, strength: number, threshold: number) {
  const bright = new Uint8Array(pixels.length);
  const span = Math.max(1, 255 - threshold);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (!a) continue;
    const t = Math.min(1, Math.max(0, (luma(pixels[i], pixels[i + 1], pixels[i + 2]) * 255 / a - threshold) / span));
    if (!t) continue;
    for (let k = 0; k < 4; k++) bright[i + k] = Math.round(pixels[i + k] * t);
  }
  // A wide halo is soft anyway: blur it at half size and stretch it back (about four times less work)
  let halo: Uint8Array;
  if (radius >= HALF_SIZE_GLOW_RADIUS && width >= 4 && height >= 4) {
    const small = downscale(bright, width, height, 2);
    halo = upscale(softBlur(small.pixels, small.width, small.height, radius / 2), small.width, small.height, width, height, 2);
  } else {
    halo = softBlur(bright, width, height, radius);
  }
  const gain = Math.max(0, strength) / 100;
  // Screened over the picture, written into the halo's buffer
  for (let i = 0; i < pixels.length; i++) {
    const s = pixels[i] / 255;
    const h = Math.min(1, (halo[i] / 255) * gain);
    halo[i] = ((s + h - s * h) * 255 + 0.5) | 0;
  }
  return halo;
}

/** From this radius up, glow's halo is blurred at half size (the difference stays within a few levels) */
export const HALF_SIZE_GLOW_RADIUS = 8;

export type OutlinePosition = 'outside' | 'inside' | 'center';

/**
 * 外框線: a stroke of `size` pixels round what is painted, outside it (under the picture), inside
 * it (over the picture's edge) or half and half. Soft where the edge runs diagonally or curves.
 */
export function outline(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, size: number, hex: string, position: OutlinePosition) {
  const output = new Uint8Array(pixels);
  const { r, g, b } = hexToRgb(hex);
  const count = width * height;
  const outer = position === 'outside' ? size : position === 'center' ? size / 2 : 0;
  const inner = position === 'inside' ? size : position === 'center' ? size / 2 : 0;
  if (outer > 0) {
    const { dist2 } = distanceField(inkMap(pixels), width, height);
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      if (pixels[i + 3] >= INK_ALPHA) continue;
      const cover = Math.min(1, Math.max(0, outer + 1 - Math.sqrt(dist2[p])));
      if (!cover) continue;
      const under = cover * (1 - pixels[i + 3] / 255);
      output[i] = Math.round(pixels[i] + r * under);
      output[i + 1] = Math.round(pixels[i + 1] + g * under);
      output[i + 2] = Math.round(pixels[i + 2] + b * under);
      output[i + 3] = Math.round(pixels[i + 3] + 255 * under);
    }
  }
  if (inner > 0) {
    const { dist2 } = distanceField(inkMap(pixels, true), width, height);
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      const a = pixels[i + 3];
      if (a < INK_ALPHA) continue;
      const cover = Math.min(1, Math.max(0, inner + 1 - Math.sqrt(dist2[p])));
      if (!cover) continue;
      const stroke = (a / 255) * cover;
      output[i] = Math.round(r * stroke + pixels[i] * (1 - stroke));
      output[i + 1] = Math.round(g * stroke + pixels[i + 1] * (1 - stroke));
      output[i + 2] = Math.round(b * stroke + pixels[i + 2] * (1 - stroke));
      output[i + 3] = Math.round(255 * stroke + a * (1 - stroke));
    }
  }
  return output;
}

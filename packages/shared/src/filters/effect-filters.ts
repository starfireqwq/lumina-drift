/**
 * Effects (效果): radial colour split, mosaic, glow, outline, and the box blur several filters
 * build on. Pure functions on RGBA, no DOM. Radial split works on straight colour (alpha kept);
 * the others work on premultiplied colour because they change alpha.
 */
import { hexToRgb } from '../color/pigment-blend';
import { INK_ALPHA, distanceField, inkMap } from './lineart-filters';

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Running-sum box blur on each RGBA channel, radius ≥ 1, edges clamped */
export function boxBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number) {
  const r = Math.max(1, Math.round(radius));
  const horizontal = new Uint8Array(pixels.length);
  const output = new Uint8Array(pixels.length);
  const span = r * 2 + 1;
  const pass = (source: ArrayLike<number>, target: Uint8Array, length: number, lines: number, stride: number, lineStride: number) => {
    for (let line = 0; line < lines; line++) {
      const base = line * lineStride;
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += source[base + Math.min(length - 1, Math.max(0, k)) * stride + channel];
        for (let at = 0; at < length; at++) {
          target[base + at * stride + channel] = Math.round(sum / span);
          sum -= source[base + Math.max(0, at - r) * stride + channel];
          sum += source[base + Math.min(length - 1, at + r + 1) * stride + channel];
        }
      }
    }
  };
  pass(pixels, horizontal, width, height, 4, width * 4);
  pass(horizontal, output, height, width, width * 4, 4);
  return output;
}

/** Three box blurs in a row: close to a Gaussian of about `radius` */
export function softBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number) {
  const r = Math.max(1, Math.round(radius / 2));
  return boxBlur(boxBlur(boxBlur(pixels, width, height, r), width, height, r), width, height, r);
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
  const halo = softBlur(bright, width, height, radius);
  const gain = Math.max(0, strength) / 100;
  const output = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const s = pixels[i] / 255;
    const h = Math.min(1, (halo[i] / 255) * gain);
    output[i] = Math.round((s + h - s * h) * 255);
  }
  return output;
}

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

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

/**
 * 浮雕 (straight colour, alpha untouched): directional light slope along `angleDeg` at `heightPx`
 * spacing. Without `keepColor`, flat regions become neutral 128 grey (ready for Overlay blend).
 */
export function emboss(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  angleDeg: number,
  heightPx: number,
  amountPct: number,
  keepColor: boolean,
) {
  const output = new Uint8Array(pixels);
  const rad = angleDeg * Math.PI / 180;
  const dist = Math.max(1, heightPx);
  const dx = Math.round(Math.cos(rad) * dist);
  const dy = Math.round(-Math.sin(rad) * dist);
  const gain = Math.max(0, amountPct) / 100 * 0.5;
  const clampCoord = (v: number, max: number) => (v < 0 ? 0 : v >= max ? max - 1 : v);

  // Precompute weighted luminance (0 where transparent so shapes on clear backgrounds bevel cleanly)
  const field = new Float32Array(width * height);
  for (let p = 0, i = 0; p < field.length; p++, i += 4) {
    const a = pixels[i + 3];
    field[p] = a ? luma(pixels[i], pixels[i + 1], pixels[i + 2]) * (a / 255) : 0;
  }

  for (let y = 0; y < height; y++) {
    const y1 = clampCoord(y + dy, height) * width;
    const y2 = clampCoord(y - dy, height) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = (row + x) * 4;
      if (!pixels[i + 3]) continue;
      const x1 = clampCoord(x + dx, width);
      const x2 = clampCoord(x - dx, width);
      const diff = (field[y1 + x1] - field[y2 + x2]) * gain;
      if (keepColor) {
        output[i] = Math.min(255, Math.max(0, Math.round(pixels[i] + diff)));
        output[i + 1] = Math.min(255, Math.max(0, Math.round(pixels[i + 1] + diff)));
        output[i + 2] = Math.min(255, Math.max(0, Math.round(pixels[i + 2] + diff)));
      } else {
        const v = Math.min(255, Math.max(0, Math.round(128 + diff)));
        output[i] = v;
        output[i + 1] = v;
        output[i + 2] = v;
      }
    }
  }
  return output;
}

/** 1-channel separable 3-pass box blur on an alpha buffer (4x less work than blurring RGBA) */
function blurAlpha(alpha: Uint8Array, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.round(radius));
  if (r <= 0 || width <= 0 || height <= 0) return alpha;
  const side = r * 2 + 1;
  let src: Uint8Array = alpha;
  const tmp = new Uint8Array(alpha.length);
  let dst: Uint8Array = new Uint8Array(alpha.length);
  const clamp = (v: number, max: number) => (v < 0 ? 0 : v >= max ? max - 1 : v);

  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[row + clamp(k, width)];
      for (let x = 0; x < width; x++) {
        tmp[row + x] = (sum + (side >> 1)) / side | 0;
        sum -= src[row + clamp(x - r, width)];
        sum += src[row + clamp(x + r + 1, width)];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[clamp(k, height) * width + x];
      for (let y = 0; y < height; y++) {
        dst[y * width + x] = (sum + (side >> 1)) / side | 0;
        sum -= tmp[clamp(y - r, height) * width + x];
        sum += tmp[clamp(y + r + 1, height) * width + x];
      }
    }
    const next = src;
    src = dst;
    dst = next;
  }
  return src;
}

/**
 * 投影 (premultiplied RGBA): shifts and blurs the layer's alpha silhouette into a coloured shadow
 * underneath the original artwork (or outputs only the shadow when `shadowOnly` is true).
 */
export function dropShadow(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  radius: number,
  opacityPct: number,
  hex: string,
  shadowOnly: boolean,
) {
  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);
  const alphaBuf = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = y - oy;
    if (sy < 0 || sy >= height) continue;
    const dstRow = y * width;
    const srcRow = sy * width;
    for (let x = 0; x < width; x++) {
      const sx = x - ox;
      if (sx < 0 || sx >= width) continue;
      alphaBuf[dstRow + x] = pixels[(srcRow + sx) * 4 + 3];
    }
  }
  const blurred = blurAlpha(alphaBuf, width, height, Math.max(0, radius) / 2);
  const { r: sr, g: sg, b: sb } = hexToRgb(hex);
  const op = Math.min(1, Math.max(0, opacityPct / 100));
  const output = new Uint8Array(pixels.length);
  for (let p = 0, i = 0; p < blurred.length; p++, i += 4) {
    const sa = (blurred[p] / 255) * op;
    const shR = sr * sa;
    const shG = sg * sa;
    const shB = sb * sa;
    const shA = 255 * sa;
    if (shadowOnly) {
      output[i] = Math.round(shR);
      output[i + 1] = Math.round(shG);
      output[i + 2] = Math.round(shB);
      output[i + 3] = Math.round(shA);
    } else {
      const oa = pixels[i + 3];
      const under = 1 - oa / 255;
      output[i] = Math.min(255, Math.round(pixels[i] + shR * under));
      output[i + 1] = Math.min(255, Math.round(pixels[i + 1] + shG * under));
      output[i + 2] = Math.min(255, Math.round(pixels[i + 2] + shB * under));
      output[i + 3] = Math.min(255, Math.round(oa + shA * under));
    }
  }
  return output;
}

/**
 * 邊緣偵測轉線稿 (premultiplied RGBA): Sobel edge magnitude on luma & alpha, with optional
 * thickness dilation, colour preservation, and transparent or white background.
 */
export function edgeToLineart(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  sensitivity: number,
  thickness: number,
  keepColor: boolean,
  whiteBg: boolean,
) {
  const count = width * height;
  const lField = new Float32Array(count);
  const aField = new Float32Array(count);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const a = pixels[i + 3];
    aField[p] = a;
    lField[p] = a ? luma(pixels[i], pixels[i + 1], pixels[i + 2]) * 255 / a : 255;
  }

  let mag = new Float32Array(count);
  const clamp = (v: number, max: number) => (v < 0 ? 0 : v >= max ? max - 1 : v);
  for (let y = 0; y < height; y++) {
    const ym = clamp(y - 1, height) * width;
    const y0 = y * width;
    const yp = clamp(y + 1, height) * width;
    for (let x = 0; x < width; x++) {
      const xm = clamp(x - 1, width);
      const xp = clamp(x + 1, width);
      const glx = (lField[ym + xp] + 2 * lField[y0 + xp] + lField[yp + xp]) - (lField[ym + xm] + 2 * lField[y0 + xm] + lField[yp + xm]);
      const gly = (lField[yp + xm] + 2 * lField[yp + x] + lField[yp + xp]) - (lField[ym + xm] + 2 * lField[ym + x] + lField[ym + xp]);
      const gax = (aField[ym + xp] + 2 * aField[y0 + xp] + aField[yp + xp]) - (aField[ym + xm] + 2 * aField[y0 + xm] + aField[yp + xm]);
      const gay = (aField[yp + xm] + 2 * aField[yp + x] + aField[yp + xp]) - (aField[ym + xm] + 2 * aField[ym + x] + aField[ym + xp]);
      mag[y0 + x] = Math.max(Math.hypot(glx, gly), Math.hypot(gax, gay)) * 0.25;
    }
  }

  const dilateR = Math.min(4, Math.max(0, Math.round(thickness) - 1));
  if (dilateR > 0) {
    const tmp = new Float32Array(count);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let best = 0;
        const lo = Math.max(0, x - dilateR), hi = Math.min(width - 1, x + dilateR);
        for (let k = lo; k <= hi; k++) if (mag[row + k] > best) best = mag[row + k];
        tmp[row + x] = best;
      }
    }
    const outMag = new Float32Array(count);
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - dilateR), hi = Math.min(height - 1, y + dilateR);
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let best = 0;
        for (let k = lo; k <= hi; k++) if (tmp[k * width + x] > best) best = tmp[k * width + x];
        outMag[row + x] = best;
      }
    }
    mag = outMag;
  }

  const sens = Math.min(100, Math.max(1, sensitivity));
  const floor = Math.max(2, (100 - sens) * 0.55);
  const span = Math.max(12, 110 - sens * 0.85);
  const output = new Uint8Array(pixels.length);

  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const ink = Math.min(1, Math.max(0, (mag[p] - floor) / span));
    let lr = 0, lg = 0, lb = 0;
    if (keepColor && pixels[i + 3] > 0) {
      const a = pixels[i + 3];
      lr = Math.min(255, pixels[i] * 255 / a);
      lg = Math.min(255, pixels[i + 1] * 255 / a);
      lb = Math.min(255, pixels[i + 2] * 255 / a);
    }
    if (whiteBg) {
      const inv = 1 - ink;
      output[i] = Math.round(lr * ink + 255 * inv);
      output[i + 1] = Math.round(lg * ink + 255 * inv);
      output[i + 2] = Math.round(lb * ink + 255 * inv);
      output[i + 3] = 255;
    } else if (ink > 0) {
      output[i] = Math.round(lr * ink);
      output[i + 1] = Math.round(lg * ink);
      output[i + 2] = Math.round(lb * ink);
      output[i + 3] = Math.round(255 * ink);
    }
  }
  return output;
}

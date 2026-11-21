/**
 * Colour filters (色彩濾鏡): colour adjust, levels, grayscale, threshold, and the tone histogram
 * the levels window shows. Pure functions on RGBA, no DOM. Unless noted they take straight
 * (un-premultiplied) colour and leave alpha alone: runPixelFilter premultiplies afterwards and
 * blends the result in through the selection mask.
 */

const clamp255 = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);
/** BT.601 luma, the weights the gradient map and halftone already use */
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export interface ColorAdjustSettings {
  /** −100…100 */
  brightness: number;
  /** −100…100 */
  contrast: number;
  /** −180…180 degrees */
  hue: number;
  /** −100…100 (−100 = grey) */
  saturation: number;
  /** −100…100: blue ↔ orange */
  temperature: number;
  /** −100…100: green ↔ magenta */
  tint: number;
}

/**
 * Hue turned round the grey axis, then saturation scaled, as one 3×3 matrix. The coefficients
 * are the hue-rotate and saturate matrices published in the SVG filter specification.
 */
function hueSaturationMatrix(degrees: number, saturation: number) {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hue = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const k = saturation;
  const sat = [
    0.213 + 0.787 * k, 0.715 - 0.715 * k, 0.072 - 0.072 * k,
    0.213 - 0.213 * k, 0.715 + 0.285 * k, 0.072 - 0.072 * k,
    0.213 - 0.213 * k, 0.715 - 0.715 * k, 0.072 + 0.928 * k,
  ];
  const out = new Array<number>(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] = sat[row * 3] * hue[col] + sat[row * 3 + 1] * hue[3 + col] + sat[row * 3 + 2] * hue[6 + col];
    }
  }
  return out;
}

/** Brightness (an offset) then contrast (round the middle grey), as a lookup table */
function toneLut(brightness: number, contrast: number) {
  const lut = new Uint8Array(256);
  const offset = brightness * 1.28;
  const factor = contrast >= 0 ? 1 + contrast / 50 : 1 + contrast / 100;
  for (let v = 0; v < 256; v++) lut[v] = Math.round(clamp255((v + offset - 127.5) * factor + 127.5));
  return lut;
}

/** 色彩調整: brightness, contrast, hue, saturation, temperature and tint in one pass (straight colour) */
export function adjustColor(pixels: Uint8Array | Uint8ClampedArray, settings: ColorAdjustSettings) {
  const output = new Uint8Array(pixels);
  const { brightness, contrast, hue, saturation, temperature, tint } = settings;
  if (!brightness && !contrast && !hue && !saturation && !temperature && !tint) return output;
  const m = hueSaturationMatrix(hue, 1 + saturation / 100);
  const lut = toneLut(brightness, contrast);
  const warm = temperature * 0.38;
  const magenta = tint * 0.38;
  for (let i = 0; i < output.length; i += 4) {
    if (!output[i + 3]) continue;
    const r = output[i], g = output[i + 1], b = output[i + 2];
    const nr = m[0] * r + m[1] * g + m[2] * b + warm;
    const ng = m[3] * r + m[4] * g + m[5] * b + warm * 0.25 - magenta;
    const nb = m[6] * r + m[7] * g + m[8] * b - warm;
    output[i] = lut[Math.round(clamp255(nr))];
    output[i + 1] = lut[Math.round(clamp255(ng))];
    output[i + 2] = lut[Math.round(clamp255(nb))];
  }
  return output;
}

/**
 * 色階: input black and white points stretch the range, midtones (−100…100) bend it (positive is
 * brighter), output black and white points squeeze the result.
 */
export function levelsLut(inBlack: number, inWhite: number, midtones: number, outBlack: number, outWhite: number) {
  const lo = Math.min(254, Math.max(0, Math.round(inBlack)));
  const hi = Math.max(lo + 1, Math.min(255, Math.round(inWhite)));
  const power = 1 / Math.pow(3, midtones / 100);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    lut[v] = Math.round(clamp255(outBlack + (outWhite - outBlack) * Math.pow(t, power)));
  }
  return lut;
}

/** The same table on red, green and blue (straight colour) */
export function mapChannels(pixels: Uint8Array | Uint8ClampedArray, lut: Uint8Array) {
  const output = new Uint8Array(pixels);
  for (let i = 0; i < output.length; i += 4) {
    if (!output[i + 3]) continue;
    output[i] = lut[output[i]];
    output[i + 1] = lut[output[i + 1]];
    output[i + 2] = lut[output[i + 2]];
  }
  return output;
}

/** 灰階 (straight colour) */
export function grayscalePixels(pixels: Uint8Array | Uint8ClampedArray) {
  const output = new Uint8Array(pixels);
  for (let i = 0; i < output.length; i += 4) {
    if (!output[i + 3]) continue;
    const v = Math.round(luma(output[i], output[i + 1], output[i + 2]));
    output[i] = v;
    output[i + 1] = v;
    output[i + 2] = v;
  }
  return output;
}

export type ThresholdTarget = 'color' | 'alpha' | 'both';

/**
 * 二值化 on premultiplied pixels (it may change alpha): colour turns black or white by brightness,
 * alpha turns fully opaque or fully clear, or both. Clear pixels stay clear.
 */
export function thresholdPixels(pixels: Uint8Array | Uint8ClampedArray, level: number, target: ThresholdTarget) {
  const output = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (!a) continue;
    const na = target === 'color' ? a : a >= level ? 255 : 0;
    if (!na) continue;
    let r = pixels[i] * 255 / a;
    let g = pixels[i + 1] * 255 / a;
    let b = pixels[i + 2] * 255 / a;
    if (target !== 'alpha') r = g = b = luma(r, g, b) >= level ? 255 : 0;
    output[i] = Math.round(clamp255(r) * na / 255);
    output[i + 1] = Math.round(clamp255(g) * na / 255);
    output[i + 2] = Math.round(clamp255(b) * na / 255);
    output[i + 3] = na;
  }
  return output;
}

/** How many painted pixels (inside the selection, if any) have each brightness, from premultiplied RGBA */
export function toneHistogram(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, mask?: Uint8Array | null) {
  const bins = new Uint32Array(256);
  const count = width * height;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    const a = pixels[i + 3];
    if (!a || (mask && !mask[p])) continue;
    bins[Math.min(255, Math.round(luma(pixels[i], pixels[i + 1], pixels[i + 2]) * 255 / a))]++;
  }
  return bins;
}

function parseHexRgb(hex: string) {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#9a6b4c';
  const n = parseInt(clean.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * 單色著色 (straight colour, alpha untouched): maps each pixel's brightness into a monochrome tint.
 * With `preserveLuma`, midtones land on the chosen colour while black stays black and white stays white;
 * without it, brightness scales the tint colour directly from black to full tint.
 */
export function monoTintPixels(pixels: Uint8Array | Uint8ClampedArray, hex: string, strength: number, preserveLuma = true) {
  const output = new Uint8Array(pixels);
  const s = Math.min(1, Math.max(0, strength / 100));
  if (s <= 0) return output;
  const keep = 1 - s;
  const { r: tr, g: tg, b: tb } = parseHexRgb(hex);
  for (let i = 0; i < output.length; i += 4) {
    if (!output[i + 3]) continue;
    const r = output[i], g = output[i + 1], b = output[i + 2];
    const y = luma(r, g, b) / 255;
    let nr: number, ng: number, nb: number;
    if (preserveLuma) {
      if (y <= 0.5) {
        const k = y * 2;
        nr = tr * k;
        ng = tg * k;
        nb = tb * k;
      } else {
        const k = (y - 0.5) * 2;
        nr = tr + (255 - tr) * k;
        ng = tg + (255 - tg) * k;
        nb = tb + (255 - tb) * k;
      }
    } else {
      nr = tr * y;
      ng = tg * y;
      nb = tb * y;
    }
    output[i] = Math.round(clamp255(r * keep + nr * s));
    output[i + 1] = Math.round(clamp255(g * keep + ng * s));
    output[i + 2] = Math.round(clamp255(b * keep + nb * s));
  }
  return output;
}

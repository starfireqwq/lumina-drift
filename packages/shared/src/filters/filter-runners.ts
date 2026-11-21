/**
 * Pixel filter runners, looked up by id. Pure functions (no DOM), so the filter worker, the
 * self-checks and later the plugin host all run the same code. The menu, labels and parameter
 * controls live in the client's filter registry; this file only knows how to compute a filter.
 */
import {
  applyChromaticAberration, applyColorCurves, applyGaussianBlur, applyGradientMap,
  applyHalftoneDot, applyNoiseGrain, applyTwirlDistortion,
  type ColorCurvesOptions, type FilterContext, type GradientStop,
} from './pixel-filters';
import { adjustColor, grayscalePixels, levelsLut, mapChannels, monoTintPixels, thresholdPixels } from './color-filters';
import { changeLineWidth, despeckle, extractLines, recolorLines, smoothJaggies } from './lineart-filters';
import { boxBlur, glow, mosaic, outline, radialChromatic } from './effect-filters';
import { motionBlur, soften, spherize, unsharpMask, wave, zoomBlur } from './blur-distort-filters';
import { focusLines, gridPattern, perlinNoise } from './render-filters';
import { downscale, upscale } from './resample';

/** A '#rrggbb' setting, or the fallback */
function filterColor(values: FilterValues, key: string, fallback: string) {
  const value = values[key];
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

/** The colour the user is painting with, which the workspace adds to every run as `currentColor` */
const currentColor = (values: FilterValues) => filterColor(values, 'currentColor', '#000000');

/** A filter's settings, by parameter key (never by position) */
export type FilterValues = Record<string, unknown>;

export interface PixelFilterRunner {
  /** Changes colour only: it sees straight (un-premultiplied) colour, re-premultiplied afterwards */
  colorOnly?: boolean;
  /**
   * Slow on a big layer and still readable from a smaller copy, so a preview may show a draft first
   * (runDraftFilter). Lists the settings measured in pixels, which shrink with the copy.
   */
  draft?: { lengths?: readonly string[]; points?: readonly string[] };
  run: (ctx: FilterContext, values: FilterValues) => Uint8Array;
}

const radians = (degrees: number) => degrees * Math.PI / 180;

/** A number setting, or the fallback when it is missing or not finite */
export function filterNumber(values: FilterValues, key: string, fallback: number) {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A point setting ({ x, y } in canvas pixels), or the middle of the picture */
export function filterPoint(values: FilterValues, key: string, width: number, height: number) {
  const value = values[key] as { x?: unknown; y?: unknown } | null | undefined;
  const x = typeof value?.x === 'number' && Number.isFinite(value.x) ? value.x : width / 2;
  const y = typeof value?.y === 'number' && Number.isFinite(value.y) ? value.y : height / 2;
  return { x, y };
}

/** A string setting that must be one of `choices`; the first choice otherwise */
export function filterChoice<T extends string>(values: FilterValues, key: string, choices: readonly T[]): T {
  const value = values[key];
  return choices.includes(value as T) ? value as T : choices[0];
}

/**
 * 旋轉模糊: 13 reads along an arc round the centre. The parts of each read's position that depend
 * on x alone, and on y alone, are worked out once (the same sums in the same order as before).
 */
function spinBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, degrees: number, cx: number, cy: number) {
  const result = new Uint8Array(pixels.length);
  const count = 13;
  const cos = new Float64Array(count), sin = new Float64Array(count);
  for (let s = 0; s < count; s++) {
    const angle = radians(degrees) * (s / 12 - 0.5);
    cos[s] = Math.cos(angle);
    sin[s] = Math.sin(angle);
  }
  // sx = (cx + (x − cx)·cos) − (y − cy)·sin, sy = (cy + (x − cx)·sin) + (y − cy)·cos
  const alongX = new Float64Array(count * width), downX = new Float64Array(count * width);
  for (let s = 0; s < count; s++) {
    for (let x = 0; x < width; x++) {
      alongX[s * width + x] = cx + (x - cx) * cos[s];
      downX[s * width + x] = cy + (x - cx) * sin[s];
    }
  }
  const alongY = new Float64Array(count), downY = new Float64Array(count);
  for (let y = 0; y < height; y++) {
    for (let s = 0; s < count; s++) {
      alongY[s] = (y - cy) * sin[s];
      downY[s] = (y - cy) * cos[s];
    }
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < count; s++) {
        const sx = Math.round(alongX[s * width + x] - alongY[s]);
        const sy = Math.round(downX[s * width + x] + downY[s]);
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const src = (sy * width + sx) * 4;
        r += pixels[src]; g += pixels[src + 1]; b += pixels[src + 2]; a += pixels[src + 3];
      }
      const dst = (y * width + x) * 4;
      result[dst] = Math.round(r / count);
      result[dst + 1] = Math.round(g / count);
      result[dst + 2] = Math.round(b / count);
      result[dst + 3] = Math.round(a / count);
    }
  }
  return result;
}

/** Built-in filters. Each id matches an entry of the client's filter registry. */
export const PIXEL_FILTER_RUNNERS: Readonly<Record<string, PixelFilterRunner>> = {
  box: { run: ({ pixels, width, height }, v) => boxBlur(pixels, width, height, filterNumber(v, 'radius', 4)) },
  motionBlur: {
    draft: { lengths: ['distance'] },
    run: ({ pixels, width, height }, v) => motionBlur(pixels, width, height, filterNumber(v, 'distance', 20), filterNumber(v, 'angle', 0),
      filterChoice(v, 'direction', ['both', 'forward', 'backward'] as const)),
  },
  radialBlur: {
    draft: { points: ['center'] },
    run: ({ pixels, width, height }, v) => {
      const center = filterPoint(v, 'center', width, height);
      return zoomBlur(pixels, width, height, center.x, center.y, filterNumber(v, 'strength', 30), filterChoice(v, 'direction', ['both', 'in', 'out'] as const));
    },
  },
  soften: { run: ({ pixels, width, height }) => soften(pixels, width, height) },
  wave: {
    draft: { lengths: ['amplitude', 'wavelength'] },
    run: ({ pixels, width, height }, v) => wave(pixels, width, height, filterChoice(v, 'direction', ['horizontal', 'vertical', 'both'] as const),
      filterNumber(v, 'amplitude', 10), filterNumber(v, 'wavelength', 120)),
  },
  spherize: {
    run: ({ pixels, width, height }, v) => {
      const center = filterPoint(v, 'center', width, height);
      return spherize(pixels, width, height, center.x, center.y, filterNumber(v, 'strength', 50), filterNumber(v, 'radius', 300), filterNumber(v, 'squash', 0));
    },
  },
  sharpen: { run: ({ pixels, width, height }) => unsharpMask(pixels, width, height, 1, 60, 0) },
  unsharp: {
    run: ({ pixels, width, height }, v) =>
      unsharpMask(pixels, width, height, filterNumber(v, 'radius', 2), filterNumber(v, 'amount', 100), filterNumber(v, 'threshold', 0)),
  },
  gaussian: { draft: { lengths: ['radius'] }, run: (ctx, v) => applyGaussianBlur(ctx, filterNumber(v, 'radius', 8)) },
  spin: {
    draft: { points: ['center'] },
    run: ({ pixels, width, height }, v) => {
      const center = filterPoint(v, 'center', width, height);
      return spinBlur(pixels, width, height, filterNumber(v, 'angle', 15), center.x, center.y);
    },
  },
  posterize: {
    colorOnly: true,
    run: ({ pixels }, v) => {
      const result = new Uint8Array(pixels);
      const step = 255 / (Math.max(2, Math.round(filterNumber(v, 'levels', 6))) - 1);
      for (let i = 0; i < result.length; i += 4) {
        for (let k = 0; k < 3; k++) result[i + k] = Math.round(Math.round(result[i + k] / step) * step);
      }
      return result;
    },
  },
  invert: {
    colorOnly: true,
    run: ({ pixels }) => {
      const result = new Uint8Array(pixels);
      for (let i = 0; i < result.length; i += 4) {
        for (let k = 0; k < 3; k++) result[i + k] = 255 - result[i + k];
      }
      return result;
    },
  },
  colorAdjust: {
    colorOnly: true,
    run: ({ pixels }, v) => adjustColor(pixels, {
      brightness: filterNumber(v, 'brightness', 0),
      contrast: filterNumber(v, 'contrast', 0),
      hue: filterNumber(v, 'hue', 0),
      saturation: filterNumber(v, 'saturation', 0),
      temperature: filterNumber(v, 'temperature', 0),
      tint: filterNumber(v, 'tint', 0),
    }),
  },
  levels: {
    colorOnly: true,
    run: ({ pixels }, v) => mapChannels(pixels, levelsLut(
      filterNumber(v, 'inBlack', 0), filterNumber(v, 'inWhite', 255), filterNumber(v, 'midtones', 0),
      filterNumber(v, 'outBlack', 0), filterNumber(v, 'outWhite', 255),
    )),
  },
  grayscale: { colorOnly: true, run: ({ pixels }) => grayscalePixels(pixels) },
  monoTint: {
    colorOnly: true,
    run: ({ pixels }, v) => monoTintPixels(pixels, filterColor(v, 'color', '#9a6b4c'), filterNumber(v, 'strength', 100), v.preserveLuma !== false),
  },
  threshold: {
    run: ({ pixels }, v) => thresholdPixels(pixels, filterNumber(v, 'threshold', 128), filterChoice(v, 'target', ['color', 'alpha', 'both'] as const)),
  },
  lineWidth: {
    run: ({ pixels, width, height }, v) => changeLineWidth(pixels, width, height, Math.round(filterNumber(v, 'amount', 1)), v.keepThin !== false),
  },
  despeckle: {
    run: ({ pixels, width, height }, v) => despeckle(pixels, width, height, filterNumber(v, 'size', 3),
      filterChoice(v, 'mode', ['opaque', 'onWhite', 'fillAround', 'fillCurrent'] as const), currentColor(v)),
  },
  extractLines: { run: ({ pixels }, v) => extractLines(pixels, filterNumber(v, 'whiteRange', 10), v.keepColor === true) },
  lineColor: {
    colorOnly: true,
    run: ({ pixels }, v) => recolorLines(pixels, v.useCurrent === false ? filterColor(v, 'color', '#000000') : currentColor(v)),
  },
  smoothJaggies: {
    run: ({ pixels, width, height }, v) => smoothJaggies(pixels, width, height, filterNumber(v, 'strength', 50)),
  },
  perlinNoise: {
    draft: { lengths: ['scale', 'offsetX', 'offsetY'] },
    run: ({ width, height }, v) => perlinNoise(
      width, height,
      filterNumber(v, 'scale', 48), filterNumber(v, 'amplitude', 80), filterNumber(v, 'persistence', 0.5),
      filterNumber(v, 'octaves', 4), filterNumber(v, 'offsetX', 0), filterNumber(v, 'offsetY', 0),
    ),
  },
  gridPattern: {
    run: ({ pixels, width, height }, v) => gridPattern(
      pixels, width, height,
      filterNumber(v, 'cell', 32), filterNumber(v, 'lineWidth', 1), filterColor(v, 'color', '#6366f1'),
      filterNumber(v, 'opacity', 70), filterNumber(v, 'offsetX', 0), filterNumber(v, 'offsetY', 0),
    ),
  },
  focusLines: {
    draft: { points: ['center'] },
    run: ({ pixels, width, height }, v) => {
      const c = filterPoint(v, 'center', width, height);
      return focusLines(
        pixels, width, height, c.x, c.y,
        filterNumber(v, 'density', 60), filterNumber(v, 'lineWidth', 3),
        filterNumber(v, 'innerRadius', 28), filterNumber(v, 'jitter', 40), filterColor(v, 'color', '#111111'),
      );
    },
  },
  noise: { colorOnly: true, run: (ctx, v) => applyNoiseGrain(ctx, filterNumber(v, 'amount', 25) / 100, filterNumber(v, 'grain', 1)) },
  chromatic: {
    colorOnly: true,
    run: (ctx, v) => {
      if (filterChoice(v, 'mode', ['shift', 'radial'] as const) === 'shift') {
        return applyChromaticAberration(ctx, filterNumber(v, 'offsetX', 6), filterNumber(v, 'offsetY', 0));
      }
      const center = filterPoint(v, 'center', ctx.width, ctx.height);
      return radialChromatic(ctx.pixels, ctx.width, ctx.height, center.x, center.y, filterNumber(v, 'spread', 8));
    },
  },
  mosaic: { run: ({ pixels, width, height }, v) => mosaic(pixels, width, height, filterNumber(v, 'cell', 12)) },
  glow: {
    draft: { lengths: ['radius'] },
    run: ({ pixels, width, height }, v) =>
      glow(pixels, width, height, filterNumber(v, 'radius', 16), filterNumber(v, 'strength', 80), filterNumber(v, 'threshold', 160)),
  },
  outline: {
    draft: { lengths: ['size'] },
    run: ({ pixels, width, height }, v) => outline(pixels, width, height, filterNumber(v, 'size', 3), filterColor(v, 'color', '#ffffff'),
      filterChoice(v, 'position', ['outside', 'inside', 'center'] as const)),
  },
  halftone: {
    colorOnly: true,
    run: (ctx, v) => applyHalftoneDot(ctx, filterNumber(v, 'density', 45), radians(filterNumber(v, 'angle', 45)), filterNumber(v, 'dotSize', 1)),
  },
  twirl: {
    run: (ctx, v) => {
      const center = filterPoint(v, 'center', ctx.width, ctx.height);
      return applyTwirlDistortion(ctx, center.x, center.y, filterNumber(v, 'radius', 300), radians(filterNumber(v, 'angle', 135)));
    },
  },
  curves: { colorOnly: true, run: (ctx, v) => applyColorCurves(ctx, (v.options ?? {}) as ColorCurvesOptions) },
  gradient: {
    colorOnly: true,
    run: (ctx, v) => applyGradientMap(ctx, Array.isArray(v.stops) ? v.stops as GradientStop[] : 'sunset', filterNumber(v, 'opacity', 1)),
  },
};

/**
 * Runs a filter over premultiplied RGBA and blends it in through the selection mask (0–255 per
 * pixel; none = everywhere). Colour-only filters work on straight colour, re-premultiplied here.
 */
export function runPixelFilter(
  runner: PixelFilterRunner,
  pixels: Uint8Array,
  width: number,
  height: number,
  values: FilterValues,
  mask?: Uint8Array | null,
): Uint8Array {
  const context: FilterContext = { pixels, width, height };
  if (runner.colorOnly) {
    const straight = new Uint8Array(pixels);
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (!alpha || alpha === 255) continue;
      for (let c = 0; c < 3; c++) straight[i + c] = Math.min(255, Math.round(pixels[i + c] * 255 / alpha));
    }
    context.pixels = straight;
  }
  const result = runner.run(context, values);
  // A runner may hand back its input: never write over the caller's pixels
  const output = result === pixels ? new Uint8Array(result) : result;
  blendFiltered(pixels, output, mask, runner.colorOnly === true);
  return output;
}

/**
 * Puts `output` (the filter's result, changed in place) in through the selection mask: the original
 * where the mask is 0, the result where it is 255. Colour-only results are re-premultiplied by their
 * alpha. Whole-number arithmetic: x / 255 and x / 65025 never land on .5 for a whole x, so
 * `(x + 127) / 255 | 0` rounds exactly like Math.round did on the floating-point blend.
 */
export function blendFiltered(pixels: ArrayLike<number>, output: Uint8Array, mask: Uint8Array | null | undefined, colorOnly: boolean) {
  if (!mask && !colorOnly) return;
  for (let i = 0, p = 0; i < output.length; i += 4, p++) {
    const m = mask ? mask[p] : 255;
    if (m === 0) {
      output[i] = pixels[i]; output[i + 1] = pixels[i + 1]; output[i + 2] = pixels[i + 2]; output[i + 3] = pixels[i + 3];
      continue;
    }
    if (colorOnly) {
      const alpha = output[i + 3];
      if (m === 255) {
        for (let k = 0; k < 3; k++) output[i + k] = ((output[i + k] * alpha + 127) / 255) | 0;
      } else {
        const keep = 255 - m;
        for (let k = 0; k < 3; k++) output[i + k] = ((pixels[i + k] * keep * 255 + output[i + k] * alpha * m + 32512) / 65025) | 0;
        output[i + 3] = ((pixels[i + 3] * keep + alpha * m + 127) / 255) | 0;
      }
    } else if (m !== 255) {
      const keep = 255 - m;
      for (let k = 0; k < 4; k++) output[i + k] = ((pixels[i + k] * keep + output[i + k] * m + 127) / 255) | 0;
    }
  }
}

/**
 * A quick draft of a slow filter on a big layer: worked out on a copy shrunk by a whole `factor`
 * (with the runner's pixel-sized settings and points shrunk too) and stretched back. Where the
 * shrunk copy came out unchanged, the layer's own pixels stay, so untouched parts keep their
 * sharpness; the selection mask is applied at full size. Filters without `draft` run in full.
 */
export function runDraftFilter(
  runner: PixelFilterRunner,
  pixels: Uint8Array,
  width: number,
  height: number,
  values: FilterValues,
  mask: Uint8Array | null | undefined,
  factor: number,
): Uint8Array {
  const f = Math.floor(factor);
  if (!runner.draft || f < 2 || width < f * 2 || height < f * 2) return runPixelFilter(runner, pixels, width, height, values, mask);
  const small = downscale(pixels, width, height, f);
  const scaled: FilterValues = { ...values };
  for (const key of runner.draft.lengths ?? []) {
    const value = values[key];
    if (typeof value === 'number' && Number.isFinite(value)) scaled[key] = value / f;
  }
  for (const key of runner.draft.points ?? []) {
    const point = values[key] as { x?: unknown; y?: unknown } | null | undefined;
    if (typeof point?.x === 'number' && typeof point.y === 'number') scaled[key] = { x: (point.x + 0.5) / f - 0.5, y: (point.y + 0.5) / f - 0.5 };
  }
  const { width: sw, height: sh } = small;
  const filtered = runPixelFilter(runner, small.pixels, sw, sh, scaled, null);
  // Small pixels the filter changed, grown by one: the stretch reads each output pixel from its block and the next
  const changed = new Uint8Array(sw * sh);
  for (let p = 0, i = 0; p < changed.length; p++, i += 4) {
    const s = small.pixels;
    if (filtered[i] !== s[i] || filtered[i + 1] !== s[i + 1] || filtered[i + 2] !== s[i + 2] || filtered[i + 3] !== s[i + 3]) changed[p] = 1;
  }
  const output = upscale(filtered, sw, sh, width, height, f, { original: pixels, near: growByOne(changed, sw, sh) });
  blendFiltered(pixels, output, mask, false);
  return output;
}

/** 1 wherever `marks` has a 1 within one pixel (3 × 3) */
function growByOne(marks: Uint8Array, width: number, height: number) {
  const across = new Uint8Array(marks.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      across[row + x] = marks[row + x] | (x > 0 ? marks[row + x - 1] : 0) | (x + 1 < width ? marks[row + x + 1] : 0);
    }
  }
  const grown = new Uint8Array(marks.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      grown[row + x] = across[row + x] | (y > 0 ? across[row - width + x] : 0) | (y + 1 < height ? across[row + width + x] : 0);
    }
  }
  return grown;
}

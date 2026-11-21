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
import { adjustColor, grayscalePixels, levelsLut, mapChannels, thresholdPixels } from './color-filters';
import { changeLineWidth, despeckle, extractLines, recolorLines } from './lineart-filters';
import { boxBlur, glow, mosaic, outline, radialChromatic } from './effect-filters';
import { motionBlur, soften, spherize, unsharpMask, wave, zoomBlur } from './blur-distort-filters';

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

function spinBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, degrees: number, cx: number, cy: number) {
  const result = new Uint8Array(pixels.length);
  const samples = Array.from({ length: 13 }, (_, index) => {
    const angle = radians(degrees) * (index / 12 - 0.5);
    return [Math.cos(angle), Math.sin(angle)];
  });
  const sums = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sums.fill(0);
      for (const [cos, sin] of samples) {
        const sx = Math.round(cx + (x - cx) * cos - (y - cy) * sin);
        const sy = Math.round(cy + (x - cx) * sin + (y - cy) * cos);
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const src = (sy * width + sx) * 4;
        for (let k = 0; k < 4; k++) sums[k] += pixels[src + k];
      }
      const dst = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) result[dst + k] = Math.round(sums[k] / samples.length);
    }
  }
  return result;
}

/** Built-in filters. Each id matches an entry of the client's filter registry. */
export const PIXEL_FILTER_RUNNERS: Readonly<Record<string, PixelFilterRunner>> = {
  box: { run: ({ pixels, width, height }, v) => boxBlur(pixels, width, height, filterNumber(v, 'radius', 4)) },
  motionBlur: {
    run: ({ pixels, width, height }, v) => motionBlur(pixels, width, height, filterNumber(v, 'distance', 20), filterNumber(v, 'angle', 0),
      filterChoice(v, 'direction', ['both', 'forward', 'backward'] as const)),
  },
  radialBlur: {
    run: ({ pixels, width, height }, v) => {
      const center = filterPoint(v, 'center', width, height);
      return zoomBlur(pixels, width, height, center.x, center.y, filterNumber(v, 'strength', 30), filterChoice(v, 'direction', ['both', 'in', 'out'] as const));
    },
  },
  soften: { run: ({ pixels, width, height }) => soften(pixels, width, height) },
  wave: {
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
  gaussian: { run: (ctx, v) => applyGaussianBlur(ctx, filterNumber(v, 'radius', 8)) },
  spin: {
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
    run: ({ pixels, width, height }, v) =>
      glow(pixels, width, height, filterNumber(v, 'radius', 16), filterNumber(v, 'strength', 80), filterNumber(v, 'threshold', 160)),
  },
  outline: {
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
  for (let i = 0; i < output.length; i += 4) {
    const factor = mask ? mask[i / 4] / 255 : 1;
    const alpha = output[i + 3];
    for (let k = 0; k < 4; k++) {
      const filtered = runner.colorOnly && k < 3 ? output[i + k] * alpha / 255 : output[i + k];
      output[i + k] = Math.round(pixels[i + k] * (1 - factor) + filtered * factor);
    }
  }
  return output;
}

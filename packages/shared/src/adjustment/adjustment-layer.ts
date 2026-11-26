import { blendComponent } from '../filters/blend-modes';
import { buildCurveLUT, buildGradientLUT } from '../filters/pixel-filters';

export const ADJUSTMENT_KINDS = [
  'hsl', 'levels', 'curves', 'color_balance', 'gradient_map', 'brightness_contrast',
] as const;

export type AdjustmentKind = typeof ADJUSTMENT_KINDS[number];

export interface HslAdjustmentParams {
  hue: number;
  saturation: number;
  lightness: number;
  colorize: boolean;
}

export interface LevelsChannelParams {
  inBlack: number;
  inWhite: number;
  gamma: number;
  outBlack: number;
  outWhite: number;
}

export interface LevelsAdjustmentParams {
  master: LevelsChannelParams;
  red: LevelsChannelParams;
  green: LevelsChannelParams;
  blue: LevelsChannelParams;
}

export interface AdjustmentCurvePoint { x: number; y: number }

export interface CurvesAdjustmentParams {
  master: AdjustmentCurvePoint[];
  red: AdjustmentCurvePoint[];
  green: AdjustmentCurvePoint[];
  blue: AdjustmentCurvePoint[];
}

export interface ColorBalanceToneParams { cyanRed: number; magentaGreen: number; yellowBlue: number }

export interface ColorBalanceAdjustmentParams {
  shadows: ColorBalanceToneParams;
  midtones: ColorBalanceToneParams;
  highlights: ColorBalanceToneParams;
  preserveLuminosity: boolean;
}

export interface GradientMapStop { offset: number; color: string }
export interface GradientMapAdjustmentParams { stops: GradientMapStop[]; reverse: boolean }
export interface BrightnessContrastAdjustmentParams { brightness: number; contrast: number }

export type LayerAdjustment =
  | { kind: 'hsl'; params: HslAdjustmentParams }
  | { kind: 'levels'; params: LevelsAdjustmentParams }
  | { kind: 'curves'; params: CurvesAdjustmentParams }
  | { kind: 'color_balance'; params: ColorBalanceAdjustmentParams }
  | { kind: 'gradient_map'; params: GradientMapAdjustmentParams }
  | { kind: 'brightness_contrast'; params: BrightnessContrastAdjustmentParams };

const defaultLevels = (): LevelsChannelParams => ({
  inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255,
});
const defaultCurve = (): AdjustmentCurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const defaultBalance = (): ColorBalanceToneParams => ({ cyanRed: 0, magentaGreen: 0, yellowBlue: 0 });
const defaultStops = (): GradientMapStop[] => [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }];

export function createDefaultAdjustment(kind: AdjustmentKind): LayerAdjustment {
  switch (kind) {
    case 'hsl':
      return { kind, params: { hue: 0, saturation: 0, lightness: 0, colorize: false } };
    case 'levels':
      return { kind, params: { master: defaultLevels(), red: defaultLevels(), green: defaultLevels(), blue: defaultLevels() } };
    case 'curves':
      return { kind, params: { master: defaultCurve(), red: defaultCurve(), green: defaultCurve(), blue: defaultCurve() } };
    case 'color_balance':
      return { kind, params: { shadows: defaultBalance(), midtones: defaultBalance(), highlights: defaultBalance(), preserveLuminosity: true } };
    case 'gradient_map':
      return { kind, params: { stops: defaultStops(), reverse: false } };
    case 'brightness_contrast':
      return { kind, params: { brightness: 0, contrast: 0 } };
  }
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const clamp01 = (value: number): number => clamp(value, 0, 1);
const record = (raw: unknown): Record<string, unknown> | undefined =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
const booleanOr = (raw: unknown, fallback: boolean): boolean => typeof raw === 'boolean' ? raw : fallback;

function numberInRange(raw: unknown, fallback: number, min: number, max: number, scale?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const value = clamp(raw, min, max);
  const normalized = scale === undefined ? value : Math.round(value * scale) / scale;
  return normalized === 0 ? 0 : normalized;
}

function normalizeLevels(raw: unknown): LevelsChannelParams {
  const channel = record(raw);
  const inBlack = numberInRange(channel?.inBlack, 0, 0, 253, 1);
  return {
    inBlack,
    inWhite: Math.max(inBlack + 2, numberInRange(channel?.inWhite, 255, 0, 255, 1)),
    gamma: numberInRange(channel?.gamma, 1, 0.1, 9.99, 100),
    outBlack: numberInRange(channel?.outBlack, 0, 0, 255, 1),
    outWhite: numberInRange(channel?.outWhite, 255, 0, 255, 1),
  };
}

function normalizeBalance(raw: unknown): ColorBalanceToneParams {
  const tone = record(raw);
  return {
    cyanRed: numberInRange(tone?.cyanRed, 0, -100, 100),
    magentaGreen: numberInRange(tone?.magentaGreen, 0, -100, 100),
    yellowBlue: numberInRange(tone?.yellowBlue, 0, -100, 100),
  };
}

function normalizeControlPoints<T>(
  raw: unknown,
  defaults: T[],
  normalize: (entry: Record<string, unknown>, fallback: T) => T,
  position: (point: T) => number,
): T[] {
  if (!Array.isArray(raw)) return defaults;
  const points = new Map<number, T>();
  for (const [index, entry] of raw.entries()) {
    const fields = record(entry);
    if (!fields) continue;
    const point = normalize(fields, defaults[Math.min(index, defaults.length - 1)]);
    points.set(position(point), point);
  }
  if (points.size < 2) return defaults;
  return [...points.values()].sort((a, b) => position(a) - position(b)).slice(0, 16);
}

function normalizeCurve(raw: unknown): AdjustmentCurvePoint[] {
  return normalizeControlPoints(raw, defaultCurve(), (point, fallback) => ({
    x: numberInRange(point.x, fallback.x, 0, 255, 1),
    y: numberInRange(point.y, fallback.y, 0, 255, 1),
  }), (point) => point.x);
}

function normalizeColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return fallback;
  const color = raw.toLowerCase();
  return color.length === 4 ? color.replace(/[0-9a-f]/g, '$&$&') : color;
}

export function normalizeAdjustment(raw: unknown): LayerAdjustment | null {
  const adjustment = record(raw);
  const kind = adjustment?.kind;
  const params = record(adjustment?.params);
  switch (kind) {
    case 'hsl': {
      const colorize = booleanOr(params?.colorize, false);
      return { kind, params: {
        hue: numberInRange(params?.hue, 0, colorize ? 0 : -180, colorize ? 360 : 180),
        saturation: numberInRange(params?.saturation, 0, colorize ? 0 : -100, 100),
        lightness: numberInRange(params?.lightness, 0, -100, 100),
        colorize,
      } };
    }
    case 'levels':
      return { kind, params: {
        master: normalizeLevels(params?.master), red: normalizeLevels(params?.red),
        green: normalizeLevels(params?.green), blue: normalizeLevels(params?.blue),
      } };
    case 'curves':
      return { kind, params: {
        master: normalizeCurve(params?.master), red: normalizeCurve(params?.red),
        green: normalizeCurve(params?.green), blue: normalizeCurve(params?.blue),
      } };
    case 'color_balance':
      return { kind, params: {
        shadows: normalizeBalance(params?.shadows), midtones: normalizeBalance(params?.midtones),
        highlights: normalizeBalance(params?.highlights),
        preserveLuminosity: booleanOr(params?.preserveLuminosity, true),
      } };
    case 'gradient_map':
      return { kind, params: {
        stops: normalizeControlPoints(params?.stops, defaultStops(), (stop, fallback) => ({
          offset: numberInRange(stop.offset, fallback.offset, 0, 1, 1000),
          color: normalizeColor(stop.color, fallback.color),
        }), (stop) => stop.offset),
        reverse: booleanOr(params?.reverse, false),
      } };
    case 'brightness_contrast':
      return { kind, params: {
        brightness: numberInRange(params?.brightness, 0, -150, 150, 1),
        contrast: numberInRange(params?.contrast, 0, -50, 100, 1),
      } };
    default:
      return null;
  }
}

type Rgb = [number, number, number];

export interface CompiledAdjustment {
  kind: AdjustmentKind;
  program: 0 | 1 | 2 | 3;
  lut: Uint8Array;
  hsl: [number, number, number, number];
  cb: { shadows: Rgb; midtones: Rgb; highlights: Rgb; preserve: 0 | 1 };
  identity: boolean;
}

function channelLut(red: (v: number) => number, green = red, blue = red): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v++) {
    const offset = v * 4;
    lut[offset] = red(v);
    lut[offset + 1] = green(v);
    lut[offset + 2] = blue(v);
    lut[offset + 3] = 255;
  }
  return lut;
}

function levelsValue(v: number, channel: LevelsChannelParams): number {
  const t = clamp01((v - channel.inBlack) / (channel.inWhite - channel.inBlack)) ** (1 / channel.gamma);
  return Math.round(channel.outBlack + (channel.outWhite - channel.outBlack) * t);
}

function byteCurveLut(points: AdjustmentCurvePoint[]): Uint8Array {
  // Use normalized coordinates so the LUT helper interprets low byte values consistently.
  return buildCurveLUT(points.map(({ x, y }) => ({ x: x / 255, y: y / 255 })));
}

function isIdentityLut(lut: Uint8Array): boolean {
  for (let v = 0; v < 256; v++) {
    const i = v * 4;
    if (lut[i] !== v || lut[i + 1] !== v || lut[i + 2] !== v) return false;
  }
  return true;
}

function toneAmounts(tone: ColorBalanceToneParams): Rgb {
  return [tone.cyanRed / 100, tone.magentaGreen / 100, tone.yellowBlue / 100];
}

export function compileAdjustment(adj: LayerAdjustment): CompiledAdjustment {
  const { kind, params } = adj;
  const compiled: CompiledAdjustment = {
    kind, program: 0, lut: new Uint8Array(0), hsl: [0, 0, 0, 0], identity: false,
    cb: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserve: 0 },
  };
  switch (kind) {
    case 'hsl':
      compiled.program = 2;
      compiled.hsl = [params.hue / 360, params.saturation / 100, params.lightness / 100, params.colorize ? 1 : 0];
      compiled.identity = compiled.hsl.every((value) => value === 0);
      break;
    case 'levels': {
      const master = Uint8Array.from({ length: 256 }, (_, v) => levelsValue(v, params.master));
      compiled.lut = channelLut(
        (v) => levelsValue(master[v], params.red),
        (v) => levelsValue(master[v], params.green),
        (v) => levelsValue(master[v], params.blue),
      );
      break;
    }
    case 'curves': {
      const master = byteCurveLut(params.master);
      const red = byteCurveLut(params.red);
      const green = byteCurveLut(params.green);
      const blue = byteCurveLut(params.blue);
      compiled.lut = channelLut((v) => red[master[v]], (v) => green[master[v]], (v) => blue[master[v]]);
      break;
    }
    case 'color_balance':
      compiled.program = 1;
      compiled.cb = {
        shadows: toneAmounts(params.shadows), midtones: toneAmounts(params.midtones),
        highlights: toneAmounts(params.highlights), preserve: params.preserveLuminosity ? 1 : 0,
      };
      compiled.identity = [compiled.cb.shadows, compiled.cb.midtones, compiled.cb.highlights]
        .every((tone) => tone.every((value) => value === 0));
      break;
    case 'gradient_map': {
      compiled.program = 3;
      const lut = buildGradientLUT(params.stops);
      for (let v = 0; params.reverse && v < 128; v++) {
        const low = v * 4;
        const high = (255 - v) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const value = lut[low + ch];
          lut[low + ch] = lut[high + ch];
          lut[high + ch] = value;
        }
      }
      compiled.lut = lut;
      break;
    }
    case 'brightness_contrast': {
      const b = params.brightness / 300;
      const slant = Math.tan((params.contrast / 200 + 1) * Math.PI / 4);
      compiled.lut = channelLut((input) => {
        const v = input / 255;
        const bright = b < 0 ? v * (1 + b) : v + (1 - v) * b;
        return Math.round(clamp01((bright - 0.5) * slant + 0.5) * 255);
      });
      break;
    }
  }
  if (compiled.program === 0) compiled.identity = isIdentityLut(compiled.lut);
  if (compiled.program === 1 || compiled.program === 2) compiled.lut = channelLut((v) => v);
  return compiled;
}

export function isAdjustmentIdentity(adj: LayerAdjustment): boolean {
  return compileAdjustment(adj).identity;
}

const fract = (v: number): number => v - Math.floor(v);
const byteIndex = (v: number): number => Math.floor(v * 255 + 0.5);
const adjustLightness = (v: number, amount: number): number =>
  amount < 0 ? v * (1 + amount) : v + (1 - v) * amount;

function rgbToHsl([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, l];
  const s = delta / (1 - Math.abs(2 * l - 1));
  const sector = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
  return [fract(sector / 6), s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const m = l - chroma / 2;
  const sector = fract(h) * 6;
  const x = chroma * (1 - Math.abs(sector - 2 * Math.floor(sector / 2) - 1));
  const hi = clamp01(chroma + m);
  const mid = clamp01(x + m);
  const lo = clamp01(m);
  if (sector < 1) return [hi, mid, lo];
  if (sector < 2) return [mid, hi, lo];
  if (sector < 3) return [lo, hi, mid];
  if (sector < 4) return [lo, mid, hi];
  if (sector < 5) return [mid, lo, hi];
  return [hi, lo, mid];
}

function perceptualLuma([r, g, b]: Rgb): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function applyAdjustment(compiled: CompiledAdjustment, rgb: Rgb): Rgb {
  if (compiled.identity) return rgb;
  const { lut, hsl, cb } = compiled;
  const [r, g, b] = rgb;
  switch (compiled.program) {
    case 0:
      return [lut[byteIndex(r) * 4] / 255, lut[byteIndex(g) * 4 + 1] / 255, lut[byteIndex(b) * 4 + 2] / 255];
    case 1: {
      const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
      const a = 0.25, center = 0.333, k = 0.7;
      const shadows = clamp01((l - center) / -a + 0.5) * k;
      const midtones = clamp01((l - center) / a + 0.5) * clamp01((l + center - 1) / -a + 0.5) * k;
      const highlights = clamp01((l + center - 1) / a + 0.5) * k;
      const result: Rgb = [r, g, b];
      for (let ch = 0; ch < 3; ch++) {
        result[ch] = clamp01(result[ch] + cb.shadows[ch] * shadows + cb.midtones[ch] * midtones + cb.highlights[ch] * highlights);
      }
      if (!cb.preserve) return result;
      const [h, s] = rgbToHsl(result);
      return hslToRgb(h, s, l);
    }
    case 2: {
      const [hue, saturation, lightness, colorize] = hsl;
      if (colorize) return hslToRgb(hue, saturation, adjustLightness(perceptualLuma(rgb), lightness));
      const [h, s, l] = rgbToHsl(rgb);
      return hslToRgb(fract(h + hue), clamp01(s * (1 + saturation)), adjustLightness(l, lightness));
    }
    case 3: {
      const offset = Math.floor(perceptualLuma([r * 255, g * 255, b * 255]) + 0.5) * 4;
      return [lut[offset] / 255, lut[offset + 1] / 255, lut[offset + 2] / 255];
    }
  }
}

export function applyCompiledAdjustmentRgb(compiled: CompiledAdjustment, r: number, g: number, b: number): Rgb {
  const result = applyAdjustment(compiled, [r / 255, g / 255, b / 255]);
  return [byteIndex(clamp01(result[0])), byteIndex(clamp01(result[1])), byteIndex(clamp01(result[2]))];
}

export const ADJUSTMENT_BLEND_MODE_IDS: Record<string, number> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4, linear_dodge: 4,
  color_dodge: 5, color_burn: 6, linear_burn: 7, darken: 8, lighten: 9, glow: 10,
  vivid_light: 11, linear_light: 12, pin_light: 13, hard_mix: 14, divide: 15, hard_light: 16,
  soft_light: 17, difference: 18, exclusion: 19, subtract: 20, hue: 21, saturation: 22,
  color: 23, luminosity: 24, darker_color: 25, lighter_color: 26,
};

function normalizeBlendMode(mode: string): string {
  const normalized = mode.toLowerCase().replace(/-/g, '_');
  return Object.hasOwn(ADJUSTMENT_BLEND_MODE_IDS, normalized) ? normalized : 'normal';
}

export function adjustmentBlendModeId(mode: string): number {
  return ADJUSTMENT_BLEND_MODE_IDS[normalizeBlendMode(mode)];
}

const lum = ([r, g, b]: Rgb): number => 0.3 * r + 0.59 * g + 0.11 * b;
const sat = (rgb: Rgb): number => Math.max(...rgb) - Math.min(...rgb);

function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const min = Math.min(...c);
  const max = Math.max(...c);
  if (min < 0) c = c.map((v) => l + (v - l) * l / (l - min)) as Rgb;
  if (max > 1) c = c.map((v) => l + (v - l) * (1 - l) / (max - l)) as Rgb;
  return c;
}

function setLum(c: Rgb, l: number): Rgb {
  const delta = l - lum(c);
  return clipColor([c[0] + delta, c[1] + delta, c[2] + delta]);
}

function setSat(c: Rgb, s: number): Rgb {
  const min = Math.min(...c);
  const range = Math.max(...c) - min;
  if (range === 0) return [0, 0, 0];
  return [(c[0] - min) * s / range, (c[1] - min) * s / range, (c[2] - min) * s / range];
}

function blendRgb(src: Rgb, dst: Rgb, mode: string): Rgb {
  switch (mode) {
    case 'normal': return src;
    case 'hue': return setLum(setSat(src, sat(dst)), lum(dst));
    case 'saturation': return setLum(setSat(dst, sat(src)), lum(dst));
    case 'color': return setLum(src, lum(dst));
    case 'luminosity': return setLum(dst, lum(src));
    case 'darker_color': return lum(src) < lum(dst) ? src : dst;
    case 'lighter_color': return lum(src) > lum(dst) ? src : dst;
    default: return [
      blendComponent(src[0], dst[0], mode),
      blendComponent(src[1], dst[1], mode),
      blendComponent(src[2], dst[2], mode),
    ];
  }
}

export function blendAdjustmentRgb(src: Rgb, dst: Rgb, mode: string): Rgb {
  return blendRgb(src, dst, normalizeBlendMode(mode));
}

type PixelBytes = Uint8ClampedArray | Uint8Array;

export interface AdjustmentStepInput {
  width: number;
  height: number;
  target: PixelBytes;
  scope: PixelBytes | null;
  coverage: PixelBytes | null;
  opacity: number;
  compiled: CompiledAdjustment;
  blendMode: string;
  premultiplied?: boolean;
}

export function applyAdjustmentStep(input: AdjustmentStepInput): void {
  const { width, height, target, scope, coverage, compiled, premultiplied = false } = input;
  const opacity = clamp01(input.opacity);
  if (compiled.identity || !(opacity > 0)) return;
  const mode = normalizeBlendMode(input.blendMode);
  const source = scope ?? target;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const i = pixel * 4;
    const alpha = target[i + 3];
    const sourceAlpha = source[i + 3];
    const k = coverage ? opacity * (coverage[pixel] / 255) : opacity;
    if (alpha === 0 || sourceAlpha === 0 || k === 0) continue;

    const scale = premultiplied ? sourceAlpha : 255;
    const rgb: Rgb = [source[i] / scale, source[i + 1] / scale, source[i + 2] / scale];
    const adjusted = blendRgb(applyAdjustment(compiled, rgb), rgb, mode);
    if (!scope) {
      for (let ch = 0; ch < 3; ch++) {
        target[i + ch] = Math.round(clamp01(rgb[ch] + (adjusted[ch] - rgb[ch]) * k) * scale);
      }
      continue;
    }

    const targetScale = premultiplied ? 1 : alpha / 255;
    for (let ch = 0; ch < 3; ch++) {
      const base = target[i + ch] * targetScale;
      const delta = (adjusted[ch] - rgb[ch]) * k * sourceAlpha;
      target[i + ch] = Math.round(clamp(base + delta, 0, alpha) / targetScale);
    }
  }
}

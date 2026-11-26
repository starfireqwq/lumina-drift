/**
 * Brush Engine v2 Dynamics & Mixing Definitions
 * Shared pure types and deterministic math for pressure, tilt, velocity, and random jitter dynamics.
 * Existing stabilizer algorithms are intentionally kept untouched.
 */

export interface BrushDynamicChannel {
  /** Modulate parameter by pen pressure (0..1) */
  pressure?: boolean;
  /** Modulate parameter by pen tilt (0 upright .. 1 flat) */
  tilt?: boolean;
  /** Modulate parameter by stroke velocity (0 slow .. 1 fast) */
  velocity?: boolean;
  /** When velocity is enabled, invert so faster strokes decrease the value instead of increasing */
  velocityInvert?: boolean;
  /** Per-dab random jitter strength (0..1) */
  random?: number;
  /** Minimum output floor (0..1) when modulated by dynamics */
  min?: number;
}

export interface BrushDynamicsConfig {
  /** Tip diameter dynamics */
  size?: BrushDynamicChannel;
  /** Stroke opacity dynamics (pressure / tilt / velocity / random + min floor) */
  opacity?: BrushDynamicChannel;
  /** Per-dab flow / paint density dynamics */
  flow?: BrushDynamicChannel;
  /** Tip angle jitter (random 0..1 maps to +/- 180 deg) & optional tilt/velocity modulation */
  angle?: BrushDynamicChannel;
  /** Scatter amplitude modulation */
  scatter?: BrushDynamicChannel;
  /** Foreground-to-secondary color mix dynamics (pressure / tilt / velocity / random) */
  colorMix?: BrushDynamicChannel;
}

export type BrushMixMode = 'blend' | 'smudge' | 'dilute';
export type BrushTextureBlendMode = 'subtract' | 'multiply' | 'overlay';
export type DualBrushBlendMode = 'multiply' | 'subtract' | 'darken' | 'screen' | 'overlay';
export type DualTipShape = 'same' | 'round' | 'soft' | 'speckle' | 'bristle' | 'square' | 'custom';
export type BrushTipPlayMode = 'single' | 'sequential' | 'random' | 'randomNoRepeat';
export type ColorDynamicsScope = 'perDab' | 'perStroke';

export interface BrushColorDynamicsConfig {
  scope?: ColorDynamicsScope;
  hueJitter?: number;
  saturationJitter?: number;
  lightnessJitter?: number;
  huePressure?: number;
  saturationPressure?: number;
  lightnessPressure?: number;
  hueGradient?: number;
  saturationGradient?: number;
  lightnessGradient?: number;
  gradientLength?: number;
  fgBgMix?: number;
  fgBgGradient?: boolean;
}

interface LegacyColorDynamics {
  hueJitter?: number;
  satJitter?: number;
  valJitter?: number;
  fgBgMix?: number;
}

interface BrushRgb {
  r: number;
  g: number;
  b: number;
}

interface BrushColorDynamicsInput {
  pressure: number;
  strokeProgress: number;
  randH: number;
  randS: number;
  randL: number;
  randMix: number;
  strokeRandH: number;
  strokeRandS: number;
  strokeRandL: number;
  strokeRandMix: number;
  fgBgChannel?: BrushDynamicChannel;
  tilt?: number;
  velocity?: number;
  mixColor?: (a: BrushRgb, b: BrushRgb, t: number) => BrushRgb;
}

export interface BrushDynamicInput {
  /** Curve-mapped pen pressure (0..1) */
  pressure: number;
  /** Normalized pen tilt (0 upright .. 1 flat) */
  tilt: number;
  /** Normalized stroke speed (0 slow .. 1 fast) */
  velocity: number;
  /** Uniform random value in [0, 1) for this dab */
  rand: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const finiteOr = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const colorJitterKeys = ['hueJitter', 'saturationJitter', 'lightnessJitter', 'fgBgMix'] as const;
const colorModulationKeys = [
  'huePressure', 'saturationPressure', 'lightnessPressure',
  'hueGradient', 'saturationGradient', 'lightnessGradient',
] as const;

export function normalizeColorDynamics(cfg?: BrushColorDynamicsConfig | null): BrushColorDynamicsConfig | undefined {
  if (!cfg || typeof cfg !== 'object') return undefined;
  const out: BrushColorDynamicsConfig = {};
  if (cfg.scope === 'perDab' || cfg.scope === 'perStroke') out.scope = cfg.scope;
  if (typeof cfg.fgBgGradient === 'boolean') out.fgBgGradient = cfg.fgBgGradient;

  for (const key of colorJitterKeys) {
    const value = cfg[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = clamp01(value);
  }
  for (const key of colorModulationKeys) {
    const value = cfg[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = clamp(value, -1, 1);
  }
  const length = cfg.gradientLength;
  if (typeof length === 'number' && Number.isFinite(length)) {
    out.gradientLength = clamp(length, 50, 4000);
  } else if (out.hueGradient || out.saturationGradient || out.lightnessGradient || out.fgBgGradient) {
    out.gradientLength = 400;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function hasActiveColorDynamics(cfg?: BrushColorDynamicsConfig | null, legacy?: LegacyColorDynamics): boolean {
  return clamp01(cfg?.hueJitter ?? legacy?.hueJitter ?? 0) > 0
    || clamp01(cfg?.saturationJitter ?? legacy?.satJitter ?? 0) > 0
    || clamp01(cfg?.lightnessJitter ?? legacy?.valJitter ?? 0) > 0
    || clamp01(cfg?.fgBgMix ?? legacy?.fgBgMix ?? 0) > 0
    || cfg?.fgBgGradient === true
    || colorModulationKeys.some((key) => finiteOr(cfg?.[key], 0) !== 0);
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const red = clamp01(r / 255);
  const green = clamp01(g / 255);
  const blue = clamp01(b / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  const l = (max + min) / 2;
  if (chroma === 0) return { h: 0, s: 0, l };

  let hue;
  if (max === red) hue = (green - blue) / chroma;
  else if (max === green) hue = (blue - red) / chroma + 2;
  else hue = (red - green) / chroma + 4;
  const s = clamp01(chroma / (1 - Math.abs(2 * l - 1)));
  return { h: (hue * 60 + 360) % 360, s, l };
}

export function hslToRgb(h: number, s: number, l: number): BrushRgb {
  const hue = ((finiteOr(h, 0) % 360) + 360) % 360;
  const lightness = clamp01(l);
  const amplitude = clamp01(s) * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    return Math.round(255 * (lightness - amplitude * clamp(Math.min(k - 3, 9 - k), -1, 1)));
  };
  return { r: channel(0), g: channel(8), b: channel(4) };
}

export function selectBrushTipIndex(
  tipCount: number, mode: BrushTipPlayMode, dabIndex: number, prevIndex: number, rand: number,
): number {
  if (tipCount <= 1 || mode === 'single') return 0;
  if (mode === 'sequential') return ((dabIndex % tipCount) + tipCount) % tipCount;

  if (mode === 'randomNoRepeat' && Number.isInteger(prevIndex) && prevIndex >= 0 && prevIndex < tipCount) {
    const index = Math.min(tipCount - 2, Math.floor(clamp01(rand) * (tipCount - 1)));
    return index >= prevIndex ? index + 1 : index;
  }
  return Math.min(tipCount - 1, Math.floor(clamp01(rand) * tipCount));
}

export function evaluateColorDynamics(
  baseRgb: BrushRgb,
  secondaryRgb: BrushRgb | null,
  cfg: BrushColorDynamicsConfig | undefined,
  input: BrushColorDynamicsInput,
  legacy?: LegacyColorDynamics,
): BrushRgb {
  const perStroke = cfg?.scope === 'perStroke';
  const pressure = clamp01(input.pressure);
  const progress = clamp01(input.strokeProgress);
  let rgb = baseRgb;

  if (secondaryRgb) {
    const amount = clamp01(cfg?.fgBgMix ?? legacy?.fgBgMix ?? 0);
    const gradient = cfg?.fgBgGradient === true;
    const strength = gradient ? progress * (amount || 1) : amount;
    const mixInput = {
      pressure,
      tilt: input.tilt ?? 0,
      velocity: input.velocity ?? 0,
      rand: perStroke ? input.strokeRandMix : input.randMix,
    };
    const ratio = gradient && !hasActiveDynamicSource(input.fgBgChannel)
      ? strength
      : evaluateFgBgMixRatio(strength, input.fgBgChannel, mixInput);
    if (ratio > 0) {
      rgb = input.mixColor ? input.mixColor(baseRgb, secondaryRgb, ratio) : {
        r: baseRgb.r + (secondaryRgb.r - baseRgb.r) * ratio,
        g: baseRgb.g + (secondaryRgb.g - baseRgb.g) * ratio,
        b: baseRgb.b + (secondaryRgb.b - baseRgb.b) * ratio,
      };
    }
  }

  const pressureOffset = (pressure - 0.5) * 2;
  const offset = (rand: number, jitter: number, pressureMod?: number, gradientMod?: number): number =>
    (clamp01(rand) * 2 - 1) * clamp01(jitter)
    + pressureOffset * clamp(finiteOr(pressureMod, 0), -1, 1)
    + progress * clamp(finiteOr(gradientMod, 0), -1, 1);
  const hue = offset(perStroke ? input.strokeRandH : input.randH,
    cfg?.hueJitter ?? legacy?.hueJitter ?? 0, cfg?.huePressure, cfg?.hueGradient);
  const saturation = offset(perStroke ? input.strokeRandS : input.randS,
    cfg?.saturationJitter ?? legacy?.satJitter ?? 0, cfg?.saturationPressure, cfg?.saturationGradient);
  const lightness = offset(perStroke ? input.strokeRandL : input.randL,
    cfg?.lightnessJitter ?? legacy?.valJitter ?? 0, cfg?.lightnessPressure, cfg?.lightnessGradient);

  if (hue === 0 && saturation === 0 && lightness === 0) {
    return {
      r: Math.round(clamp01(rgb.r / 255) * 255),
      g: Math.round(clamp01(rgb.g / 255) * 255),
      b: Math.round(clamp01(rgb.b / 255) * 255),
    };
  }
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return hslToRgb(h + hue * 180, s + saturation, l + lightness * 0.5);
}

export function computeWetEdgeParams(
  strength?: number, width?: number, darkness?: number, baseRgb?: BrushRgb,
): { innerScale: number; innerEraseAlpha: number; rimAlpha: number; rimRgb: BrushRgb } {
  const edgeStrength = clamp01(finiteOr(strength, 0.55));
  const edgeWidth = clamp(finiteOr(width, 0.22), 0.05, 0.5);
  const edgeDarkness = clamp01(finiteOr(darkness, 0.35));
  const { h, s, l } = baseRgb ? rgbToHsl(baseRgb.r, baseRgb.g, baseRgb.b) : { h: 0, s: 0, l: 0 };

  return {
    innerScale: clamp(1 - edgeWidth * 1.1, 0.42, 0.94),
    innerEraseAlpha: clamp(edgeStrength * 0.58, 0, 0.65),
    rimAlpha: clamp(edgeStrength * edgeDarkness * 0.65, 0, 0.6),
    rimRgb: hslToRgb(h, s + edgeDarkness * 0.14, l - edgeDarkness * 0.26),
  };
}

/**
 * Normalizes and clamps a single dynamic channel so untrusted/imported presets stay in safe bounds.
 */
export function normalizeDynamicChannel(ch?: BrushDynamicChannel | null): BrushDynamicChannel | undefined {
  if (!ch || typeof ch !== 'object') return undefined;
  const out: BrushDynamicChannel = {};
  if (typeof ch.pressure === 'boolean') out.pressure = ch.pressure;
  if (typeof ch.tilt === 'boolean') out.tilt = ch.tilt;
  if (typeof ch.velocity === 'boolean') out.velocity = ch.velocity;
  if (typeof ch.velocityInvert === 'boolean') out.velocityInvert = ch.velocityInvert;
  if (typeof ch.random === 'number' && Number.isFinite(ch.random)) out.random = clamp01(ch.random);
  if (typeof ch.min === 'number' && Number.isFinite(ch.min)) out.min = clamp01(ch.min);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalizes a full BrushDynamicsConfig object.
 */
export function normalizeBrushDynamics(cfg?: BrushDynamicsConfig | null): BrushDynamicsConfig | undefined {
  if (!cfg || typeof cfg !== 'object') return undefined;
  const out: BrushDynamicsConfig = {};
  const size = normalizeDynamicChannel(cfg.size);
  const opacity = normalizeDynamicChannel(cfg.opacity);
  const flow = normalizeDynamicChannel(cfg.flow);
  const angle = normalizeDynamicChannel(cfg.angle);
  const scatter = normalizeDynamicChannel(cfg.scatter);
  const colorMix = normalizeDynamicChannel(cfg.colorMix);
  if (size) out.size = size;
  if (opacity) out.opacity = opacity;
  if (flow) out.flow = flow;
  if (angle) out.angle = angle;
  if (scatter) out.scatter = scatter;
  if (colorMix) out.colorMix = colorMix;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Checks whether a dynamic channel has any active modulation source.
 */
export function hasActiveDynamicSource(ch?: BrushDynamicChannel | null): boolean {
  if (!ch) return false;
  return Boolean(ch.pressure || ch.tilt || ch.velocity || (ch.random ?? 0) > 0);
}

/**
 * Evaluates a dynamic channel into a normalized multiplier in [min, 1].
 * Multiple enabled input controllers combine multiplicatively, then random jitter scales within [min, 1].
 */
export function evaluateDynamicChannel(
  ch: BrushDynamicChannel | undefined,
  input: BrushDynamicInput,
  fallbackValue = 1
): number {
  if (!ch || !hasActiveDynamicSource(ch)) {
    return clamp01(fallbackValue);
  }
  const min = clamp01(ch.min ?? 0);
  let factor = 1;
  let hasController = false;

  if (ch.pressure) {
    factor *= clamp01(input.pressure);
    hasController = true;
  }
  if (ch.tilt) {
    factor *= clamp01(input.tilt);
    hasController = true;
  }
  if (ch.velocity) {
    const vel = clamp01(input.velocity);
    factor *= ch.velocityInvert ? 1 - vel : vel;
    hasController = true;
  }

  let value = hasController ? min + (1 - min) * factor : 1;

  const jitter = clamp01(ch.random ?? 0);
  if (jitter > 0) {
    const r = clamp01(input.rand);
    const jittered = value * (1 - jitter * r);
    value = Math.max(min, jittered);
  }

  return clamp01(value);
}

/**
 * Evaluates an angular jitter offset in radians based on channel random/tilt/velocity settings.
 */
export function evaluateAngleJitterRadians(
  ch: BrushDynamicChannel | undefined,
  input: BrushDynamicInput
): number {
  if (!ch) return 0;
  let offset = 0;
  const jitter = clamp01(ch.random ?? 0);
  if (jitter > 0) {
    offset += (clamp01(input.rand) * 2 - 1) * Math.PI * jitter;
  }
  if (ch.pressure) {
    offset += (clamp01(input.pressure) - 0.5) * Math.PI * 0.5;
  }
  if (ch.tilt) {
    offset += clamp01(input.tilt) * Math.PI * 0.5;
  }
  return offset;
}

/**
 * Evaluates foreground-to-secondary mix ratio in [0, 1].
 * 0 = pure foreground color, 1 = pure secondary color.
 */
export function evaluateFgBgMixRatio(
  baseAmount: number,
  ch: BrushDynamicChannel | undefined,
  input: BrushDynamicInput
): number {
  const strength = clamp01(baseAmount);
  if (strength <= 0) return 0;
  if (!ch || !hasActiveDynamicSource(ch)) {
    // Default behavior when fgBgMix > 0 without explicit channel: follow pressure
    return clamp01(strength * clamp01(input.pressure));
  }
  const mod = evaluateDynamicChannel(ch, input, 1);
  return clamp01(strength * mod);
}

/**
 * Computes the effective default BrushDynamicsConfig for brushes that predate v2 settings,
 * matching their legacy behavior so UI toggles accurately reflect current brush response.
 */
export function resolveDefaultBrushDynamics(opts: {
  brushType?: string;
  isEraser?: boolean;
  hardness?: number;
  flow?: number;
  colorMixing?: number;
  size?: number;
  minSize?: number;
  antiAlias?: string;
}): BrushDynamicsConfig {
  const sizeRatio = opts.size && opts.size > 0
    ? clamp01((opts.minSize ?? 0) / opts.size)
    : 0;

  if (opts.isEraser) {
    return {
      size: { pressure: true, min: sizeRatio },
      opacity: { pressure: false, min: 0 },
      flow: { pressure: false, min: 0 },
      angle: { random: 0 },
      scatter: { pressure: false, random: 0 },
      colorMix: { pressure: false, random: 0 },
    };
  }

  const explicitAirbrush = opts.brushType === 'airbrush';
  if (opts.antiAlias === 'none' && !explicitAirbrush) {
    return {
      size: { pressure: true, min: sizeRatio },
      opacity: { pressure: false, min: 1 },
      flow: { pressure: false, min: 1 },
      angle: { random: 0 },
      scatter: { pressure: false, random: 0 },
      colorMix: { pressure: false, random: 0 },
    };
  }

  const isInkingPen =
    opts.brushType !== 'pencil' &&
    (opts.brushType === 'pen' ||
      ((opts.hardness ?? 0.8) >= 0.92 && (opts.colorMixing ?? 0) === 0 && (opts.flow ?? 1) >= 0.98));

  return {
    size: { pressure: true, min: sizeRatio },
    opacity: {
      pressure: !isInkingPen,
      min: isInkingPen ? 0.78 : 0,
    },
    flow: { pressure: false, min: 0 },
    angle: { random: 0 },
    scatter: { pressure: false, random: 0 },
    colorMix: { pressure: false, random: 0 },
  };
}

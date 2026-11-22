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
export type DualBrushBlendMode = 'multiply' | 'subtract' | 'darken';

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

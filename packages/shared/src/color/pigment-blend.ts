/**
 * OKLab & Subtractive Pigment Color Blending Engine
 *
 * Implements perceptual OKLab color space transformations and
 * realistic subtractive pigment mixing (inspired by Kubelka-Munk & Mixbox).
 *
 * Standard RGB averaging produces muddy grey when mixing Yellow and Blue.
 * This pigment model accurately models physical paint absorption:
 * Yellow + Blue = Natural Brilliant Green!
 */

export interface RgbColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
  a?: number; // 0..1
}

export type PigmentBlendModel = 'rgb' | 'oklab' | 'subtractive';

export interface PigmentReservoirStepOptions {
  mixMode: 'blend' | 'smudge' | 'dilute';
  pigmentBlendMode?: PigmentBlendModel;
  pigmentStrength?: number;
  colorMixing: number;
  paintAmount: number;
  colorStretch: number;
  pressure: number;
  sampledAlpha: number;
  strokeDistancePx?: number;
  chargeDepletion?: number;
  hasSampledSmudge?: boolean;
}

export interface OklabColor {
  L: number; // Lightness: 0..1
  a: number; // Green-Red chromaticity: ~ -0.4 .. 0.4
  b: number; // Blue-Yellow chromaticity: ~ -0.4 .. 0.4
}

/**
 * Parses Hex color string (#RGB, #RRGGBB, #RRGGBBAA) to RgbColor (0..255)
 */
export function hexToRgb(hex: string): RgbColor {
  let cleaned = hex.trim().replace(/^#/, '');
  if (cleaned.length === 3) {
    cleaned = cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2];
  } else if (cleaned.length === 4) {
    cleaned = cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2] + cleaned[3] + cleaned[3];
  }

  const num = parseInt(cleaned, 16);
  if (cleaned.length === 8) {
    return {
      r: (num >> 24) & 255,
      g: (num >> 16) & 255,
      b: (num >> 8) & 255,
      a: (num & 255) / 255,
    };
  }

  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
    a: 1.0,
  };
}

/**
 * Converts RgbColor to standard Hex string (#RRGGBB)
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const cr = Math.max(0, Math.min(255, Math.round(r))).toString(16).padStart(2, '0');
  const cg = Math.max(0, Math.min(255, Math.round(g))).toString(16).padStart(2, '0');
  const cb = Math.max(0, Math.min(255, Math.round(b))).toString(16).padStart(2, '0');
  return `#${cr}${cg}${cb}`;
}

/**
 * Converts standard sRGB [0..1] component to linear sRGB
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Converts linear sRGB component to standard sRGB [0..1]
 */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1.0 / 2.4) - 0.055;
}

/**
 * Converts sRGB [0..255] to OKLab (L, a, b)
 */
export function rgbToOklab(r: number, g: number, b: number): OklabColor {
  const lr = srgbToLinear(Math.max(0, Math.min(255, r)) / 255);
  const lg = srgbToLinear(Math.max(0, Math.min(255, g)) / 255);
  const lb = srgbToLinear(Math.max(0, Math.min(255, b)) / 255);

  // Approximate cone responses (LMS)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073999567 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * Converts OKLab (L, a, b) to sRGB [0..255]
 */
export function oklabToRgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: Math.round(Math.max(0, Math.min(255, linearToSrgb(lr) * 255))),
    g: Math.round(Math.max(0, Math.min(255, linearToSrgb(lg) * 255))),
    b: Math.round(Math.max(0, Math.min(255, linearToSrgb(lb) * 255))),
  };
}

/**
 * Realistic Pigment Subtractive Blending (Mixbox / Subtractive Absorption Model)
 *
 * In physical paint, colors act as subtractive filters:
 * Yellow absorbs Blue (passes Red & Green).
 * Blue absorbs Red & Green (passes Blue & Green).
 * When combined, Blue & Red are absorbed, leaving rich GREEN.
 *
 * @param c1 Base color (0..255)
 * @param c2 Mixing color (0..255)
 * @param t Mixing weight (0.0 = 100% c1, 1.0 = 100% c2)
 */
export function mixPigmentSubtractive(c1: RgbColor, c2: RgbColor, t: number): RgbColor {
  const clampT = Math.max(0.0, Math.min(1.0, t));
  if (clampT <= 0.0) return { ...c1 };
  if (clampT >= 1.0) return { ...c2 };

  // Smooth Hermite interpolation curve for continuous smooth transition (no abrupt stepping)
  const smoothT = clampT * clampT * (3.0 - 2.0 * clampT);

  // Normalize to linear reflectance space
  const r1 = Math.max(0.005, srgbToLinear(c1.r / 255));
  const g1 = Math.max(0.005, srgbToLinear(c1.g / 255));
  const b1 = Math.max(0.005, srgbToLinear(c1.b / 255));

  const r2 = Math.max(0.005, srgbToLinear(c2.r / 255));
  const g2 = Math.max(0.005, srgbToLinear(c2.g / 255));
  const b2 = Math.max(0.005, srgbToLinear(c2.b / 255));

  // Compute optical absorption densities (Beer-Lambert model: D = -ln(R))
  const dR1 = -Math.log(r1);
  const dG1 = -Math.log(g1);
  const dB1 = -Math.log(b1);

  const dR2 = -Math.log(r2);
  const dG2 = -Math.log(g2);
  const dB2 = -Math.log(b2);

  // Pigment absorption blends additively weighted by smoothT
  const dR_mix = (1.0 - smoothT) * dR1 + smoothT * dR2;
  const dG_mix = (1.0 - smoothT) * dG1 + smoothT * dG2;
  const dB_mix = (1.0 - smoothT) * dB1 + smoothT * dB2;

  // Mixed linear reflectance
  let r_sub = Math.exp(-dR_mix);
  let g_sub = Math.exp(-dG_mix);
  let b_sub = Math.exp(-dB_mix);

  // Luminance balance via OKLab perceptual target:
  // Prevents subtractive absorption from becoming unnaturally dark at 50%
  const lab1 = rgbToOklab(c1.r, c1.g, c1.b);
  const lab2 = rgbToOklab(c2.r, c2.g, c2.b);
  const targetL = (1.0 - smoothT) * lab1.L + smoothT * lab2.L;

  // Intermediate OKLab of the subtractive result
  const srgbR = linearToSrgb(r_sub) * 255;
  const srgbG = linearToSrgb(g_sub) * 255;
  const srgbB = linearToSrgb(b_sub) * 255;
  const labSub = rgbToOklab(srgbR, srgbG, srgbB);

  // Boost lightness towards perceptual target smoothly
  const adjustedL = Math.max(labSub.L, (labSub.L * 0.5) + (targetL * 0.5));
  const finalRgb = oklabToRgb(adjustedL, labSub.a, labSub.b);

  const a1 = c1.a !== undefined ? c1.a : 1.0;
  const a2 = c2.a !== undefined ? c2.a : 1.0;
  const finalA = (1.0 - smoothT) * a1 + smoothT * a2;

  return {
    r: finalRgb.r,
    g: finalRgb.g,
    b: finalRgb.b,
    a: finalA,
  };
}

/**
 * Standard OKLab perceptual linear blend
 */
export function mixOklab(c1: RgbColor, c2: RgbColor, t: number): RgbColor {
  const clampT = Math.max(0.0, Math.min(1.0, t));
  const lab1 = rgbToOklab(c1.r, c1.g, c1.b);
  const lab2 = rgbToOklab(c2.r, c2.g, c2.b);

  const L = (1.0 - clampT) * lab1.L + clampT * lab2.L;
  const a = (1.0 - clampT) * lab1.a + clampT * lab2.a;
  const b = (1.0 - clampT) * lab1.b + clampT * lab2.b;

  const rgb = oklabToRgb(L, a, b);
  const a1 = c1.a !== undefined ? c1.a : 1.0;
  const a2 = c2.a !== undefined ? c2.a : 1.0;

  return {
    r: rgb.r,
    g: rgb.g,
    b: rgb.b,
    a: (1.0 - clampT) * a1 + clampT * a2,
  };
}

const clamp01 = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function mixRgb(c1: RgbColor, c2: RgbColor, t: number): RgbColor {
  const a1 = c1.a ?? 1;
  const a2 = c2.a ?? 1;
  return {
    r: c1.r + (c2.r - c1.r) * t,
    g: c1.g + (c2.g - c1.g) * t,
    b: c1.b + (c2.b - c1.b) * t,
    a: a1 + (a2 - a1) * t,
  };
}

export function blendPigmentColors(
  c1: RgbColor,
  c2: RgbColor,
  t: number,
  model: PigmentBlendModel = 'subtractive',
  pigmentStrength = 0.85,
): RgbColor {
  const ratio = clamp01(t);
  if (model === 'rgb') return mixRgb(c1, c2, ratio);
  if (model === 'oklab') return mixOklab(c1, c2, ratio);

  const strength = clamp01(pigmentStrength);
  if (strength >= 0.999) return mixPigmentSubtractive(c1, c2, ratio);
  const perceptual = mixOklab(c1, c2, ratio);
  if (strength === 0) return perceptual;
  return mixRgb(perceptual, mixPigmentSubtractive(c1, c2, ratio), strength);
}

function sameColor(c1: RgbColor, c2: RgbColor): boolean {
  return c1.r === c2.r && c1.g === c2.g && c1.b === c2.b && (c1.a ?? 1) === (c2.a ?? 1);
}

export function stepPigmentReservoir(
  reservoir: RgbColor | null,
  foreground: RgbColor,
  sampledCanvas: RgbColor | null,
  opts: PigmentReservoirStepOptions,
): { nextReservoir: RgbColor; dabColor: RgbColor; alphaMultiplier: number; smudgeSampled: boolean; skipDab: boolean } {
  const { mixMode, pigmentBlendMode, pigmentStrength } = opts;
  const colorMixing = clamp01(opts.colorMixing);
  const paintAmount = clamp01(opts.paintAmount);
  const colorStretch = clamp01(opts.colorStretch);
  const pressure = clamp01(opts.pressure);
  const sampledAlpha = clamp01(opts.sampledAlpha);
  let nextReservoir = reservoir ?? foreground;
  let smudgeSampled = opts.hasSampledSmudge ?? false;

  if (sampledCanvas && sampledAlpha > 0) {
    if (mixMode === 'smudge' && !smudgeSampled) {
      nextReservoir = sampledCanvas;
      smudgeSampled = true;
    } else {
      const pressureBias = mixMode === 'smudge' ? 1 : 1 - pressure * 0.5;
      const pickup = Math.min(0.95, colorMixing * sampledAlpha * (1 - colorStretch * 0.36)
        * pressureBias * (mixMode === 'dilute' ? 0.9 : 0.75));
      if (pickup > 0 && !sameColor(nextReservoir, sampledCanvas)) {
        nextReservoir = blendPigmentColors(nextReservoir, sampledCanvas, pickup, pigmentBlendMode, pigmentStrength);
      }
    }
  }
  if (mixMode !== 'smudge') {
    const reload = paintAmount * (mixMode === 'dilute' ? 0.3 : 1) * (0.05 + 0.25 * pressure) * (1 - colorStretch * 0.8);
    if (reload > 0 && !sameColor(nextReservoir, foreground)) {
      nextReservoir = blendPigmentColors(nextReservoir, foreground, reload, pigmentBlendMode, pigmentStrength);
    }
  }

  const chargeDepletion = clamp01(opts.chargeDepletion ?? 0);
  const strokeDistance = opts.strokeDistancePx ?? 0;
  const distance = Number.isNaN(strokeDistance) ? 0 : Math.max(0, strokeDistance);
  const modeAlpha = mixMode === 'dilute' ? 0.82 : 1;
  const alphaMultiplier = chargeDepletion > 0
    ? Math.max(0.12, modeAlpha * Math.exp(-distance * chargeDepletion / (200 + paintAmount * 1800)))
    : modeAlpha;

  return {
    nextReservoir,
    dabColor: nextReservoir,
    alphaMultiplier,
    smudgeSampled,
    skipDab: mixMode === 'smudge' && !smudgeSampled,
  };
}

/**
 * Watercolor & Thick Impasto Paint Pickup & Depletion Simulation
 *
 * When brush moves over existing paint:
 * 1. Picks up background pigment based on `colorMixing` and background alpha
 * 2. Mixes picked pigment into the brush reservoir using subtractive pigment blending
 * 3. Fresh paint attenuates over stroke distance based on `paintAmount / wetness`
 *
 * @param brushColor Foreground brush color
 * @param canvasColor Sampled background canvas pixel color
 * @param colorMixing Mixing degree (0.0 to 1.0)
 * @param paintAmount Wetness / paint amount (0.0 to 1.0)
 * @param strokeDistance Accumulated distance along current stroke in pixels
 */
export function simulateWetColorPickup(
  brushColor: RgbColor,
  canvasColor: RgbColor,
  colorMixing: number,
  paintAmount: number,
  strokeDistance: number = 0
): { mixedColor: RgbColor; effectiveOpacity: number } {
  const bgAlpha = canvasColor.a !== undefined ? canvasColor.a : 1.0;

  // If background is completely transparent, no pigment to pick up
  if (bgAlpha <= 0.01 || colorMixing <= 0.0) {
    const depletion = Math.max(0.2, Math.exp(-strokeDistance / Math.max(200, paintAmount * 2000)));
    return {
      mixedColor: { ...brushColor },
      effectiveOpacity: (brushColor.a ?? 1.0) * depletion,
    };
  }

  // Paint pickup ratio smoothly scales with colorMixing and background coverage
  // High wetness makes the brush blend more fluidly with existing pigment
  const mixRatio = Math.max(0.0, Math.min(0.85, colorMixing * bgAlpha * (0.6 + (1.0 - paintAmount) * 0.4)));

  // Blend brush foreground with picked background pigment using subtractive paint model
  const mixedColor = mixPigmentSubtractive(brushColor, canvasColor, mixRatio);

  // Stroke attenuation / dry out factor
  const halfLife = Math.max(150, paintAmount * 1500);
  const depletion = Math.max(0.25, Math.exp(-strokeDistance / halfLife));

  return {
    mixedColor,
    effectiveOpacity: Math.max(0.1, (brushColor.a ?? 1.0) * depletion),
  };
}

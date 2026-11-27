/**
 * Phase 6.2: True 4-channel CMYK color separation with GCR/UCR black generation
 * and Total Area Coverage (TAC) analysis, clamping, and warning heatmap generation.
 */

export type BlackGenerationMode = 'gcr' | 'ucr';

export type CmykPrintPresetId =
  | 'japan-color-2001-coated'
  | 'fogra39'
  | 'us-web-coated-swop'
  | 'custom';

export interface CmykSeparationOptions {
  presetId: CmykPrintPresetId;
  /** GCR (Gray Component Replacement) vs UCR (Under Color Removal) */
  blackGeneration: BlackGenerationMode;
  /** Black generation strength in [0, 1] (0 = CMY only, 1 = maximum black replacement) */
  blackStrength: number;
  /** Threshold [0, 0.9] where black ink starts being generated */
  blackStart: number;
  /** Maximum K channel ink coverage in [0.5, 1.0] (default 0.95 = 95%) */
  maxBlackInk: number;
  /** Maximum Total Area Coverage percentage in [200, 400] (e.g. 300 for 300%) */
  tacLimit: number;
  /** Whether to clamp/scale CMY channels down so C+M+Y+K <= tacLimit on output */
  enforceTacLimit: boolean;
}

export interface CmykPrintPresetDefaults {
  id: Exclude<CmykPrintPresetId, 'custom'>;
  tacLimit: number;
  blackGeneration: BlackGenerationMode;
  blackStrength: number;
  blackStart: number;
  maxBlackInk: number;
  /** Subtle per-preset dot gain / ink balance tuning factors */
  cGain: number;
  mGain: number;
  yGain: number;
}

export const CMYK_SEPARATION_PRESETS: Record<
  Exclude<CmykPrintPresetId, 'custom'>,
  CmykPrintPresetDefaults
> = {
  'japan-color-2001-coated': {
    id: 'japan-color-2001-coated',
    tacLimit: 300,
    blackGeneration: 'gcr',
    blackStrength: 0.72,
    blackStart: 0.05,
    maxBlackInk: 0.95,
    cGain: 1.0,
    mGain: 0.98,
    yGain: 0.97,
  },
  fogra39: {
    id: 'fogra39',
    tacLimit: 330,
    blackGeneration: 'gcr',
    blackStrength: 0.7,
    blackStart: 0.05,
    maxBlackInk: 0.95,
    cGain: 1.02,
    mGain: 0.99,
    yGain: 0.98,
  },
  'us-web-coated-swop': {
    id: 'us-web-coated-swop',
    tacLimit: 300,
    blackGeneration: 'gcr',
    blackStrength: 0.65,
    blackStart: 0.08,
    maxBlackInk: 0.92,
    cGain: 0.98,
    mGain: 1.0,
    yGain: 0.96,
  },
};

export interface CmykPixelSample {
  c: number;
  m: number;
  y: number;
  k: number;
  /** Unclamped Total Area Coverage percentage (0..400) */
  rawTacPct: number;
  /** Final output Total Area Coverage percentage after optional TAC enforcement */
  finalTacPct: number;
  /** True when rawTacPct exceeded options.tacLimit */
  tacExceeded: boolean;
}

export interface CmykTacStats {
  totalPixels: number;
  maxRawTacPct: number;
  maxFinalTacPct: number;
  avgRawTacPct: number;
  exceededPixelCount: number;
  /** Fraction [0..1] of pixels whose pre-clamp TAC exceeded tacLimit */
  exceededRatio: number;
  overLimit: boolean;
  tacLimit: number;
}

export interface CmykSeparationResult {
  /** Interleaved 8-bit CMYK buffer (length = width * height * 4, 0 = 0% ink, 255 = 100% ink) */
  cmyk: Uint8Array;
  width: number;
  height: number;
  options: CmykSeparationOptions;
  stats: CmykTacStats;
  /** Optional RGBA preview overlay highlighting over-TAC pixels (amber -> crimson) */
  warningOverlayRgba?: Uint8ClampedArray;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = Math.max(1e-5, edge1 - edge0);
  const t = clamp((x - edge0) / span, 0, 1);
  return t * t * (3 - 2 * t);
}

export function getPresetSeparationOptions(
  presetId: Exclude<CmykPrintPresetId, 'custom'>
): CmykSeparationOptions {
  const p = CMYK_SEPARATION_PRESETS[presetId] ?? CMYK_SEPARATION_PRESETS['japan-color-2001-coated'];
  return {
    presetId: p.id,
    blackGeneration: p.blackGeneration,
    blackStrength: p.blackStrength,
    blackStart: p.blackStart,
    maxBlackInk: p.maxBlackInk,
    tacLimit: p.tacLimit,
    enforceTacLimit: true,
  };
}

export function normalizeCmykSeparationOptions(
  raw?: Partial<CmykSeparationOptions> | null
): CmykSeparationOptions {
  const presetId: CmykPrintPresetId =
    raw?.presetId === 'fogra39' ||
    raw?.presetId === 'us-web-coated-swop' ||
    raw?.presetId === 'custom'
      ? raw.presetId
      : 'japan-color-2001-coated';
  const base =
    presetId === 'custom'
      ? CMYK_SEPARATION_PRESETS['japan-color-2001-coated']
      : CMYK_SEPARATION_PRESETS[presetId];
  const blackGeneration: BlackGenerationMode = raw?.blackGeneration === 'ucr' ? 'ucr' : 'gcr';
  const rawStrength = Number(raw?.blackStrength);
  const blackStrength = Number.isFinite(rawStrength) ? clamp(rawStrength, 0, 1) : base.blackStrength;
  const rawStart = Number(raw?.blackStart);
  const defaultStart = blackGeneration === 'ucr' ? 0.35 : base.blackStart;
  const blackStart = Number.isFinite(rawStart) ? clamp(rawStart, 0, 0.9) : defaultStart;
  const rawMaxK = Number(raw?.maxBlackInk);
  const maxBlackInk = Number.isFinite(rawMaxK) ? clamp(rawMaxK, 0.5, 1) : base.maxBlackInk;
  const rawTac = Number(raw?.tacLimit);
  const tacLimit = Number.isFinite(rawTac) ? clamp(Math.round(rawTac), 200, 400) : base.tacLimit;
  const enforceTacLimit = raw?.enforceTacLimit !== undefined ? Boolean(raw.enforceTacLimit) : true;

  return {
    presetId,
    blackGeneration,
    blackStrength,
    blackStart,
    maxBlackInk,
    tacLimit,
    enforceTacLimit,
  };
}

/**
 * Separates a single sRGB 8-bit pixel `(r, g, b)` into 4-channel CMYK `[0..1]` using
 * configurable GCR or UCR black generation and optional TAC clamping.
 */
export function separateRgbPixelToCmyk(
  r8: number,
  g8: number,
  b8: number,
  options: CmykSeparationOptions
): CmykPixelSample {
  const preset =
    options.presetId !== 'custom'
      ? CMYK_SEPARATION_PRESETS[options.presetId]
      : CMYK_SEPARATION_PRESETS['japan-color-2001-coated'];

  const r = clamp(r8 / 255, 0, 1);
  const g = clamp(g8 / 255, 0, 1);
  const b = clamp(b8 / 255, 0, 1);

  // Subtle substrate/ink balance conditioning for CMY separation
  const c0 = clamp((1 - r) * preset.cGain, 0, 1);
  const m0 = clamp((1 - g) * preset.mGain, 0, 1);
  const y0 = clamp((1 - b) * preset.yGain, 0, 1);

  const gray = Math.min(c0, m0, y0);
  const maxCmy = Math.max(c0, m0, y0);
  const chroma = maxCmy - gray;

  let k = 0;
  let c = c0;
  let m = m0;
  let y = y0;

  if (gray > 0 && options.blackStrength > 0) {
    if (options.blackGeneration === 'gcr') {
      // Gray Component Replacement: replaces neutral gray across all chromatic hues
      const ramp =
        gray <= options.blackStart
          ? 0
          : (gray - options.blackStart) / Math.max(1e-4, 1 - options.blackStart);
      k = Math.min(options.maxBlackInk, ramp * options.blackStrength);
      // Subtractive GCR removal keeps total ink monotonically decreasing as blackStrength rises
      const removal = k * 0.92;
      c = clamp(c0 - removal, 0, 1);
      m = clamp(m0 - removal, 0, 1);
      y = clamp(y0 - removal, 0, 1);
    } else {
      // Under Color Removal: targets near-neutral shadow tones, leaving vivid chromatic inks fuller
      const neutrality = clamp(1 - chroma / 0.35, 0, 1);
      const shadowRamp = smoothstep(options.blackStart, 1, gray);
      k = Math.min(options.maxBlackInk, gray * neutrality * shadowRamp * options.blackStrength);
      const removal = k * 0.78;
      c = clamp(c0 - removal, 0, 1);
      m = clamp(m0 - removal, 0, 1);
      y = clamp(y0 - removal, 0, 1);
    }
  }

  const rawTacPct = (c + m + y + k) * 100;
  const tacExceeded = rawTacPct > options.tacLimit + 0.05;

  if (options.enforceTacLimit && rawTacPct > options.tacLimit) {
    const limitUnit = options.tacLimit / 100;
    const kClamped = Math.min(k, Math.min(options.maxBlackInk, limitUnit));
    const cmySum = c + m + y;
    const budgetForCmy = Math.max(0, limitUnit - kClamped);
    if (cmySum > budgetForCmy && cmySum > 1e-6) {
      const scale = budgetForCmy / cmySum;
      c *= scale;
      m *= scale;
      y *= scale;
    }
    k = kClamped;
  }

  const finalTacPct = (c + m + y + k) * 100;

  return {
    c: clamp(c, 0, 1),
    m: clamp(m, 0, 1),
    y: clamp(y, 0, 1),
    k: clamp(k, 0, 1),
    rawTacPct,
    finalTacPct,
    tacExceeded,
  };
}

/**
 * Separates an RGBA image buffer (composited over white for translucent pixels) into
 * interleaved 8-bit CMYK (`0 = 0% ink`, `255 = 100% ink`), returning TAC statistics
 * and an optional TAC over-limit heatmap overlay for ExportModal preview.
 */
export function separateRgbaToCmykBuffer(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  rawOptions?: Partial<CmykSeparationOptions> | null,
  generateWarningOverlay: boolean = false
): CmykSeparationResult {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const totalPixels = w * h;
  const options = normalizeCmykSeparationOptions(rawOptions);
  const cmyk = new Uint8Array(totalPixels * 4);
  const overlay = generateWarningOverlay ? new Uint8ClampedArray(totalPixels * 4) : undefined;

  let maxRawTacPct = 0;
  let maxFinalTacPct = 0;
  let sumRawTacPct = 0;
  let exceededPixelCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    const p = i * 4;
    const a = (rgba[p + 3] ?? 255) / 255;
    // Composite against paper white for print separation
    const r = Math.round((rgba[p] ?? 255) * a + 255 * (1 - a));
    const g = Math.round((rgba[p + 1] ?? 255) * a + 255 * (1 - a));
    const b = Math.round((rgba[p + 2] ?? 255) * a + 255 * (1 - a));

    const sample = separateRgbPixelToCmyk(r, g, b, options);
    cmyk[p] = Math.round(sample.c * 255);
    cmyk[p + 1] = Math.round(sample.m * 255);
    cmyk[p + 2] = Math.round(sample.y * 255);
    cmyk[p + 3] = Math.round(sample.k * 255);

    if (sample.rawTacPct > maxRawTacPct) maxRawTacPct = sample.rawTacPct;
    if (sample.finalTacPct > maxFinalTacPct) maxFinalTacPct = sample.finalTacPct;
    sumRawTacPct += sample.rawTacPct;

    if (sample.tacExceeded) {
      exceededPixelCount++;
      if (overlay) {
        const excess = clamp((sample.rawTacPct - options.tacLimit) / 60, 0, 1);
        // High-contrast warning color: amber -> vivid crimson
        overlay[p] = 244;
        overlay[p + 1] = Math.round(158 * (1 - excess) + 38 * excess);
        overlay[p + 2] = Math.round(11 * (1 - excess) + 68 * excess);
        overlay[p + 3] = 255;
      }
    } else if (overlay) {
      // Muted grayscale luminance background so TAC hotspots stand out clearly
      const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const dimmed = Math.round(luma * 0.55 + 24);
      overlay[p] = dimmed;
      overlay[p + 1] = dimmed;
      overlay[p + 2] = dimmed;
      overlay[p + 3] = 255;
    }
  }

  return {
    cmyk,
    width: w,
    height: h,
    options,
    stats: {
      totalPixels,
      maxRawTacPct: Math.round(maxRawTacPct * 10) / 10,
      maxFinalTacPct: Math.round(maxFinalTacPct * 10) / 10,
      avgRawTacPct: totalPixels > 0 ? Math.round((sumRawTacPct / totalPixels) * 10) / 10 : 0,
      exceededPixelCount,
      exceededRatio: totalPixels > 0 ? exceededPixelCount / totalPixels : 0,
      overLimit: exceededPixelCount > 0,
      tacLimit: options.tacLimit,
    },
    ...(overlay ? { warningOverlayRgba: overlay } : {}),
  };
}

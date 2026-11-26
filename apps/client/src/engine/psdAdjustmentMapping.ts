import type { AdjustmentLayer, Color, CurvesAdjustmentChannel, LevelsAdjustmentChannel } from 'ag-psd';
import {
  normalizeAdjustment,
  resolveAdjustmentScope,
  type LayerModel,
  type AdjustmentCurvePoint,
  type GradientMapStop,
  type LayerAdjustment,
  type LevelsChannelParams,
} from '@atelier/shared';

/**
 * Lumina adjustment layers ↔ Photoshop adjustment layers (ag-psd's `layer.adjustment`). Pure: no DOM.
 * Six kinds round-trip; Photoshop-only data (per-range hue/saturation, noise gradients, pencil
 * curves, legacy brightness, other adjustment types) is reported as partial / unsupported.
 */

const LEVELS_ORDER = ['master', 'red', 'green', 'blue'] as const;

const toPsdLevels = (c: LevelsChannelParams): LevelsAdjustmentChannel => ({
  shadowInput: c.inBlack,
  highlightInput: c.inWhite,
  shadowOutput: c.outBlack,
  highlightOutput: c.outWhite,
  midtoneInput: c.gamma,
});

const fromPsdLevels = (c: LevelsAdjustmentChannel | undefined): Partial<LevelsChannelParams> | undefined =>
  c && {
    inBlack: c.shadowInput,
    inWhite: c.highlightInput,
    outBlack: c.shadowOutput,
    outWhite: c.highlightOutput,
    gamma: c.midtoneInput,
  };

const toPsdCurve = (points: AdjustmentCurvePoint[]): CurvesAdjustmentChannel => points.map(({ x, y }) => ({ input: x, output: y }));

/** An empty Photoshop channel means "unchanged" (the identity curve) */
const fromPsdCurve = (channel: CurvesAdjustmentChannel | undefined): AdjustmentCurvePoint[] | undefined =>
  channel && channel.length >= 2 ? channel.map(({ input, output }) => ({ x: input, y: output })) : undefined;

/** A pencil-drawn curve (256 outputs) as 16 evenly spaced points */
const curveFromLut = (values: number[] | undefined): AdjustmentCurvePoint[] | undefined => {
  if (!values || values.length !== 256) return undefined;
  return Array.from({ length: 16 }, (_, i) => {
    const x = Math.round((i * 255) / 15);
    return { x, y: values[x] };
  });
};

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const hexToRgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});
/** Only plain 8-bit RGB stops map exactly (HSB / Lab / CMYK / float stops do not) */
const rgbHex = (color: Color | undefined): string | null =>
  color && 'r' in color && 'g' in color && 'b' in color ? `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}` : null;

const isInt = (...values: number[]) => values.every((v) => Number.isInteger(v));

export function luminaToPsdAdjustment(adj: LayerAdjustment): { adjustment: AdjustmentLayer; lossy: boolean } {
  switch (adj.kind) {
    case 'brightness_contrast':
      return {
        adjustment: { type: 'brightness/contrast', brightness: adj.params.brightness, contrast: adj.params.contrast, meanValue: 127, useLegacy: false, labColorOnly: false },
        lossy: false,
      };
    case 'levels':
      return { adjustment: { type: 'levels', channels: LEVELS_ORDER.map((key) => toPsdLevels(adj.params[key])) }, lossy: false };
    case 'curves':
      return { adjustment: { type: 'curves', channels: LEVELS_ORDER.map((key) => toPsdCurve(adj.params[key])) }, lossy: false };
    case 'hsl': {
      const { hue, saturation, lightness, colorize } = adj.params;
      const values = { hue: Math.round(hue), saturation: Math.round(saturation), lightness: Math.round(lightness) };
      return {
        adjustment: colorize
          ? { type: 'hue/saturation', colorize: true, colorization: values, master: { hue: 0, saturation: 0, lightness: 0 } }
          : { type: 'hue/saturation', colorize: false, colorization: { hue: 0, saturation: 25, lightness: 0 }, master: values },
        lossy: !isInt(hue, saturation, lightness),
      };
    }
    case 'color_balance': {
      const { shadows, midtones, highlights, preserveLuminosity } = adj.params;
      const round = (t: typeof shadows) => ({ cyanRed: Math.round(t.cyanRed), magentaGreen: Math.round(t.magentaGreen), yellowBlue: Math.round(t.yellowBlue) });
      return {
        adjustment: { type: 'color balance', shadows: round(shadows), midtones: round(midtones), highlights: round(highlights), preserveLuminosity },
        lossy: ![shadows, midtones, highlights].every((t) => isInt(t.cyanRed, t.magentaGreen, t.yellowBlue)),
      };
    }
    case 'gradient_map':
      return {
        adjustment: {
          type: 'gradient map',
          name: '',
          gradientType: 'solid',
          dither: false,
          reverse: adj.params.reverse,
          // Lumina interpolates stops linearly: Photoshop's 0% smoothness
          smoothness: 0,
          colorStops: adj.params.stops.map((s) => ({ color: hexToRgb(s.color), location: s.offset, midpoint: 0.5 })),
          opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }],
          colorModel: 'rgb',
        },
        lossy: false,
      };
  }
}

/**
 * Groups that must be written as isolated ('normal') instead of 'pass through': in Lumina an
 * adjustment layer inside a group only recolours that group's layers (its group scope).
 */
export function psdIsolatedGroupIds(layers: readonly LayerModel[]): Set<string> {
  const ids = new Set<string>();
  for (const layer of layers) {
    if (layer.layerType !== 'adjustment') continue;
    const scope = resolveAdjustmentScope(layers, layer.id);
    if (scope.kind === 'group') ids.add(scope.groupId);
  }
  return ids;
}

const PSD_KIND_LABELS: Record<string, string> = {
  'brightness/contrast': 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  'hue/saturation': 'Hue/Saturation',
  'color balance': 'Color Balance',
  'black & white': 'Black & White',
  'photo filter': 'Photo Filter',
  'channel mixer': 'Channel Mixer',
  'color lookup': 'Color Lookup',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  'gradient map': 'Gradient Map',
  'selective color': 'Selective Color',
};

/** Photoshop's English name of the adjustment type (shown in import notes) */
export function psdAdjustmentKindLabel(psd: AdjustmentLayer): string {
  return PSD_KIND_LABELS[psd.type] ?? psd.type;
}

const hueRangeUsed = (ch: { hue: number; saturation: number; lightness: number } | undefined) =>
  Boolean(ch && (ch.hue || ch.saturation || ch.lightness));

export function psdToLuminaAdjustment(psd: AdjustmentLayer): { adjustment: LayerAdjustment | null; partial: boolean; kindLabel: string } {
  const kindLabel = psdAdjustmentKindLabel(psd);
  const done = (raw: unknown, partial: boolean) => ({ adjustment: normalizeAdjustment(raw), partial, kindLabel });
  switch (psd.type) {
    case 'brightness/contrast':
      // Legacy brightness/contrast uses another formula
      return done({ kind: 'brightness_contrast', params: { brightness: psd.brightness ?? 0, contrast: psd.contrast ?? 0 } }, Boolean(psd.useLegacy));
    case 'levels': {
      const channels = psd.channels ?? [];
      const params = Object.fromEntries(LEVELS_ORDER.map((key, i) => [key, fromPsdLevels(channels[i])]));
      return done({ kind: 'levels', params }, channels.length > LEVELS_ORDER.length);
    }
    case 'curves': {
      const pencil = !psd.channels && Array.isArray(psd.values);
      const params = Object.fromEntries(LEVELS_ORDER.map((key, i) => [
        key,
        pencil ? curveFromLut(psd.values?.[i]) : fromPsdCurve(psd.channels?.[i]),
      ]));
      const rest = (pencil ? psd.values ?? [] : psd.channels ?? []).slice(LEVELS_ORDER.length);
      return done({ kind: 'curves', params }, pencil || rest.some((c) => c.length > 0));
    }
    case 'hue/saturation': {
      const values = psd.colorize ? psd.colorization : psd.master;
      return done({
        kind: 'hsl',
        params: { hue: values?.hue ?? 0, saturation: values?.saturation ?? 0, lightness: values?.lightness ?? 0, colorize: Boolean(psd.colorize) },
      }, [psd.reds, psd.yellows, psd.greens, psd.cyans, psd.blues, psd.magentas].some(hueRangeUsed));
    }
    case 'color balance':
      return done({
        kind: 'color_balance',
        params: { shadows: psd.shadows, midtones: psd.midtones, highlights: psd.highlights, preserveLuminosity: Boolean(psd.preserveLuminosity) },
      }, false);
    case 'gradient map': {
      const stops: GradientMapStop[] = [];
      let partial = psd.gradientType === 'noise' || (psd.colorModel !== undefined && psd.colorModel !== 'rgb');
      for (const s of psd.colorStops ?? []) {
        const color = rgbHex(s.color);
        if (color) stops.push({ offset: s.location, color });
        else partial = true;
      }
      if ((psd.opacityStops ?? []).some((s) => s.opacity < 1) || (psd.smoothness ?? 0) > 0) partial = true;
      return done({
        kind: 'gradient_map',
        // Fewer than two usable stops: normalizeAdjustment falls back to the default black → white
        params: { stops: stops.length >= 2 ? stops : undefined, reverse: Boolean(psd.reverse) },
      }, partial || stops.length < 2);
    }
    default:
      return { adjustment: null, partial: false, kindLabel };
  }
}

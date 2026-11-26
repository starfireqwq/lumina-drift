import { clampUnit, D50_WHITE, deltaE2000, linearToSrgb, srgb8ToXyzD50, xyzD50ToLinearSrgb, xyzToLab, type Vec3 } from './colorMath';
import { CmykPrintModel, getPrintConditionPreset, type BuiltinProofProfileId } from './cmykPrintModel';
import { createDeviceToPcs, createGamutCheck, createPcsToDevice, type IccIntent, type IccProfile } from './iccProfile';

export type ProofSource = { kind: 'builtin'; id: BuiltinProofProfileId } | { kind: 'icc'; profile: IccProfile };

export interface ProofOptions {
  intent: IccIntent;
  blackPointCompensation: boolean;
  gamutThreshold?: number;
}

export interface ProofResult {
  rgb: Vec3;
  outOfGamut: boolean;
  deltaE: number;
  device: number[];
}

export interface ProofTransform {
  readonly label: string;
  proof(r: number, g: number, b: number): ProofResult;
}

export interface SoftProofLut {
  size: number;
  data: Uint8Array;
  label: string;
  buildMs: number;
}

type Cmyk = [number, number, number, number];
const DEFAULT_GAMUT_THRESHOLD = 3;

function proofEvaluator(source: ProofSource, options: ProofOptions) {
  const target: Vec3 = [0, 0, 0];
  const threshold = options.gamutThreshold ?? DEFAULT_GAMUT_THRESHOLD;
  const compensate = options.blackPointCompensation;

  function toTarget(r: number, g: number, b: number, black: Vec3): void {
    if (r === 255 && g === 255 && b === 255) {
      for (let i = 0; i < 3; i++) target[i] = D50_WHITE[i];
      return;
    }
    srgb8ToXyzD50(r, g, b, target);
    if (compensate) {
      for (let i = 0; i < 3; i++) target[i] = black[i] + target[i] * (1 - black[i] / D50_WHITE[i]);
    }
  }

  function toRgb(xyz: Vec3): Vec3 {
    const rgb = xyzD50ToLinearSrgb(xyz);
    for (let i = 0; i < 3; i++) rgb[i] = clampUnit(linearToSrgb(clampUnit(rgb[i]))) * 255;
    return rgb;
  }

  if (source.kind === 'builtin') {
    const model = new CmykPrintModel(getPrintConditionPreset(source.id));
    return {
      label: model.preset.label,
      proof(r: number, g: number, b: number, warm?: Cmyk): ProofResult {
        toTarget(r, g, b, model.blackPoint);
        const result = model.relativeXyzToCmyk(target, warm);
        return { rgb: toRgb(result.xyz), outOfGamut: result.deltaE > threshold, deltaE: result.deltaE, device: result.cmyk };
      },
    };
  }

  const { profile } = source;
  const toDevice = createPcsToDevice(profile, options.intent);
  const fromDevice = createDeviceToPcs(profile, 'relative') ?? createDeviceToPcs(profile, 'perceptual');
  if (!toDevice || !fromDevice || !['CMYK', 'RGB', 'GRAY'].includes(profile.header.colorSpace)) {
    throw new Error('unsupported_profile');
  }
  const gamut = createGamutCheck(profile);
  const flag = new Float64Array(1);
  const device = new Float64Array(toDevice.outputChannels);
  const pcs = new Float64Array(3);
  const printed: Vec3 = [0, 0, 0];
  const targetLab: Vec3 = [0, 0, 0];
  const printedLab: Vec3 = [0, 0, 0];
  const black: Vec3 = [0, 0, 0];
  if (compensate) {
    toDevice.eval(black, device);
    fromDevice.eval(device, pcs);
    for (let i = 0; i < 3; i++) black[i] = Math.max(0, Math.min(D50_WHITE[i], pcs[i]));
  }
  return {
    label: profile.description || profile.header.colorSpace,
    proof(r: number, g: number, b: number): ProofResult {
      toTarget(r, g, b, black);
      toDevice.eval(target, device);
      fromDevice.eval(device, pcs);
      for (let i = 0; i < 3; i++) printed[i] = pcs[i];
      const deltaE = deltaE2000(xyzToLab(target, D50_WHITE, targetLab), xyzToLab(printed, D50_WHITE, printedLab));
      gamut?.eval(target, flag);
      return { rgb: toRgb(printed), outOfGamut: gamut ? flag[0] > 0.5 : deltaE > threshold, deltaE, device: Array.from(device) };
    },
  };
}

export function createProofTransform(source: ProofSource, options: ProofOptions): ProofTransform {
  return proofEvaluator(source, options);
}

export async function buildSoftProofLut(
  source: ProofSource,
  options: ProofOptions,
  opts?: { size?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<SoftProofLut> {
  const requested = opts?.size ?? 33;
  const size = Number.isFinite(requested) ? Math.max(9, Math.min(65, Math.round(requested))) : 33;
  const checkAbort = () => {
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  checkAbort();
  const start = performance.now();
  const transform = proofEvaluator(source, options);
  const data = new Uint8Array(size ** 3 * 4);
  const values = Array.from({ length: size }, (_, i) => i * 255 / (size - 1));
  let offset = 0;
  let warm: Cmyk | undefined;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const result = transform.proof(values[r], values[g], values[b], warm);
        if (source.kind === 'builtin') warm = result.device as Cmyk;
        data[offset++] = Math.round(result.rgb[0]);
        data[offset++] = Math.round(result.rgb[1]);
        data[offset++] = Math.round(result.rgb[2]);
        data[offset++] = result.outOfGamut ? 255 : 0;
      }
    }
    opts?.onProgress?.(b + 1, size);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    checkAbort();
  }
  return { size, data, label: transform.label, buildMs: performance.now() - start };
}

function interpolate(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function sampleSoftProofLut(lut: SoftProofLut, r: number, g: number, b: number): { rgb: Vec3; gamut: number } {
  const { size, data } = lut;
  const x = clampUnit(r / 255) * (size - 1);
  const y = clampUnit(g / 255) * (size - 1);
  const z = clampUnit(b / 255) * (size - 1);
  const x0 = Math.min(Math.floor(x), size - 2);
  const y0 = Math.min(Math.floor(y), size - 2);
  const z0 = Math.min(Math.floor(z), size - 2);
  const row = size * 4;
  const slice = size * row;
  const base = z0 * slice + y0 * row + x0 * 4;
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const channel = (i: number) => {
    const lo = interpolate(interpolate(data[i], data[i + 4], tx), interpolate(data[i + row], data[i + row + 4], tx), ty);
    const hi = interpolate(interpolate(data[i + slice], data[i + slice + 4], tx),
      interpolate(data[i + slice + row], data[i + slice + row + 4], tx), ty);
    return interpolate(lo, hi, tz);
  };
  return { rgb: [channel(base), channel(base + 1), channel(base + 2)], gamut: channel(base + 3) / 255 };
}

export function applySoftProofToRgba(
  lut: SoftProofLut,
  rgba: Uint8Array | Uint8ClampedArray,
  opts: { proof: boolean; gamutWarning: boolean; warningColor: Vec3 },
): void {
  if (!opts.proof && !opts.gamutWarning) return;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const { rgb, gamut } = sampleSoftProofLut(lut, rgba[i], rgba[i + 1], rgba[i + 2]);
    const color = opts.gamutWarning && gamut > 0.5 ? opts.warningColor : opts.proof ? rgb : null;
    if (color) {
      for (let channel = 0; channel < 3; channel++) rgba[i + channel] = Math.round(clampUnit(color[channel] / 255) * 255);
    }
  }
}

export function softProofCacheKey(source: ProofSource, options: ProofOptions, size: number): string {
  let sourceKey: string;
  if (source.kind === 'builtin') {
    sourceKey = `builtin/${source.id}`;
  } else {
    const { bytes } = source.profile;
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (const byte of bytes) {
      first = Math.imul(first ^ byte, 0x01000193);
      second = Math.imul(second ^ byte, 0x85ebca6b);
    }
    sourceKey = `icc/${bytes.length}/${first >>> 0}/${second >>> 0}`;
  }
  return `${sourceKey}/${options.intent}/${Number(options.blackPointCompensation)}/${options.gamutThreshold ?? DEFAULT_GAMUT_THRESHOLD}/${size}`;
}

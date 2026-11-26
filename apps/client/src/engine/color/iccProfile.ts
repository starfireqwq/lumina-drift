import { clampUnit, D50_WHITE, invertMatrix3, labToXyz, SRGB_D50_MATRIX, srgbToLinear, xyzToLab, type Vec3 } from './colorMath';

export type IccParseErrorCode = 'too_small' | 'bad_size' | 'bad_signature' | 'bad_tag_table' | 'unsupported';

export class IccParseError extends Error {
  constructor(readonly code: IccParseErrorCode) {
    super(code);
    this.name = 'IccParseError';
  }
}

export interface IccHeader {
  size: number;
  version: string;
  deviceClass: string;
  colorSpace: string;
  pcs: 'XYZ' | 'Lab';
  renderingIntent: number;
}

export interface IccProfile {
  header: IccHeader;
  description: string;
  copyright: string;
  mediaWhite: Vec3 | null;
  tagSignatures: string[];
  bytes: Uint8Array;
}

export type IccIntent = 'perceptual' | 'relative';

/** PCS input and output are XYZ D50 with reference white Y = 1. */
export interface IccPipeline {
  readonly inputChannels: number;
  readonly outputChannels: number;
  eval(input: ArrayLike<number>, out: Float64Array): void;
}

type Curve = (input: number) => number;
type Stage = (buffer: Float64Array) => void;
type LutType = 'mft1' | 'mft2' | 'mAB ' | 'mBA ';
type Direction = 'toPcs' | 'fromPcs' | 'gamut';
type Tag = { text?: string; xyz?: Vec3; curve?: Curve; lut?: IccPipeline; lutType?: LutType };
const parsedTags = new WeakMap<IccProfile, Map<string, Tag>>();
const XYZ_SCALE = 65535 / 32768;
const TEXT_DECODER = new TextDecoder();
const UTF16_BE = new TextDecoder('utf-16be');

function checkRange(view: DataView, offset: number, size: number): void {
  if (offset < 0 || offset > view.byteLength || size < 0 || size > view.byteLength - offset) {
    throw new IccParseError('bad_tag_table');
  }
}

function viewOf(view: DataView, offset: number, size: number): DataView {
  checkRange(view, offset, size);
  return new DataView(view.buffer, view.byteOffset + offset, size);
}

function signature(view: DataView, offset: number): string {
  checkRange(view, offset, 4);
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function ascii(view: DataView, offset: number, size: number): string {
  checkRange(view, offset, size);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, size);
  const end = bytes.indexOf(0);
  return TEXT_DECODER.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function fixed(view: DataView, offset: number): number {
  return view.getInt32(offset) / 65536;
}

function readXyz(view: DataView, offset: number): Vec3 {
  checkRange(view, offset, 12);
  return [fixed(view, offset), fixed(view, offset + 4), fixed(view, offset + 8)];
}

function readMluc(view: DataView): string {
  checkRange(view, 8, 8);
  const count = view.getUint32(8);
  const recordSize = view.getUint32(12);
  if (recordSize < 12) throw new IccParseError('bad_tag_table');
  checkRange(view, 16, count * recordSize);
  const recordEnd = 16 + count * recordSize;
  let first: DataView | undefined;
  let english: DataView | undefined;
  for (let i = 0; i < count; i++) {
    const record = 16 + i * recordSize;
    const length = view.getUint32(record + 4);
    const offset = view.getUint32(record + 8);
    if (length % 2 !== 0 || (length !== 0 && offset < recordEnd)) throw new IccParseError('bad_tag_table');
    const value = viewOf(view, offset, length);
    first ??= value;
    if (view.getUint16(record) === 0x656e) english ??= value;
  }
  const chosen = english ?? first;
  return chosen ? UTF16_BE.decode(chosen).replace(/\0+$/, '') : '';
}

function readCurve(view: DataView, start: number): { curve: Curve | null; size: number } {
  checkRange(view, start, 12);
  const type = signature(view, start);
  if (type === 'curv') {
    const count = view.getUint32(start + 8);
    const size = 12 + count * 2;
    checkRange(view, start, size);
    if (count === 0) return { curve: clampUnit, size };
    if (count === 1) {
      const gamma = view.getUint16(start + 12) / 256;
      return { curve: gamma > 0 ? x => clampUnit(x) ** gamma : null, size };
    }
    return { curve: tableCurve(sampleReader(view, 2), start + 12, count, 2), size };
  }
  if (type !== 'para') return { curve: null, size: 0 };
  const fn = view.getUint16(start + 8);
  const count = [1, 3, 4, 5, 7][fn];
  if (!count) return { curve: null, size: 0 };
  const size = 12 + count * 4;
  checkRange(view, start, size);
  const [g, a, b, c, d, e, f] = Array.from({ length: count }, (_, i) => fixed(view, start + 12 + i * 4));
  if (g <= 0 || (fn !== 0 && a <= 0)) return { curve: null, size };
  const power: Curve = x => Math.max(0, a * x + b) ** g;
  const curves: Curve[] = [
    x => x ** g,
    x => x >= -b / a ? power(x) : 0,
    x => x >= -b / a ? power(x) + c : c,
    x => x >= d ? power(x) : c * x,
    x => x >= d ? power(x) + e : c * x + f,
  ];
  return { curve: x => clampUnit(curves[fn](clampUnit(x))), size };
}

function sampleReader(view: DataView, width: number): (offset: number) => number {
  return width === 1 ? offset => view.getUint8(offset) / 255 : offset => view.getUint16(offset) / 65535;
}

function tableCurve(read: (offset: number) => number, offset: number, count: number, width: number): Curve {
  return input => {
    const scaled = clampUnit(input) * (count - 1);
    const index = Math.min(Math.floor(scaled), count - 2);
    const lo = read(offset + index * width);
    return lo + (scaled - index) * (read(offset + (index + 1) * width) - lo);
  };
}

function curveStage(curves: Curve[]): Stage {
  return buffer => {
    for (let i = 0; i < curves.length; i++) buffer[i] = curves[i](buffer[i]);
  };
}

function matrixStage(matrix: ArrayLike<number>): Stage {
  const tx = matrix[9] ?? 0;
  const ty = matrix[10] ?? 0;
  const tz = matrix[11] ?? 0;
  return buffer => {
    const x = buffer[0];
    const y = buffer[1];
    const z = buffer[2];
    buffer[0] = clampUnit(matrix[0] * x + matrix[1] * y + matrix[2] * z + tx);
    buffer[1] = clampUnit(matrix[3] * x + matrix[4] * y + matrix[5] * z + ty);
    buffer[2] = clampUnit(matrix[6] * x + matrix[7] * y + matrix[8] * z + tz);
  };
}

function clutStage(view: DataView, offset: number, grid: number[], outputs: number, width: number): Stage | null {
  if (grid.some(points => points < 2)) throw new IccParseError('bad_tag_table');
  const strides = new Array<number>(grid.length);
  let size = outputs * width;
  // ICC stores the first input channel on the slowest-changing axis.
  for (let i = grid.length - 1; i >= 0; i--) {
    strides[i] = size;
    size *= grid[i];
  }
  checkRange(view, offset, size);
  if (grid.length > 8) return null;

  const read = sampleReader(view, width);
  const weights = new Float64Array(1 << grid.length);
  const offsets = new Float64Array(weights.length);
  return buffer => {
    let base = offset;
    weights[0] = 1;
    offsets[0] = 0;
    for (let i = 0; i < grid.length; i++) {
      const scaled = clampUnit(buffer[i]) * (grid[i] - 1);
      const lo = Math.min(Math.floor(scaled), grid[i] - 2);
      const fraction = scaled - lo;
      base += lo * strides[i];
      const corners = 1 << i;
      for (let j = 0; j < corners; j++) {
        offsets[j + corners] = offsets[j] + strides[i];
        weights[j + corners] = weights[j] * fraction;
        weights[j] *= 1 - fraction;
      }
    }
    for (let i = 0; i < outputs; i++) {
      let sum = 0;
      for (let j = 0; j < weights.length; j++) {
        if (weights[j] !== 0) sum += weights[j] * read(base + offsets[j] + i * width);
      }
      buffer[i] = sum;
    }
  };
}

function pipeline(inputs: number, outputs: number, stages: Stage[]): IccPipeline {
  const buffer = new Float64Array(Math.max(inputs, outputs));
  return {
    inputChannels: inputs,
    outputChannels: outputs,
    eval(input, out) {
      for (let i = 0; i < inputs; i++) buffer[i] = input[i];
      for (const run of stages) run(buffer);
      for (let i = 0; i < outputs; i++) out[i] = clampUnit(buffer[i]);
    },
  };
}

function readLegacyLut(view: DataView, type: 'mft1' | 'mft2', applyMatrix: boolean): IccPipeline | undefined {
  const width = type === 'mft1' ? 1 : 2;
  const tableStart = width === 1 ? 48 : 52;
  checkRange(view, 0, tableStart);
  const inputs = view.getUint8(8);
  const outputs = view.getUint8(9);
  const points = view.getUint8(10);
  if (inputs < 1 || inputs > 15 || outputs < 1 || outputs > 15 || points < 2) throw new IccParseError('bad_tag_table');
  const inCount = width === 1 ? 256 : view.getUint16(48);
  const outCount = width === 1 ? 256 : view.getUint16(50);
  if (inCount < 2 || outCount < 2) throw new IccParseError('bad_tag_table');
  const clutOffset = tableStart + inputs * inCount * width;
  const outOffset = clutOffset + points ** inputs * outputs * width;
  checkRange(view, outOffset, outputs * outCount * width);
  const clut = clutStage(view, clutOffset, Array<number>(inputs).fill(points), outputs, width);
  if (!clut) return undefined;
  const read = sampleReader(view, width);
  const tables = (offset: number, count: number, channels: number) => curveStage(
    Array.from({ length: channels }, (_, i) => tableCurve(read, offset + i * count * width, count, width)),
  );
  const stages = [tables(tableStart, inCount, inputs), clut, tables(outOffset, outCount, outputs)];
  if (applyMatrix && inputs === 3) {
    stages.unshift(matrixStage(Array.from({ length: 9 }, (_, i) => fixed(view, 12 + i * 4))));
  }
  return pipeline(inputs, outputs, stages);
}

function readMultiStageLut(view: DataView, type: 'mAB ' | 'mBA '): IccPipeline | undefined {
  checkRange(view, 0, 32);
  const inputs = view.getUint8(8);
  const outputs = view.getUint8(9);
  if (inputs < 1 || inputs > 15 || outputs < 1 || outputs > 15) throw new IccParseError('bad_tag_table');
  const aToB = type === 'mAB ';
  const aChannels = aToB ? inputs : outputs;
  const bChannels = aToB ? outputs : inputs;
  const offsets = Array.from({ length: 5 }, (_, i) => view.getUint32(12 + i * 4));
  const elements = offsets.map(offset => {
    if (offset === 0) return undefined;
    if (offset < 32 || offset % 4 !== 0) throw new IccParseError('bad_tag_table');
    checkRange(view, offset, 1);
    const end = Math.min(view.byteLength, ...offsets.filter(next => next > offset));
    return viewOf(view, offset, end - offset);
  });
  let supported = inputs <= 8;
  function curves(element: DataView | undefined, channels: number): Stage | undefined {
    if (!element) return undefined;
    const list: Curve[] = [];
    let offset = 0;
    for (let i = 0; i < channels; i++) {
      const { curve, size } = readCurve(element, offset);
      if (size === 0) {
        supported = false;
        return undefined;
      }
      if (curve) list.push(curve);
      else supported = false;
      offset += Math.ceil(size / 4) * 4;
    }
    return curveStage(list);
  }
  const [bCurves, matrix, mCurves, clut, aCurves] = elements;
  const b = curves(bCurves, bChannels);
  const m = curves(mCurves, bChannels);
  const a = curves(aCurves, aChannels);
  let matrixOp: Stage | undefined;
  if (matrix) {
    checkRange(matrix, 0, 48);
    if (bChannels !== 3) supported = false;
    matrixOp = matrixStage(Array.from({ length: 12 }, (_, i) => fixed(matrix, i * 4)));
  }
  let clutOp: Stage | null = null;
  if (clut) {
    checkRange(clut, 0, 20);
    const width = clut.getUint8(16);
    if (width !== 1 && width !== 2) throw new IccParseError('bad_tag_table');
    const grid = Array.from({ length: inputs }, (_, i) => clut.getUint8(i));
    clutOp = clutStage(clut, 20, grid, outputs, width);
  }
  if (!supported || (!clutOp && inputs !== outputs)) return undefined;
  const stages = aToB ? [a, clutOp, m, matrixOp, b] : [b, matrixOp, m, clutOp, a];
  return pipeline(inputs, outputs, stages.filter((stage): stage is Stage => !!stage));
}

function readTag(view: DataView, name: string, pcs: IccHeader['pcs']): Tag {
  checkRange(view, 0, 8);
  const type = signature(view, 0);
  switch (type) {
    case 'desc':
      checkRange(view, 8, 4);
      return { text: ascii(view, 12, view.getUint32(8)) };
    case 'mluc': return { text: readMluc(view) };
    case 'text': return { text: ascii(view, 8, view.byteLength - 8) };
    case 'XYZ ': return { xyz: readXyz(view, 8) };
    case 'curv':
    case 'para': return { curve: readCurve(view, 0).curve ?? undefined };
    case 'mft1':
    case 'mft2': return { lutType: type, lut: readLegacyLut(view, type, pcs === 'XYZ' && !name.startsWith('A2B')) };
    case 'mAB ':
    case 'mBA ': return { lutType: type, lut: readMultiStageLut(view, type) };
    default: return {};
  }
}

export function parseIccProfile(bytes: Uint8Array): IccProfile {
  if (bytes.length < 132) throw new IccParseError('too_small');
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = input.getUint32(0);
  if (size < 132 || size > bytes.length) throw new IccParseError('bad_size');
  if (signature(input, 36) !== 'acsp') throw new IccParseError('bad_signature');
  const major = input.getUint8(8);
  const minor = input.getUint8(9) >> 4;
  const pcs = signature(input, 20).trim();
  if ((major !== 2 && major !== 4) || (pcs !== 'XYZ' && pcs !== 'Lab')) throw new IccParseError('unsupported');
  const header: IccHeader = {
    size, version: `${major}.${minor}`, pcs,
    deviceClass: signature(input, 12).trim(), colorSpace: signature(input, 16).trim(),
    renderingIntent: input.getUint32(64),
  };
  // Uint8Array.from also copies Node Buffer inputs.
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer, 0, size);
  const count = view.getUint32(128);
  if (count > 1024) throw new IccParseError('bad_tag_table');
  const tableEnd = 132 + count * 12;
  checkRange(view, 132, count * 12);
  const tags = new Map<string, Tag>();
  const shared = new Map<string, Tag>();
  for (let i = 0; i < count; i++) {
    const entry = 132 + i * 12;
    const name = signature(view, entry);
    const offset = view.getUint32(entry + 4);
    const length = view.getUint32(entry + 8);
    if (offset < tableEnd || tags.has(name)) throw new IccParseError('bad_tag_table');
    const key = `${offset}/${length}/${name.startsWith('A2B')}`;
    let tag = shared.get(key);
    if (!tag) {
      tag = readTag(viewOf(view, offset, length), name, pcs);
      shared.set(key, tag);
    }
    tags.set(name, tag);
  }
  const profile: IccProfile = {
    header, bytes: copy, tagSignatures: [...tags.keys()],
    description: tags.get('desc')?.text ?? '', copyright: tags.get('cprt')?.text ?? '',
    mediaWhite: tags.get('wtpt')?.xyz ?? null,
  };
  parsedTags.set(profile, tags);
  return profile;
}

function tagsFor(profile: IccProfile): Map<string, Tag> {
  return parsedTags.get(profile) ?? parsedTags.get(parseIccProfile(profile.bytes))!;
}

function matrixTrc(profile: IccProfile, tags: Map<string, Tag>, forward: boolean): IccPipeline | null {
  if (profile.header.colorSpace === 'GRAY') {
    const gray = tags.get('kTRC')?.curve;
    if (!gray) return null;
    if (!forward) {
      const inverse = invertCurve(gray);
      return inverse ? { inputChannels: 3, outputChannels: 1, eval(input, out) { out[0] = inverse(input[1]); } } : null;
    }
    return {
      inputChannels: 1, outputChannels: 3,
      eval(input, out) {
        const value = gray(input[0]);
        for (let i = 0; i < 3; i++) out[i] = value * D50_WHITE[i];
      },
    };
  }
  if (profile.header.colorSpace !== 'RGB' || profile.header.pcs !== 'XYZ') return null;
  const [r, g, b] = ['rXYZ', 'gXYZ', 'bXYZ'].map(name => tags.get(name)?.xyz);
  const curves = ['rTRC', 'gTRC', 'bTRC'].map(name => tags.get(name)?.curve);
  if (!r || !g || !b || !curves.every((curve): curve is Curve => !!curve)) return null;
  const matrix = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const transform = forward ? matrix : invertMatrix3(matrix);
  const tones = forward ? curves : curves.map(invertCurve);
  if (!transform || !tones.every((curve): curve is Curve => !!curve)) return null;
  return {
    inputChannels: 3, outputChannels: 3,
    eval(input, out) {
      const x = forward ? tones[0](input[0]) : input[0];
      const y = forward ? tones[1](input[1]) : input[1];
      const z = forward ? tones[2](input[2]) : input[2];
      for (let i = 0; i < 3; i++) {
        const value = transform[3 * i] * x + transform[3 * i + 1] * y + transform[3 * i + 2] * z;
        out[i] = forward ? value : tones[i](value);
      }
    },
  };
}

function invertCurve(curve: Curve): Curve | null {
  const steps = 4096;
  const samples = new Float64Array(steps + 1);
  samples[0] = curve(0);
  for (let i = 1; i <= steps; i++) {
    const value = curve(i / steps);
    // Fixed-point curve coefficients can round down slightly at a segment boundary.
    if (!(value >= samples[i - 1] - 1 / 65535)) return null;
    samples[i] = Math.max(value, samples[i - 1]);
  }
  if (!(samples[steps] > samples[0])) return null;
  return target => {
    if (target <= samples[0]) return 0;
    if (target >= samples[steps]) return 1;
    let lo = 0;
    let hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid] < target) lo = mid;
      else hi = mid;
    }
    return (lo + (target - samples[lo]) / (samples[hi] - samples[lo])) / steps;
  };
}

function adaptPcs(lut: IccPipeline, type: LutType, pcs: IccHeader['pcs'], direction: Direction): IccPipeline {
  const labL = type === 'mft2' ? 65535 / 65280 * 100 : 100;
  const labAb = type === 'mft2' ? 65535 / 256 : 255;
  const xyz: Vec3 = [0, 0, 0];
  const lab: Vec3 = [0, 0, 0];
  return {
    inputChannels: lut.inputChannels,
    outputChannels: lut.outputChannels,
    eval(input, out) {
      if (direction === 'toPcs') {
        lut.eval(input, out);
        if (pcs === 'Lab') {
          lab[0] = out[0] * labL;
          lab[1] = out[1] * labAb - 128;
          lab[2] = out[2] * labAb - 128;
          labToXyz(lab, D50_WHITE, xyz);
          out.set(xyz);
        } else {
          for (let i = 0; i < 3; i++) out[i] *= XYZ_SCALE;
        }
        return;
      }
      for (let i = 0; i < 3; i++) xyz[i] = input[i];
      if (pcs === 'Lab') {
        xyzToLab(xyz, D50_WHITE, lab);
        xyz[0] = lab[0] / labL;
        xyz[1] = (lab[1] + 128) / labAb;
        xyz[2] = (lab[2] + 128) / labAb;
      } else {
        for (let i = 0; i < 3; i++) xyz[i] /= XYZ_SCALE;
      }
      for (let i = 0; i < 3; i++) xyz[i] = clampUnit(xyz[i]);
      lut.eval(xyz, out);
    },
  };
}

function deviceChannels(colorSpace: string): number | undefined {
  if (colorSpace === 'GRAY') return 1;
  if (colorSpace === 'CMYK') return 4;
  if (['RGB', 'XYZ', 'Lab', 'Luv', 'YCbr', 'Yxy', 'HSV', 'HLS', 'CMY'].includes(colorSpace)) return 3;
  if (/^[2-9A-F]CLR$/.test(colorSpace)) return Number.parseInt(colorSpace[0], 16);
  return undefined;
}

function devicePipeline(profile: IccProfile, intent: IccIntent, forward: boolean): IccPipeline | null {
  const tags = tagsFor(profile);
  const prefix = forward ? 'A2B' : 'B2A';
  const tag = tags.get(`${prefix}${intent === 'relative' ? 1 : 0}`) ?? tags.get(`${prefix}0`);
  if (!tag) return matrixTrc(profile, tags, forward);
  const { lut, lutType } = tag;
  const channels = deviceChannels(profile.header.colorSpace);
  if (!lut || !lutType || (forward ? lutType === 'mBA ' : lutType === 'mAB ')) return null;
  if (lut.inputChannels !== (forward ? channels : 3) || lut.outputChannels !== (forward ? 3 : channels)) return null;
  return adaptPcs(lut, lutType, profile.header.pcs, forward ? 'toPcs' : 'fromPcs');
}

export function createDeviceToPcs(profile: IccProfile, intent: IccIntent): IccPipeline | null {
  return devicePipeline(profile, intent, true);
}

export function createPcsToDevice(profile: IccProfile, intent: IccIntent): IccPipeline | null {
  return devicePipeline(profile, intent, false);
}

export function createGamutCheck(profile: IccProfile): IccPipeline | null {
  const tag = tagsFor(profile).get('gamt');
  if (!tag?.lut || !tag.lutType || tag.lut.inputChannels !== 3 || tag.lut.outputChannels !== 1) return null;
  return adaptPcs(tag.lut, tag.lutType, profile.header.pcs, 'gamut');
}

export function isProofableProfile(profile: IccProfile): boolean {
  return ['CMYK', 'RGB', 'GRAY'].includes(profile.header.colorSpace)
    && !!(createDeviceToPcs(profile, 'relative') ?? createDeviceToPcs(profile, 'perceptual'))
    && !!(createPcsToDevice(profile, 'relative') ?? createPcsToDevice(profile, 'perceptual'));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

function writeXyz(view: DataView, offset: number, xyz: Vec3): void {
  xyz.forEach((value, i) => view.setInt32(offset + i * 4, Math.round(value * 65536)));
}

export function createSrgbIccProfile(): Uint8Array {
  const description = 'sRGB IEC61966-2.1 (Lumina)';
  const copyright = 'No copyright, use freely';
  const tags = ['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'];
  const descSize = 12 + description.length + 1 + 8 + 70;
  const copyrightSize = 8 + copyright.length + 1;
  const count = 1024;
  const sizes = [descSize, copyrightSize, 20, 20, 20, 20, 12 + count * 2];
  let size = 132 + tags.length * 12;
  const offsets = sizes.map(length => {
    const offset = size;
    size += Math.ceil(length / 4) * 4;
    return offset;
  });
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  view.setUint8(8, 2);
  view.setUint8(9, 0x10);
  writeAscii(view, 12, 'mntrRGB XYZ ');
  view.setUint16(24, 2000);
  view.setUint16(26, 1);
  view.setUint16(28, 1);
  writeAscii(view, 36, 'acsp');
  writeXyz(view, 68, D50_WHITE);
  view.setUint32(128, tags.length);
  tags.forEach((name, i) => {
    const entry = 132 + i * 12;
    writeAscii(view, entry, name);
    view.setUint32(entry + 4, offsets[Math.min(i, 6)]);
    view.setUint32(entry + 8, sizes[Math.min(i, 6)]);
  });
  writeAscii(view, offsets[0], 'desc');
  view.setUint32(offsets[0] + 8, description.length + 1);
  writeAscii(view, offsets[0] + 12, description);
  writeAscii(view, offsets[1], 'text');
  writeAscii(view, offsets[1] + 8, copyright);
  const xyzValues: Vec3[] = [D50_WHITE, ...[0, 1, 2].map((i): Vec3 => [
    SRGB_D50_MATRIX[i], SRGB_D50_MATRIX[i + 3], SRGB_D50_MATRIX[i + 6],
  ])];
  xyzValues.forEach((xyz, i) => {
    writeAscii(view, offsets[2 + i], 'XYZ ');
    writeXyz(view, offsets[2 + i] + 8, xyz);
  });
  const trc = offsets[6];
  writeAscii(view, trc, 'curv');
  view.setUint32(trc + 8, count);
  for (let i = 0; i < count; i++) view.setUint16(trc + 12 + i * 2, Math.round(srgbToLinear(i / (count - 1)) * 65535));
  return bytes;
}

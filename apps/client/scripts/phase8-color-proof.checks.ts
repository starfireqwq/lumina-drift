import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CmykPrintModel, getPrintConditionPreset, PRINT_CONDITION_PRESETS } from '../src/engine/color/cmykPrintModel';
import {
  clampUnit, D50_WHITE, deltaE2000, deltaE76, labToXyz, srgb8ToXyzD50, xyzToLab, type Vec3,
} from '../src/engine/color/colorMath';
import {
  createDeviceToPcs, createGamutCheck, createPcsToDevice, createSrgbIccProfile, IccParseError, isProofableProfile,
  parseIccProfile, type IccParseErrorCode,
} from '../src/engine/color/iccProfile';
import {
  applySoftProofToRgba, buildSoftProofLut, createProofTransform, sampleSoftProofLut, softProofCacheKey,
  type ProofOptions, type ProofSource,
} from '../src/engine/color/softProof';

const builtin: ProofSource = { kind: 'builtin', id: 'fogra39' };
const options: ProofOptions = { intent: 'relative', blackPointCompensation: false };
const proofColors: [Vec3, boolean][] = [
  [[0, 0, 255], true], [[0, 255, 0], true], [[128, 128, 128], false], [[230, 190, 160], false],
];

function near(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance: number): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `channel ${i}: ${actual[i]} vs ${expected[i]} (±${tolerance})`);
  }
}

function rng(seed: number): () => number {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function checkColorMath(): void {
  near(srgb8ToXyzD50(255, 255, 255), D50_WHITE, 1e-3);
  for (const lab of [[0, 0, 0], [5, 7, -2], [50, -42, 73], [93, 2, -11], [100, 0, 0]] as Vec3[]) {
    near(xyzToLab(labToXyz(lab)), lab, 1e-9);
  }
  // Sharma, Wu & Dalal (2005), supplementary CIEDE2000 test pairs.
  const pairs: [Vec3, Vec3, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.0200], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, -0.001, 2.49], [50, 0.001, -2.49], 4.8045],
    [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
  ];
  for (const [a, b, expected] of pairs) {
    near([deltaE2000(a, b), deltaE2000(b, a)], [expected, expected], 1e-3);
  }
}

function putSignature(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

function iccBytes(version: number, pcs: string, tags: [string, Uint8Array][], colorSpace = 'CMYK'): Uint8Array {
  let size = 132 + tags.length * 12;
  const offsets = new Map<Uint8Array, number>();
  for (const [, tag] of tags) {
    if (offsets.has(tag)) continue;
    offsets.set(tag, size);
    size += Math.ceil(tag.length / 4) * 4;
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  view.setUint8(8, version);
  view.setUint8(9, version === 4 ? 0x30 : 0x10);
  putSignature(view, 12, `prtr${colorSpace}${pcs}`);
  putSignature(view, 36, 'acsp');
  view.setUint32(128, tags.length);
  tags.forEach(([name, data], i) => {
    const entry = 132 + i * 12;
    const offset = offsets.get(data)!;
    putSignature(view, entry, name);
    view.setUint32(entry + 4, offset);
    view.setUint32(entry + 8, data.length);
    bytes.set(data, offset);
  });
  return bytes;
}

function checkIccParsing(): void {
  const srgb = createSrgbIccProfile();
  assert.equal(srgb.length % 4, 0);
  assert.deepEqual(createSrgbIccProfile(), srgb);
  const profile = parseIccProfile(srgb);
  assert.equal(profile.description, 'sRGB IEC61966-2.1 (Lumina)');
  assert.equal(profile.copyright, 'No copyright, use freely');
  assert.equal(profile.header.version, '2.1');
  near(profile.mediaWhite!, D50_WHITE, 1 / 65536);
  assert.notEqual(profile.bytes.buffer, srgb.buffer);
  const xyz = new Float64Array(3);
  const rgb = new Float64Array(3);
  createDeviceToPcs(profile, 'relative')!.eval([1, 0, 0], xyz);
  near(xyz, [0.4360747, 0.2225045, 0.0139322], 2e-3);
  createPcsToDevice(profile, 'relative')!.eval(xyz, rgb);
  near(rgb, [1, 0, 0], 2e-3);

  function error(bytes: Uint8Array, code: IccParseErrorCode): void {
    assert.throws(() => parseIccProfile(bytes), (e: unknown) => e instanceof IccParseError && e.code === code);
  }
  error(srgb.subarray(0, 131), 'too_small');
  error(srgb.subarray(0, srgb.length - 1), 'bad_size');
  const broken = srgb.slice();
  broken[36] = 0;
  error(broken, 'bad_signature');
  broken.set(srgb);
  const view = new DataView(broken.buffer);
  view.setUint32(136, broken.length);
  error(broken, 'bad_tag_table');
  broken.set(srgb);
  view.setUint32(128, 1025);
  error(broken, 'bad_tag_table');
  broken.set(srgb);
  view.setUint32(view.getUint32(136) + 8, 0xffffffff);
  error(broken, 'bad_tag_table');
}

function parameterCurve(fn: number, values: number[]): Uint8Array {
  const bytes = new Uint8Array(12 + 4 * values.length);
  const view = new DataView(bytes.buffer);
  putSignature(view, 0, 'para');
  view.setUint16(8, fn);
  values.forEach((value, i) => view.setInt32(12 + i * 4, value * 65536));
  return bytes;
}

function localizedText(records: [string, string][]): Uint8Array {
  let offset = 16 + 12 * records.length;
  const bytes = new Uint8Array(offset + records.reduce((size, [, text]) => size + text.length * 2, 0));
  const view = new DataView(bytes.buffer);
  putSignature(view, 0, 'mluc');
  view.setUint32(8, records.length);
  view.setUint32(12, 12);
  records.forEach(([language, value], i) => {
    const record = 16 + i * 12;
    putSignature(view, record, language);
    view.setUint32(record + 4, value.length * 2);
    view.setUint32(record + 8, offset);
    for (let j = 0; j < value.length; j++, offset += 2) view.setUint16(offset, value.charCodeAt(j));
  });
  return bytes;
}

function checkCurvesAndText(): void {
  const desc = localizedText([['jaJP', '色彩'], ['enUS', 'English']]);
  const copyright = localizedText([['jaJP', '色彩'], ['deDE', 'Farbe']]);
  const out = new Float64Array(3);
  const input = new Float64Array(1);
  const examples: [number[], number, number][] = [
    [[2], 0.015625, 0.5625],
    [[2, 1, -0.25], 0, 0.25],
    [[2, 1, -0.25, 0.125], 0.125, 0.375],
    [[2, 1, 0, 0.25, 0.25], 0.03125, 0.5625],
    [[2, 1, 0, 0.25, 0.25, 0.125, 0.125], 0.15625, 0.6875],
  ];
  examples.forEach(([values, low, high], fn) => {
    const profile = parseIccProfile(iccBytes(4, 'Lab ', [['desc', desc], ['cprt', copyright], ['kTRC', parameterCurve(fn, values)]], 'GRAY'));
    assert.equal(profile.description, 'English');
    assert.equal(profile.copyright, '色彩');
    const forward = createDeviceToPcs(profile, 'relative')!;
    forward.eval([0.125], out);
    near(out, D50_WHITE.map(value => value * low), 1e-12);
    forward.eval([0.75], out);
    near(out, D50_WHITE.map(value => value * high), 1e-12);
    createPcsToDevice(profile, 'relative')!.eval(out, input);
    near(input, [0.75], 1e-6);
  });
  const malformed = desc.slice();
  new DataView(malformed.buffer).setUint32(24, malformed.length - 1);
  assert.throws(() => parseIccProfile(iccBytes(4, 'XYZ ', [['desc', malformed]])), { code: 'bad_tag_table' });
}

function checkMultiStageMatrix(): void {
  const b = parameterCurve(0, [2]);
  const m = parameterCurve(1, [1, 0.5, 0]);
  function tag(type: 'mAB ' | 'mBA '): Uint8Array {
    const mOffset = 32 + b.length * 3;
    const matrixOffset = mOffset + m.length * 3;
    const bytes = new Uint8Array(matrixOffset + 48);
    const view = new DataView(bytes.buffer);
    putSignature(view, 0, type);
    view.setUint8(8, 3);
    view.setUint8(9, 3);
    view.setUint32(12, 32);
    view.setUint32(16, matrixOffset);
    view.setUint32(20, mOffset);
    for (let i = 0; i < 3; i++) {
      bytes.set(b, 32 + i * b.length);
      bytes.set(m, mOffset + i * m.length);
      view.setInt32(matrixOffset + i * 16, 0.75 * 65536);
      view.setInt32(matrixOffset + 36 + i * 4, 8192 >> i);
    }
    return bytes;
  }

  const forward = tag('mAB ');
  const reverse = tag('mBA ');
  const unsupported = new Uint8Array(8);
  putSignature(new DataView(unsupported.buffer), 0, 'mpet');
  const tags: [string, Uint8Array][] = [['A2B0', forward], ['B2A0', reverse], ['B2A1', unsupported]];
  const profile = parseIccProfile(iccBytes(4, 'XYZ ', tags, 'RGB '));
  const normalized = [0.25, 0.5, 0.75];
  const xyzScale = 65535 / 32768;
  const out = new Float64Array(3);
  createDeviceToPcs(profile, 'relative')!.eval(normalized, out);
  near(out, normalized.map((value, i) => (value * 0.375 + 0.125 / 2 ** i) ** 2 * xyzScale), 1e-12);
  createPcsToDevice(profile, 'perceptual')!.eval(normalized.map(value => value * xyzScale), out);
  near(out, normalized.map((value, i) => (value ** 2 * 0.75 + 0.125 / 2 ** i) * 0.5), 1e-12);
  assert.equal(createPcsToDevice(profile, 'relative'), null);
  assert.throws(() => createProofTransform({ kind: 'icc', profile }, options), { message: 'unsupported_profile' });

  new DataView(forward.buffer).setUint32(16, forward.length - 4);
  assert.throws(() => parseIccProfile(iccBytes(4, 'XYZ ', tags, 'RGB ')), { code: 'bad_tag_table' });
}

function quantizedWriter(bytes: Uint8Array, offset: number, width: number): (value: number) => void {
  const view = new DataView(bytes.buffer);
  return value => {
    if (width === 1) view.setUint8(offset, Math.round(clampUnit(value) * 255));
    else view.setUint16(offset, Math.round(clampUnit(value) * 65535));
    offset += width;
  };
}

function gridPoints(grid: number[], visit: (point: number[]) => void): void {
  const count = grid.reduce((product, points) => product * points, 1);
  const point = new Array<number>(grid.length);
  for (let i = 0; i < count; i++) {
    let index = i;
    for (let dim = grid.length - 1; dim >= 0; dim--) {
      point[dim] = index % grid[dim] / (grid[dim] - 1);
      index = Math.floor(index / grid[dim]);
    }
    visit(point);
  }
}

type LutFixture = 'mft1' | 'mft2' | 'mAB ' | 'mBA ';
type ColorSampler = (point: number[]) => number[];

function lutTag(type: LutFixture, grid: number[], output: number, sample: ColorSampler): Uint8Array {
  const input = grid.length;
  const samples = grid.reduce((count, points) => count * points, output);
  const width = type === 'mft1' ? 1 : 2;
  if (type === 'mft1' || type === 'mft2') {
    assert.ok(grid.every(points => points === grid[0]));
    const entries = width === 1 ? 256 : 2;
    const start = width === 1 ? 48 : 52;
    const bytes = new Uint8Array(start + (entries * (input + output) + samples) * width);
    const view = new DataView(bytes.buffer);
    putSignature(view, 0, type);
    view.setUint8(8, input);
    view.setUint8(9, output);
    view.setUint8(10, grid[0]);
    // A deliberately non-identity matrix has no effect for Lab PCS.
    for (const diagonal of [12, 28, 44]) view.setInt32(diagonal, 32768);
    if (width === 2) {
      view.setUint16(48, entries);
      view.setUint16(50, entries);
    }
    const write = quantizedWriter(bytes, start, width);
    for (let c = 0; c < input; c++) for (let i = 0; i < entries; i++) write(i / (entries - 1));
    gridPoints(grid, point => sample(point).forEach(write));
    for (let c = 0; c < output; c++) for (let i = 0; i < entries; i++) write(i / (entries - 1));
    return bytes;
  }

  const bChannels = type === 'mAB ' ? output : input;
  const aChannels = type === 'mAB ' ? input : output;
  const aOffset = 32 + bChannels * 12;
  const clutOffset = aOffset + aChannels * 12;
  const bytes = new Uint8Array(clutOffset + 20 + samples * width);
  const view = new DataView(bytes.buffer);
  putSignature(view, 0, type);
  view.setUint8(8, input);
  view.setUint8(9, output);
  view.setUint32(12, 32);
  view.setUint32(24, clutOffset);
  view.setUint32(28, aOffset);
  for (let i = 0; i < bChannels + aChannels; i++) putSignature(view, 32 + i * 12, 'curv');
  grid.forEach((points, i) => view.setUint8(clutOffset + i, points));
  view.setUint8(clutOffset + 16, width);
  const write = quantizedWriter(bytes, clutOffset + 20, width);
  gridPoints(grid, point => sample(point).forEach(write));
  return bytes;
}

function syntheticCmyk(type: 'mft1' | 'mft2' | 'mAB ', model: CmykPrintModel): ProofSource {
  const modern = type === 'mAB ';
  const labL = type === 'mft2' ? 65535 / 65280 * 100 : 100;
  const labAb = type === 'mft2' ? 65535 / 256 : 255;
  const xyzScale = 65535 / 32768;
  const forward = lutTag(type, modern ? [11, 12, 13, 14] : [13, 13, 13, 13], 3, ([c, m, y, k]) => {
    const xyz = model.cmykToRelativeXyz(c, m, y, k);
    if (modern) return xyz.map(value => value / xyzScale);
    const [l, a, b] = xyzToLab(xyz);
    return [l / labL, (a + 128) / labAb, (b + 128) / labAb];
  });
  const reverse = lutTag(modern ? 'mBA ' : type, modern ? [17, 18, 19] : [21, 21, 21], 4, ([x, y, z]) => {
    const xyz = modern ? [x * xyzScale, y * xyzScale, z * xyzScale] as Vec3 : labToXyz([x * labL, y * labAb - 128, z * labAb - 128]);
    return model.relativeXyzToCmyk(xyz).cmyk;
  });
  const tags: [string, Uint8Array][] = [['A2B0', forward], ['A2B1', forward], ['B2A0', reverse], ['B2A1', reverse]];
  return { kind: 'icc', profile: parseIccProfile(iccBytes(modern ? 4 : 2, modern ? 'XYZ ' : 'Lab ', tags)) };
}

function checkSyntheticIcc(): ProofSource {
  const model = new CmykPrintModel(getPrintConditionPreset('fogra39'));
  const mft2 = syntheticCmyk('mft2', model);
  const sample = rng(281);
  const inks = Array.from({ length: 50 }, (): [number, number, number, number] => [sample(), sample(), sample(), sample()]);
  for (const source of [mft2, syntheticCmyk('mAB ', model), syntheticCmyk('mft1', model)]) {
    assert.equal(source.kind, 'icc');
    assert.ok(isProofableProfile(source.profile));
    const toPcs = createDeviceToPcs(source.profile, 'relative')!;
    assert.equal(toPcs.inputChannels, 4);
    assert.equal(toPcs.outputChannels, 3);
    const out = new Float64Array(3);
    for (const ink of inks) {
      toPcs.eval(ink, out);
      const diff = deltaE2000(xyzToLab([out[0], out[1], out[2]]), xyzToLab(model.cmykToRelativeXyz(...ink)));
      assert.ok(diff < 1.5, `${source.profile.header.version} ${ink}: ΔE ${diff}`);
    }
    const proof = createProofTransform(source, options);
    for (const [rgb, outOfGamut] of proofColors) {
      const result = proof.proof(...rgb);
      assert.equal(result.outOfGamut, outOfGamut, `${source.profile.header.version} ${rgb}: ΔE ${result.deltaE}`);
    }
  }
  return mft2;
}

function checkGamutTag(): void {
  const identity = lutTag('mft2', [2, 2, 2], 3, point => point);
  const gamut = lutTag('mft2', [2, 2, 2], 1, () => [1]);
  const profile = parseIccProfile(iccBytes(2, 'XYZ ', [['A2B0', identity], ['B2A0', identity], ['gamt', gamut]], 'RGB '));
  const xyz = new Float64Array(3);
  createDeviceToPcs(profile, 'relative')!.eval([0.25, 0.35, 0.45], xyz);
  near(xyz, [0.25, 0.35, 0.45].map(value => value * 65535 / 32768), 1e-9);
  const device = new Float64Array(3);
  createPcsToDevice(profile, 'relative')!.eval(xyz, device);
  near(device, [0.125, 0.175, 0.225], 1e-9);
  createGamutCheck(profile)!.eval(xyz, device);
  assert.equal(device[0], 1);
  assert.ok(createProofTransform({ kind: 'icc', profile }, { ...options, gamutThreshold: 200 }).proof(128, 128, 128).outOfGamut);
}

function checkPrintModel(): void {
  for (const preset of PRINT_CONDITION_PRESETS) {
    const model = new CmykPrintModel(preset);
    const s = preset.solids;
    const points: [[number, number, number, number], Vec3][] = [
      [[0, 0, 0, 0], preset.paper], [[1, 0, 0, 0], s.c], [[0, 1, 0, 0], s.m], [[0, 0, 1, 0], s.y],
      [[0, 0, 0, 1], s.k], [[1, 1, 0, 0], s.cm], [[1, 0, 1, 0], s.cy], [[0, 1, 1, 0], s.my], [[1, 1, 1, 0], s.cmy],
    ];
    for (const [ink, expected] of points) assert.ok(deltaE76(model.cmykToLab(...ink), expected) < 0.01);
    assert.ok(model.blackPoint[1] <= model.cmykToRelativeXyz(1, 1, 0, 1)[1] + 1e-12);
    assert.deepEqual(model.relativeXyzToCmyk(D50_WHITE).cmyk, [0, 0, 0, 0]);
    assert.deepEqual(model.relativeXyzToCmyk(srgb8ToXyzD50(255, 255, 255)).cmyk, [0, 0, 0, 0]);

    const sample = rng(904);
    let passing = 0;
    for (let i = 0; i < 500;) {
      const ink: [number, number, number, number] = [sample(), sample(), sample(), sample()];
      if (ink.reduce((sum, value) => sum + value, 0) > preset.tac) continue;
      i++;
      const target = model.cmykToRelativeXyz(...ink);
      const separated = model.relativeXyzToCmyk(target);
      assert.ok(separated.cmyk.every(value => value >= 0 && value <= 1));
      assert.ok(separated.cmyk.reduce((sum, value) => sum + value, 0) <= preset.tac + 1e-6);
      const printed = model.cmykToRelativeXyz(...separated.cmyk);
      near(printed, separated.xyz, 1e-12);
      if (deltaE2000(xyzToLab(printed), xyzToLab(target)) < 1) passing++;
    }
    assert.ok(passing >= 490, `${preset.id}: ${passing}/500`);
    for (const blackPointCompensation of [true, false]) {
      const proof = createProofTransform({ kind: 'builtin', id: preset.id }, { ...options, blackPointCompensation });
      near(proof.proof(255, 255, 255).rgb, [255, 255, 255], 1);
      for (const [rgb, gamut] of proofColors) assert.equal(proof.proof(...rgb).outOfGamut, gamut, `${preset.id}: ${rgb}`);
    }
  }
}

async function checkLut(icc: ProofSource): Promise<void> {
  const proof = createProofTransform(builtin, options);
  const progress: number[] = [];
  const lut = await buildSoftProofLut(builtin, options, { size: 17, onProgress(done, total) {
    assert.equal(total, 17);
    progress.push(done);
  } });
  assert.deepEqual(progress, Array.from({ length: 17 }, (_, i) => i + 1));
  for (let b = 0; b < 17; b++) for (let g = 0; g < 17; g++) for (let r = 0; r < 17; r++) {
    const rgb: Vec3 = [r * 255 / 16, g * 255 / 16, b * 255 / 16];
    const expected = proof.proof(...rgb);
    const sampled = sampleSoftProofLut(lut, ...rgb);
    near(sampled.rgb, expected.rgb, 1);
    assert.equal(sampled.gamut, Number(expected.outOfGamut), `${rgb}`);
  }
  const random = rng(1987);
  let totalError = 0;
  for (let i = 0; i < 200; i++) {
    const rgb: Vec3 = [random() * 255, random() * 255, random() * 255];
    const expected = proof.proof(...rgb).rgb;
    const sampled = sampleSoftProofLut(lut, ...rgb).rgb;
    totalError += deltaE76(expected, sampled);
  }
  assert.ok(totalError / 200 <= 3, `mean RGB error ${totalError / 200}`);

  const rgba = new Uint8ClampedArray([0, 0, 255, 127, 0, 255, 0, 0, 128, 128, 128, 255]);
  applySoftProofToRgba(lut, rgba, { proof: true, gamutWarning: true, warningColor: [7, 23, 248] });
  assert.deepEqual(Array.from(rgba.slice(0, 8)), [7, 23, 248, 127, 0, 255, 0, 0]);
  assert.equal(rgba[11], 255);
  const controller = new AbortController();
  const visits: number[] = [];
  await assert.rejects(buildSoftProofLut(builtin, options, { size: 9, signal: controller.signal, onProgress(done) {
    visits.push(done);
    if (done === 2) controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual(visits, [1, 2]);
  const key = softProofCacheKey(builtin, options, 17);
  assert.equal(softProofCacheKey(builtin, { ...options, gamutThreshold: 3 }, 17), key);
  assert.notEqual(softProofCacheKey(builtin, { ...options, blackPointCompensation: true }, 17), key);
  assert.notEqual(softProofCacheKey(builtin, { ...options, intent: 'perceptual' }, 17), key);
  assert.notEqual(softProofCacheKey(builtin, { ...options, gamutThreshold: 4 }, 17), key);
  assert.notEqual(softProofCacheKey(builtin, options, 33), key);
  assert.notEqual(softProofCacheKey(icc, options, 17), key);

  const builtinMs = (await buildSoftProofLut(builtin, options)).buildMs;
  const iccMs = (await buildSoftProofLut(icc, options)).buildMs;
  console.log(`33³ LUT: builtin ${builtinMs.toFixed(1)} ms, ICC mft2 ${iccMs.toFixed(1)} ms`);
  assert.ok(builtinMs < 4000, `builtin LUT took ${builtinMs} ms`);
  assert.ok(iccMs < 2000, `ICC LUT took ${iccMs} ms`);
}

export async function runPhase8ColorProofChecks(): Promise<void> {
  checkColorMath();
  checkIccParsing();
  checkCurvesAndText();
  checkMultiStageMatrix();
  checkGamutTag();
  const icc = checkSyntheticIcc();
  checkPrintModel();
  await checkLut(icc);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase8ColorProofChecks().then(() => console.log('ok'), (e) => { console.error(e); process.exit(1); });
}

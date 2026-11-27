import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  AbrParser,
  BrushPackageManager,
  DEFAULT_COMMUNITY_PRESETS,
  exportPresetsToAbr,
  type AtelierBrushPreset,
} from '@atelier/shared';

function preset(name: string, properties: Partial<AtelierBrushPreset['properties']> = {}): AtelierBrushPreset {
  return {
    id: name,
    name,
    version: '1',
    createdAt: 0,
    properties: {
      size: 40, minSize: 8, color: '#000000', opacity: 0.75, flow: 0.85,
      hardness: 0.72, spacing: 0.18, isEraser: false, stabilizerLevel: 2,
      scatter: 0, angleMode: 'fixed', ...properties,
    },
  };
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function png(width: number, height: number, colorType: number, rows: number[][], bitDepth = 8, interlace = 0): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[12] = interlace;
  const data = deflateSync(Uint8Array.from(rows.flat()));
  const split = Math.floor(data.length / 2);
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', data.subarray(0, split)),
    pngChunk('IDAT', data.subarray(split)), pngChunk('IEND', new Uint8Array()),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function maskPng(width: number, rows: number[][]): string {
  return png(width, rows.length, 6, rows.map(row => [0, ...row.flatMap(alpha => [255, 255, 255, alpha])]));
}

function bmp24(): string {
  const bytes = Buffer.alloc(70);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(2, 18);
  bytes.writeInt32LE(2, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.set([64, 64, 64, 128, 128, 128, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0], 54);
  return `data:image/bmp;base64,${bytes.toString('base64')}`;
}

function assertMask(url: string | null | undefined, width: number, height: number, mask: number[]): void {
  assert.ok(url && url.startsWith('data:image/bmp;base64,'));
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(bytes.readInt32LE(18), width);
  assert.equal(bytes.readInt32LE(22), -height);
  assert.equal(bytes.readUInt16LE(28), 32);
  const start = bytes.readUInt32LE(10);
  assert.deepEqual(Array.from({ length: width * height }, (_, i) => bytes[start + i * 4 + 3]), mask);
}

function assertPadding(bytes: Buffer, end: number): number {
  const alignedEnd = Math.ceil(end / 4) * 4;
  assert.ok(alignedEnd <= bytes.length);
  assert.ok(bytes.subarray(end, alignedEnd).every(value => value === 0));
  return alignedEnd;
}

function sections(file: Uint8Array): Map<string, Buffer> {
  const bytes = Buffer.from(file);
  assert.equal(bytes.readInt16BE(0), 6);
  assert.equal(bytes.readInt16BE(2), 2);
  const result = new Map<string, Buffer>();
  for (let offset = 4; offset < bytes.length;) {
    assert.equal(bytes.toString('ascii', offset, offset + 4), '8BIM');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const start = offset + 12;
    const end = start + bytes.readUInt32BE(offset + 8);
    assert.ok(!result.has(type));
    result.set(type, bytes.subarray(start, end));
    offset = assertPadding(bytes, end);
  }
  assert.equal(result.get('desc')?.readUInt32BE(), 16);
  return result;
}

function records(section: Buffer): Buffer[] {
  const result: Buffer[] = [];
  for (let offset = 0; offset < section.length;) {
    const end = offset + 4 + section.readUInt32BE(offset);
    result.push(section.subarray(offset + 4, end));
    offset = assertPadding(section, end);
  }
  return result;
}

function assertUuid(record: Buffer, offset: number): void {
  assert.equal(record[offset], 36);
  assert.match(record.toString('ascii', offset + 1, offset + 37), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
}

test('computed brush round trips geometry, pressure, angle, scatter, color, and wet edges', async () => {
  const source = preset('Computed brush', {
    tipAngle: -23, roundness: 0.65, angleMode: 'direction', scatter: 0.36, wetEdges: true,
    colorDynamics: { hueJitter: 0.21, saturationJitter: 0.32, lightnessJitter: 0.43, fgBgMix: 0.24 },
    dynamics: {
      size: { pressure: true, min: 0.25, random: 0.15 },
      opacity: { pressure: true, min: 0.2, random: 0.1 },
      flow: { pressure: true, min: 0.28 },
      angle: { random: 0.34 },
      scatter: { tilt: true, random: 0.42 },
    },
  });
  const bytes = await BrushPackageManager.exportPresetToAbr(source);
  const blocks = sections(bytes);
  assert.deepEqual([...blocks.keys()], ['desc']);
  assert.ok(blocks.get('desc')?.includes('computedBrush'));
  const parsed = new AbrParser(bytes).parse();
  assert.equal(parsed.length, 1);
  const [brush] = parsed;
  assert.equal(brush.name, source.name);
  assert.equal(brush.size, 40);
  assert.equal(brush.hardness, 0.72);
  assert.equal(brush.spacing, 0.18);
  assert.equal(brush.angle, -23);
  assert.equal(brush.roundness, 0.65);
  assert.equal(brush.angleMode, 'direction');
  assert.equal(brush.scatter, 0.36);
  assert.equal(brush.wetEdges, true);
  assert.equal(brush.hueJitter, 0.21);
  assert.equal(brush.satJitter, 0.32);
  assert.equal(brush.valJitter, 0.43);
  assert.equal(brush.fgBgMix, 0.24);
  assert.equal(brush.opacity, 0.75);
  assert.equal(brush.flow, 0.85);
  assert.deepEqual(brush.dynamics?.size, { pressure: true, tilt: false, random: 0.15, min: 0.25 });
  assert.deepEqual(brush.dynamics?.opacity, { pressure: true, tilt: false, random: 0.1, min: 0.2 });
  assert.deepEqual(brush.dynamics?.flow, { pressure: true, tilt: false, random: 0, min: 0.28 });
  assert.deepEqual(brush.dynamics?.angle, { pressure: false, tilt: false, random: 0.34 });
  assert.deepEqual(brush.dynamics?.scatter, { pressure: false, tilt: true, random: 0.42 });
});

test('sampled brush round trips distinct main and dual tips and its embedded pattern', async () => {
  const main = [0, 31, 31, 31, 67, 128, 254, 255];
  const dual = [255, 64, 128, 0, 127, 187];
  const source: AtelierBrushPreset = {
    ...preset('Sampled brush', {
      textureDensity: 0.6, textureScale: 1.35, textureInvert: true, textureBlendMode: 'overlay',
      dualBrush: true, dualSize: 0.5, dualScatter: 1.2, dualSpacing: 0.28, dualBlendMode: 'screen',
      dualTipUrl: maskPng(3, [dual.slice(0, 3), dual.slice(3)]),
      customTextureUrl: bmp24(),
    }),
    tipDataUrl: maskPng(4, [main.slice(0, 4), main.slice(4)]),
  };
  const bytes = await BrushPackageManager.exportPresetToAbr(source);
  const blocks = sections(bytes);
  assert.deepEqual([...blocks.keys()], ['samp', 'patt', 'desc']);
  const samples = records(blocks.get('samp')!);
  assert.equal(samples.length, 2);
  for (const sample of samples) {
    assertUuid(sample, 0);
    assert.ok(sample.subarray(37, 301).every(value => value === 0));
    assert.equal(sample.readUInt16BE(317), 8);
    assert.equal(sample[319], 1);
  }
  const [pattern] = records(blocks.get('patt')!);
  assert.equal(pattern.readUInt32BE(0), 1);
  assert.equal(pattern.readUInt32BE(4), 1);
  const idOffset = 16 + pattern.readUInt32BE(12) * 2;
  assertUuid(pattern, idOffset);
  const vmal = idOffset + 37;
  assert.equal(pattern.readUInt32BE(vmal), 3);
  assert.equal(pattern.readUInt32BE(vmal + 4), pattern.length - vmal - 8);
  assert.equal(pattern.readUInt32BE(vmal + 24), 24);
  assert.equal(pattern.readUInt32BE(vmal + 28), 1);
  const channel = vmal + 36;
  assert.equal(pattern.readUInt32BE(channel), 8);
  assert.equal(pattern[channel + 22], 1);
  assert.equal(channel + pattern.readUInt32BE(channel - 4) + 23 * 4, pattern.length);

  const parsed = new AbrParser(bytes).parse();
  assert.equal(parsed.length, 1);
  const [brush] = parsed;
  assert.equal(brush.name, source.name);
  assert.equal(brush.width, 4);
  assert.equal(brush.height, 2);
  assert.equal(brush.size, 40);
  assertMask(brush.dataUrl, 4, 2, main);
  assertMask(brush.textureDataUrl, 2, 2, [0, 255, 191, 127]);
  assertMask(brush.dualTipDataUrl, 3, 2, dual);
  assert.equal(brush.textureDensity, 0.6);
  assert.equal(brush.textureScale, 1.35);
  assert.equal(brush.textureInvert, true);
  assert.equal(brush.textureBlendMode, 'overlay');
  assert.equal(brush.dualBrush, true);
  assert.equal(brush.dualSize, 0.5);
  assert.equal(brush.dualScatter, 1.2);
  assert.equal(brush.dualSpacing, 0.28);
  assert.equal(brush.dualBlendMode, 'screen');

  const imported = await BrushPackageManager.parseBrushFile(bytes, 'test.abr');
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, source.name);
  assert.equal(imported[0].tipDataUrl, brush.dataUrl);
  assert.equal(imported[0].textureDataUrl, brush.textureDataUrl);
  assert.equal(imported[0].properties.customTextureUrl, brush.textureDataUrl);
  assert.equal(imported[0].dualTipDataUrl, brush.dualTipDataUrl);
  assert.equal(imported[0].properties.dualTipUrl, brush.dualTipDataUrl);
  const reexported = new AbrParser(await exportPresetsToAbr(imported)).parse();
  assert.equal(reexported.length, 1);
  assert.equal(reexported[0].dataUrl, brush.dataUrl);
  assert.equal(reexported[0].textureDataUrl, brush.textureDataUrl);
  assert.equal(reexported[0].dualTipDataUrl, brush.dualTipDataUrl);
});

test('five brushes share sample and pattern data while preserving preset order', async () => {
  const shared = maskPng(3, [[0, 79, 255]]);
  const other = maskPng(2, [[0, 127]]);
  const pattern = bmp24();
  const sources = [
    preset('Round'),
    { ...preset('A', { textureDensity: 0.4 }), tipDataUrl: shared, textureDataUrl: pattern },
    { ...preset('B', { textureDensity: 0.8, angleMode: 'pen' }), tipUrls: [shared], textureDataUrl: pattern },
    { ...preset('C'), tipDataUrl: other },
    { ...preset('D', { dualBrush: true }), dualTipDataUrl: shared },
  ];
  const bytes = await BrushPackageManager.exportPresetsToAbr(sources);
  const blocks = sections(bytes);
  const samples = records(blocks.get('samp')!);
  assert.equal(samples.length, 2);
  assert.notDeepEqual(samples[0].subarray(1, 37), samples[1].subarray(1, 37));
  assert.equal(records(blocks.get('patt')!).length, 1);
  const parsed = new AbrParser(bytes).parse();
  assert.deepEqual(parsed.map(brush => brush.name), sources.map(brush => brush.name));
  assert.equal(parsed[1].dataUrl, parsed[2].dataUrl);
  assert.equal(parsed[1].dataUrl, parsed[4].dualTipDataUrl);
  assert.equal(parsed[1].textureDataUrl, parsed[2].textureDataUrl);
  assert.equal(parsed[2].angleMode, 'pen');
  assertMask(parsed[3].dataUrl, 2, 1, [0, 127]);
});

test('empty pack rejects and Unicode, fallback names, and community presets round trip', async () => {
  await assert.rejects(BrushPackageManager.exportPresetsToAbr([]), /at least one brush preset/);
  const names = ['水墨筆 🖌', '鉛筆・風景', '   '];
  const bytes = await exportPresetsToAbr(names.map(name => preset(name)));
  assert.deepEqual(new AbrParser(bytes).parse().map(brush => brush.name), [names[0], names[1], 'Brush #3']);
  const community = await BrushPackageManager.exportPresetsToAbr(DEFAULT_COMMUNITY_PRESETS);
  const imported = await BrushPackageManager.parseBrushFile(community, 'community.abr');
  assert.deepEqual(imported.map(brush => brush.name), DEFAULT_COMMUNITY_PRESETS.map(brush => brush.name));
});

test('headless PNG decoding supports all filters and the four mask color types', async () => {
  const gray = png(3, 5, 0, [
    [0, 10, 20, 30], [1, 20, 20, 20], [2, 10, 10, 10], [3, 15, 10, 10], [4, 15, 15, 15],
  ]);
  const rgb = png(3, 1, 2, [[0, 255, 0, 0, 0, 255, 0, 0, 0, 255]]);
  const grayAlpha = png(2, 1, 4, [[0, 0, 64, 255, 0, 0, 0, 128, 128]], 16);
  const rgba = maskPng(3, [[0, 113, 255]]);
  const interlaced = png(3, 2, 0, [[0, 0x00], [0, 0x80], [0, 0x80], [0, 0xa0]], 1, 1);
  const bytes = await exportPresetsToAbr([gray, rgb, grayAlpha, rgba, interlaced].map((tipDataUrl, index) => ({
    ...preset(String(index)), tipDataUrl,
  })));
  const brushes = new AbrParser(bytes).parse();
  assertMask(brushes[0].dataUrl, 3, 5, [245, 235, 225, 235, 215, 195, 225, 205, 185, 225, 205, 185, 210, 190, 170]);
  assertMask(brushes[1].dataUrl, 3, 1, [179, 105, 226]);
  assertMask(brushes[2].dataUrl, 2, 1, [254, 128]);
  assertMask(brushes[3].dataUrl, 3, 1, [0, 113, 255]);
  assertMask(brushes[4].dataUrl, 3, 2, [255, 0, 0, 0, 255, 0]);
});

test('PackBits handles long literals, runs, missing images, and dimension limits', async () => {
  const row = [...Array.from({ length: 129 }, (_, i) => i), ...Array<number>(130).fill(150), 255, 0];
  const wide = { ...preset('PackBits'), tipDataUrl: maskPng(row.length, [row]) };
  const bytes = await BrushPackageManager.exportPresetToAbr(wide);
  const [brush] = new AbrParser(bytes).parse();
  assertMask(brush.dataUrl, row.length, 1, row);
  const resized = await BrushPackageManager.exportPresetToAbr(wide, { maxTipDimension: 16 });
  assert.equal(new AbrParser(resized).parse()[0].width, 16);

  let calls = 0;
  const invalid = { ...preset('Unreadable'), tipDataUrl: 'data:image/png;base64,not-a-png' };
  const injected = await exportPresetsToAbr([wide, wide, invalid], {
    maxTipDimension: 2,
    decodeImage: async url => {
      calls++;
      return url === wide.tipDataUrl
        ? { width: 4, height: 1, pixels: Uint8Array.of(0, 45, 80, 128) }
        : null;
    },
  });
  assert.equal(calls, 2);
  const parsed = new AbrParser(injected).parse();
  assertMask(parsed[0].dataUrl, 2, 1, [45, 128]);
  assert.equal(parsed[1].dataUrl, parsed[0].dataUrl);
  assert.equal(parsed[2].dataUrl, null);
  const malformed = await exportPresetsToAbr([invalid]);
  assert.deepEqual([...sections(malformed).keys()], ['desc']);
});

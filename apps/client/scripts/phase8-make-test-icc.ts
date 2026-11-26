/**
 * Writes a small synthetic CMYK output profile (ICC v2, lut16 / Lab PCS, sampled from the built-in
 * FOGRA39 approximation) for the Phase 8 Electron smoke check:
 *   apps/server/node_modules/.bin/tsx apps/client/scripts/phase8-make-test-icc.ts <output.icc>
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CmykPrintModel, getPrintConditionPreset } from '../src/engine/color/cmykPrintModel';
import { clampUnit, labToXyz, xyzToLab, type Vec3 } from '../src/engine/color/colorMath';

const LAB_L = 65535 / 65280 * 100;
const LAB_AB = 65535 / 256;

function sig(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** lut16Type with identity curves (2 entries) and an n-dimensional table */
function lut16(input: number, output: number, grid: number, sample: (point: number[]) => number[]): Uint8Array {
  const samples = grid ** input * output;
  const bytes = new Uint8Array(52 + (2 * (input + output) + samples) * 2);
  const view = new DataView(bytes.buffer);
  sig(view, 0, 'mft2');
  view.setUint8(8, input);
  view.setUint8(9, output);
  view.setUint8(10, grid);
  for (const diagonal of [12, 28, 44]) view.setInt32(diagonal, 65536);
  view.setUint16(48, 2);
  view.setUint16(50, 2);
  let offset = 52;
  const write = (value: number) => { view.setUint16(offset, Math.round(clampUnit(value) * 65535)); offset += 2; };
  for (let c = 0; c < input; c++) { write(0); write(1); }
  const point = new Array<number>(input);
  for (let i = 0; i < grid ** input; i++) {
    let index = i;
    for (let dim = input - 1; dim >= 0; dim--) {
      point[dim] = (index % grid) / (grid - 1);
      index = Math.floor(index / grid);
    }
    sample(point).forEach(write);
  }
  for (let c = 0; c < output; c++) { write(0); write(1); }
  return bytes;
}

function textDescription(text: string): Uint8Array {
  const bytes = new Uint8Array(12 + text.length + 1 + 8 + 3 + 67);
  const view = new DataView(bytes.buffer);
  sig(view, 0, 'desc');
  view.setUint32(8, text.length + 1);
  sig(view, 12, text);
  return bytes;
}

function xyzTag(xyz: Vec3): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  sig(view, 0, 'XYZ ');
  xyz.forEach((value, i) => view.setInt32(8 + i * 4, Math.round(value * 65536)));
  return bytes;
}

export function makeTestCmykIcc(description = 'Lumina Test CMYK'): Uint8Array {
  const model = new CmykPrintModel(getPrintConditionPreset('fogra39'));
  const forward = lut16(4, 3, 11, ([c, m, y, k]) => {
    const [l, a, b] = xyzToLab(model.cmykToRelativeXyz(c, m, y, k));
    return [l / LAB_L, (a + 128) / LAB_AB, (b + 128) / LAB_AB];
  });
  const reverse = lut16(3, 4, 17, ([l, a, b]) => model.relativeXyzToCmyk(labToXyz([l * LAB_L, a * LAB_AB - 128, b * LAB_AB - 128])).cmyk);
  const tags: Array<[string, Uint8Array]> = [
    ['desc', textDescription(description)], ['wtpt', xyzTag([0.9642, 1, 0.8249])],
    ['A2B0', forward], ['A2B1', forward], ['B2A0', reverse], ['B2A1', reverse],
  ];
  let size = 132 + tags.length * 12;
  const offsets = new Map<Uint8Array, number>();
  for (const [, data] of tags) {
    if (offsets.has(data)) continue;
    offsets.set(data, size);
    size += Math.ceil(data.length / 4) * 4;
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  view.setUint8(8, 2);
  view.setUint8(9, 0x10);
  sig(view, 12, 'prtrCMYKLab ');
  sig(view, 36, 'acsp');
  view.setUint32(64, 1); // relative colorimetric
  [0.9642, 1, 0.8249].forEach((value, i) => view.setInt32(68 + i * 4, Math.round(value * 65536)));
  view.setUint32(128, tags.length);
  tags.forEach(([name, data], i) => {
    const entry = 132 + i * 12;
    sig(view, entry, name);
    view.setUint32(entry + 4, offsets.get(data)!);
    view.setUint32(entry + 8, data.length);
    bytes.set(data, offsets.get(data)!);
  });
  return bytes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: phase8-make-test-icc.ts <output.icc>');
    process.exit(1);
  }
  const bytes = makeTestCmykIcc();
  writeFileSync(target, bytes);
  console.log(`wrote ${bytes.length} bytes`);
}

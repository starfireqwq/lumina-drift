/**
 * Writes the .kra fixture of the Phase 8 Electron smoke check (512×384): a group with a mask, a
 * clipped layer, multiply / screen 37% / glow / luminosity layers, alpha lock, hidden, a disabled
 * and an inverted mask, a locked layer, semi-transparent pixels and the proof swatches.
 *   apps/server/node_modules/.bin/tsx apps/client/scripts/phase8-make-test-kra.ts <output.kra>
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/engine/color/iccEmbed';
import { encodeKraDocument, type KraMaskInput, type KraNodeInput } from '../src/engine/kraEncoder';

export const FIXTURE_WIDTH = 512;
export const FIXTURE_HEIGHT = 384;
type Rect = [x: number, y: number, w: number, h: number];
type Rgba = [number, number, number, number];

function paint(rects: Array<[Rect, Rgba]>): Uint8Array {
  const rgba = new Uint8Array(FIXTURE_WIDTH * FIXTURE_HEIGHT * 4);
  for (const [[x, y, w, h], color] of rects) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) rgba.set(color, (row * FIXTURE_WIDTH + col) * 4);
    }
  }
  return rgba;
}

function halfMask(leftShows: boolean, inverted = false, enabled = true): KraMaskInput {
  const coverage = new Uint8Array(FIXTURE_WIDTH * FIXTURE_HEIGHT);
  for (let row = 0; row < FIXTURE_HEIGHT; row++) {
    for (let col = 0; col < FIXTURE_WIDTH; col++) {
      coverage[row * FIXTURE_WIDTH + col] = (col < FIXTURE_WIDTH / 2) === leftShows ? 255 : 0;
    }
  }
  return { coverage, inverted, enabled };
}

function tinyPng(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Uint8Array.of(0, 255, 255, 255, 255))), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { png.set(p, offset); offset += p.length; }
  return png;
}

const base = { opacity: 1, visible: true, locked: false, alphaLocked: false, clipToBelow: false, blendMode: 'normal' } as const;

export function fixtureRoots(): KraNodeInput[] {
  return [
    { ...base, kind: 'paint', name: 'Proof Swatches', rgba: paint([
      [[16, 16, 96, 96], [0, 0, 255, 255]], [[128, 16, 96, 96], [0, 255, 0, 255]],
      [[240, 16, 96, 96], [128, 128, 128, 255]], [[352, 16, 96, 96], [230, 190, 160, 255]],
    ]) },
    { kind: 'group', name: 'Group G', opacity: 1, visible: true, locked: false, blendMode: 'normal', mask: halfMask(true), children: [
      { ...base, kind: 'paint', name: 'Base', rgba: paint([[[16, 140, 200, 120], [200, 40, 40, 255]], [[220, 140, 40, 40], [10, 20, 30, 128]]]) },
      { ...base, kind: 'paint', name: 'Clip', clipToBelow: true, rgba: paint([[[60, 120, 200, 80], [240, 220, 0, 255]]]) },
      { ...base, kind: 'paint', name: 'Mul', blendMode: 'multiply', rgba: paint([[[100, 200, 150, 100], [100, 150, 250, 255]]]) },
    ] },
    { ...base, kind: 'paint', name: 'Screen 37', blendMode: 'screen', opacity: 0.37, rgba: paint([[[300, 150, 120, 100], [60, 60, 200, 255]]]) },
    { ...base, kind: 'paint', name: 'Glow', blendMode: 'glow', rgba: paint([[[330, 180, 120, 100], [90, 30, 10, 255]]]) },
    { ...base, kind: 'paint', name: 'Lum', blendMode: 'luminosity', mask: halfMask(true, true), rgba: paint([[[380, 240, 100, 100], [30, 200, 90, 255]]]) },
    { ...base, kind: 'paint', name: 'Alpha Locked', alphaLocked: true, rgba: paint([[[16, 300, 120, 60], [0, 128, 255, 255]]]) },
    { ...base, kind: 'paint', name: 'Hidden', visible: false, rgba: paint([[[150, 300, 100, 60], [255, 0, 255, 255]]]) },
    { ...base, kind: 'paint', name: 'Mask Off', mask: halfMask(false, false, false), rgba: paint([[[260, 300, 120, 60], [128, 0, 0, 255]]]) },
    { ...base, kind: 'paint', name: 'Locked', locked: true, rgba: paint([[[400, 330, 60, 40], [20, 20, 20, 255]]]) },
  ];
}

export async function makeFixtureKra(): Promise<Uint8Array> {
  const png = tinyPng();
  return encodeKraDocument({
    width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT, dpi: 350, title: 'Phase 8 Fixture', bgColor: '#F4F0E6',
    roots: fixtureRoots(), mergedPng: png, previewPng: png,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: phase8-make-test-kra.ts <output.kra>');
    process.exit(1);
  }
  makeFixtureKra().then((bytes) => {
    writeFileSync(target, bytes);
    console.log(`wrote ${bytes.length} bytes`);
  }, (error) => { console.error(error); process.exit(1); });
}

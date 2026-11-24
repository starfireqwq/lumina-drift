import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeCanvas, writePsdBuffer, readPsd } from 'ag-psd';
import {
  clampImportedCanvasDimensions,
  convertKraTileToRgba8,
  decompressLzf,
  delinearizeBytes,
  detectProjectFormatFromName,
  isSupportedProjectFileName,
  linearizeBytes,
  mapKraBlendMode,
  mapPsdBlendMode,
  parseKraTileStream,
} from '../src/engine/kraDecoder.ts';

function encodeAscii(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

test('project format detection accepts .lumina, .psd, and .kra case-insensitively', () => {
  assert.equal(isSupportedProjectFileName('art.psd'), true);
  assert.equal(isSupportedProjectFileName('art.PSD'), true);
  assert.equal(isSupportedProjectFileName('sketch.kra'), true);
  assert.equal(isSupportedProjectFileName('draft.lumina'), true);
  assert.equal(isSupportedProjectFileName('photo.png'), false);
  assert.equal(detectProjectFormatFromName('C:\\dir\\painting.PSD'), 'psd');
  assert.equal(detectProjectFormatFromName('painting.kra'), 'kra');
  assert.equal(detectProjectFormatFromName('painting.lumina'), 'lumina');
  assert.equal(detectProjectFormatFromName('painting.jpg'), null);
});

test('clampImportedCanvasDimensions enforces [64, 16384] bounds cleanly', () => {
  assert.deepEqual(clampImportedCanvasDimensions(1920, 1080), { width: 1920, height: 1080, scale: 1 });
  assert.deepEqual(clampImportedCanvasDimensions(32, 48), { width: 64, height: 64, scale: 1 });
  const big = clampImportedCanvasDimensions(32768, 16384);
  assert.equal(big.width, 16384);
  assert.equal(big.height, 8192);
  assert.equal(big.scale, 0.5);
});

test('decompressLzf decodes literal runs and overlapping RLE back-references', () => {
  // Literal 2 bytes: [0x01, 0xAA, 0xBB]
  // Back-reference len=4 (ctrl=(2<<5)|0 = 0x40, dist=1 -> offset byte 0x01): repeats AA, BB, AA, BB
  const compressed = new Uint8Array([0x01, 0xaa, 0xbb, 0x40, 0x01]);
  const out = decompressLzf(compressed, 6);
  assert.deepEqual([...out], [0xaa, 0xbb, 0xaa, 0xbb, 0xaa, 0xbb]);
});

test('linearizeBytes and delinearizeBytes round-trip Krita planar tiles', () => {
  // 4 pixels of BGRA (pixelSize = 4)
  const interleaved = new Uint8Array([
    10, 20, 30, 255,
    40, 50, 60, 200,
    70, 80, 90, 128,
    100, 110, 120, 0,
  ]);
  const planar = linearizeBytes(interleaved, 4, 4);
  assert.deepEqual([...planar.subarray(0, 4)], [10, 40, 70, 100]); // B plane
  assert.deepEqual([...planar.subarray(4, 8)], [20, 50, 80, 110]); // G plane
  assert.deepEqual([...planar.subarray(8, 12)], [30, 60, 90, 120]); // R plane
  assert.deepEqual([...planar.subarray(12, 16)], [255, 200, 128, 0]); // A plane
  const restored = delinearizeBytes(planar, 4, 4);
  assert.deepEqual([...restored], [...interleaved]);
});

test('parseKraTileStream decodes VERSION 2 uncompressed (flag=0) and LZF planar (flag=1) tiles + BGRA->RGBA', () => {
  // 2x2 tile, pixelSize=4 (16 bytes)
  // Pixel 0: B=10, G=20, R=30, A=255 -> RGBA should be (30, 20, 10, 255)
  const tile0 = new Uint8Array([
    10, 20, 30, 255,
    10, 20, 30, 255,
    10, 20, 30, 255,
    10, 20, 30, 255,
  ]);
  const payload0 = concatBytes([new Uint8Array([0]), tile0]); // flag=0 uncompressed

  // Tile 1: planar bytes compressed with LZF literal run (ctrl=15 -> 16 literal bytes)
  const tile1 = new Uint8Array([
    5, 15, 25, 128,
    50, 60, 70, 255,
    0, 0, 0, 0,
    255, 128, 64, 200,
  ]);
  const planar1 = linearizeBytes(tile1, 4, 4);
  const lzf1 = concatBytes([new Uint8Array([15]), planar1]); // single literal run of 16 bytes
  const payload1 = concatBytes([new Uint8Array([1]), lzf1]); // flag=1 LZF compressed

  const stream = concatBytes([
    encodeAscii('VERSION 2\nTILEWIDTH 2\nTILEHEIGHT 2\nPIXELSIZE 4\nDATA 2\n'),
    encodeAscii(`0,0,LZF,${payload0.length}\n`),
    payload0,
    encodeAscii(`-2,2,LZF,${payload1.length}\n`),
    payload1,
  ]);

  const parsed = parseKraTileStream(stream);
  assert.equal(parsed.tileWidth, 2);
  assert.equal(parsed.tileHeight, 2);
  assert.equal(parsed.pixelSize, 4);
  assert.equal(parsed.tiles.length, 2);

  assert.equal(parsed.tiles[0].left, 0);
  assert.equal(parsed.tiles[0].top, 0);
  const rgba0 = convertKraTileToRgba8(parsed.tiles[0].raw, 4, 4, 'RGBA');
  assert.deepEqual([...rgba0.subarray(0, 4)], [30, 20, 10, 255]);

  assert.equal(parsed.tiles[1].left, -2);
  assert.equal(parsed.tiles[1].top, 2);
  const rgba1 = convertKraTileToRgba8(parsed.tiles[1].raw, 4, 4, 'RGBA');
  assert.deepEqual([...rgba1.subarray(0, 4)], [25, 15, 5, 128]);
  assert.deepEqual([...rgba1.subarray(4, 8)], [70, 60, 50, 255]);
  assert.deepEqual([...rgba1.subarray(12, 16)], [64, 128, 255, 200]);

  // Verify ALPHA mask conversion -> opaque greyscale RGBA
  const maskRgba = convertKraTileToRgba8(new Uint8Array([0, 128, 255, 64]), 4, 1, 'ALPHA', true);
  assert.deepEqual([...maskRgba.subarray(0, 8)], [0, 0, 0, 255, 128, 128, 128, 255]);
});

test('PSD and KRA blend modes map accurately to Lumina Drift blend modes', () => {
  assert.equal(mapPsdBlendMode('pass through'), 'normal');
  assert.equal(mapPsdBlendMode('multiply'), 'multiply');
  assert.equal(mapPsdBlendMode('linear dodge'), 'add');
  assert.equal(mapPsdBlendMode('color dodge'), 'color_dodge');
  assert.equal(mapPsdBlendMode('soft light'), 'soft_light');

  assert.equal(mapKraBlendMode('normal'), 'normal');
  assert.equal(mapKraBlendMode('multiply'), 'multiply');
  assert.equal(mapKraBlendMode('dodge'), 'color_dodge');
  assert.equal(mapKraBlendMode('soft_light_svg'), 'soft_light');
  assert.equal(mapKraBlendMode('diff'), 'difference');
  assert.equal(mapKraBlendMode('addition'), 'add');
});

test('ag-psd round-trips layered PSD with group, blend mode, clipping, and opacity', () => {
  initializeCanvas(
    (w, h) => ({ width: w, height: h }) as any,
    (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as any
  );
  const buf = writePsdBuffer({
    width: 64,
    height: 64,
    children: [
      {
        name: 'Base',
        opacity: 1,
        blendMode: 'normal',
        left: 0,
        top: 0,
        right: 2,
        bottom: 2,
        imageData: {
          width: 2,
          height: 2,
          data: new Uint8ClampedArray([
            255, 0, 0, 255, 0, 255, 0, 255,
            0, 0, 255, 255, 255, 255, 255, 255,
          ]),
        },
      },
      {
        name: 'Folder A',
        opened: true,
        blendMode: 'pass through',
        children: [
          {
            name: 'Multiply Shade',
            opacity: 0.5,
            blendMode: 'multiply',
            clipping: true,
            hidden: false,
            left: 1,
            top: 1,
            right: 2,
            bottom: 2,
            imageData: {
              width: 1,
              height: 1,
              data: new Uint8ClampedArray([100, 120, 140, 255]),
            },
          },
        ],
      },
    ],
  });

  const parsed = readPsd(buf, { useImageData: true, skipThumbnail: true });
  assert.equal(parsed.width, 64);
  assert.equal(parsed.height, 64);
  assert.equal(parsed.children?.length, 2);
  assert.equal(parsed.children?.[0].name, 'Base');
  const folder = parsed.children?.[1];
  assert.equal(folder?.name, 'Folder A');
  assert.equal(Array.isArray(folder?.children), true);
  assert.equal(folder?.children?.[0].name, 'Multiply Shade');
  assert.equal(mapPsdBlendMode(folder?.children?.[0].blendMode), 'multiply');
  assert.equal(Boolean(folder?.children?.[0].clipping), true);
});

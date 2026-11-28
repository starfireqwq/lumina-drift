import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, mock, test } from 'node:test';
import { decompressTileBuffer, type TileData } from '@atelier/shared';
import type { PixelData } from 'ag-psd';
import JSZip from 'jszip';
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
import {
  extractPsdLayerTiles,
  extractPsdMaskTiles,
  pixelDataToRgba8Byte,
  renderPsdPreviewDataUrl,
} from '../src/engine/psdTileDecoder.ts';
import { LuminaProjectEngine } from '../src/engine/LuminaProjectEngine.ts';
import { ApiService } from '../src/services/api.ts';
import { OfflineSessionStore } from '../src/services/offlineStore.ts';

// Keep the real parser and observe its output before the importer consumes it.
const agPsd = createRequire(import.meta.url)('ag-psd') as typeof import('ag-psd');
const { initializeCanvas, writePsdBuffer, readPsd } = agPsd;
const trackedReadPsd = mock.method(agPsd, 'readPsd');
after(() => trackedReadPsd.mock.restore());
const { unpackKraProject, unpackPsdProject } = await import('../src/engine/ExternalProjectImporter.ts');

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

function tilePixel(tile: TileData, x: number, y: number): number[] {
  const pixels = decompressTileBuffer(tile.data as Uint8Array, tile.compression, tile.width * tile.height * 4);
  const index = (y * tile.width + x) * 4;
  return Array.from(pixels.subarray(index, index + 4));
}

function imageBytes(width: number, height: number): PixelData & { data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
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

test('KRA layer alpha-inheritance attributes map to clipToBelow', async (t) => {
  const cases = [
    { name: 'Enabled', attributes: { inheritsalpha: '1' }, clipped: true },
    { name: 'Disabled', attributes: { inheritsalpha: '0' }, clipped: false },
    { name: 'Missing', attributes: {}, clipped: false },
    { name: 'Legacy lowercase', attributes: { inheritalpha: '1' }, clipped: true },
    { name: 'Legacy camel case', attributes: { inheritAlpha: '1' }, clipped: true },
  ];
  interface XmlElement {
    tagName: string;
    getAttribute(key: string): string | null;
    children: XmlElement[];
  }
  function element(tagName: string, attributes: Record<string, string | undefined>, children: XmlElement[] = []): XmlElement {
    return { tagName, getAttribute: (key: string) => attributes[key] ?? null, children };
  }
  const layers = cases.map(({ name, attributes }) => element('layer', { name, ...attributes }));
  const image = element('IMAGE', { width: '64', height: '64' }, [element('layers', {}, layers)]);
  const xmlLayers = cases.map(({ name, attributes }) => {
    const flags = Object.entries(attributes).map(([key, value]) => ` ${key}="${value}"`).join('');
    return `<layer name="${name}"${flags}/>`;
  }).join('');
  const xml = `<DOC><IMAGE width="64" height="64"><layers>${xmlLayers}</layers></IMAGE></DOC>`;
  const zip = new JSZip();
  zip.file('maindoc.xml', xml);

  const previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  t.after(() => {
    if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
  });
  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: class {
      parseFromString(source: string, mime: string) {
        assert.equal(source, xml);
        assert.equal(mime, 'application/xml');
        return { querySelector: (tag: string) => tag === 'IMAGE' ? image : null };
      }
    },
  });

  const project = await unpackKraProject(await zip.generateAsync({ type: 'uint8array' }));
  assert.deepEqual(
    Object.fromEntries(project.layers.map(({ name, clipToBelow }) => [name, clipToBelow])),
    Object.fromEntries(cases.map(({ name, clipped }) => [name, clipped])),
  );
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

test('PSD raster tiles clip oversized bounds, retain edge dimensions, and skip transparent tiles', async () => {
  const pixels = imageBytes(8, 8);
  const setPixel = (x: number, y: number, rgba: number[]) => pixels.data.set(rgba, (y * pixels.width + x) * 4);
  setPixel(1, 2, [255, 255, 255, 255]); // Left of the canvas
  setPixel(2, 2, [201, 151, 51, 128]);
  setPixel(6, 4, [40, 20, 10, 255]);
  setPixel(7, 4, [255, 255, 255, 255]); // Right of the canvas
  setPixel(2, 7, [255, 255, 255, 255]); // Below the canvas
  const opts = { left: -2, top: -2, canvasWidth: 5, canvasHeight: 3, scale: 1, tileSize: 2 };

  const tiles = await extractPsdLayerTiles(pixels, opts);
  assert.deepEqual(tiles.map(({ col, row, width, height }) => [col, row, width, height]), [
    [0, 0, 2, 2], [2, 1, 1, 1],
  ]);
  assert.equal(tiles[0].compression, 'lz4');
  assert.deepEqual(tilePixel(tiles[0], 0, 0), [101, 76, 26, 128]);
  assert.deepEqual(tilePixel(tiles[0], 1, 1), [0, 0, 0, 0]);
  assert.deepEqual(tilePixel(tiles[1], 0, 0), [40, 20, 10, 255]);
  assert.deepEqual(await extractPsdLayerTiles(pixels, { ...opts, left: -8 }), []);
});

test('PSD raster tiles convert 8-, 16-, and 32-bit samples before premultiplying', async () => {
  const opts = { left: 0, top: 0, canvasWidth: 1, canvasHeight: 1, scale: 1 };
  const integer = new Uint16Array([0xffff, 0x8001, 0x01ff, 0x80ff]);
  const linear = new Float32Array([0.25, 2, -1, 0.5]);
  const [tile16] = await extractPsdLayerTiles({ width: 1, height: 1, data: integer }, opts);
  const [tile32] = await extractPsdLayerTiles({ width: 1, height: 1, data: linear }, opts);
  assert.deepEqual(tilePixel(tile16, 0, 0), [128, 64, 1, 128]);
  assert.deepEqual(tilePixel(tile32, 0, 0), [68, 128, 0, 128]);
  assert.equal(pixelDataToRgba8Byte(Uint8Array.of(173), 0, false), 173);
  assert.equal(pixelDataToRgba8Byte(Uint8ClampedArray.of(190), 0, true), 190);
});

test('PSD raster tiles bilinearly sample all four premultiplied pixels when scaling down', async () => {
  const pixels = {
    width: 2, height: 2,
    data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0),
  };
  const [tile] = await extractPsdLayerTiles(pixels, {
    left: 2, top: 0, canvasWidth: 2, canvasHeight: 1, scale: 0.5,
  });
  assert.deepEqual(tilePixel(tile, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(tilePixel(tile, 1, 0), [64, 0, 64, 128]);
});

test('PSD mask tiles fill their background and store opaque premultiplied luminance in the mask region', async () => {
  const pixels = { width: 1, height: 1, data: Uint8Array.of(200, 100, 50, 128) };
  const opts = { canvasWidth: 6, canvasHeight: 2, scale: 1, tileSize: 2 };
  for (const bg of [0, 255]) {
    const tiles = await extractPsdMaskTiles({ left: 1, top: 1, defaultColor: bg }, pixels, opts);
    assert.deepEqual(tiles.map(({ col, row }) => [col, row]), [[0, 0], [1, 0], [2, 0]]);
    assert.deepEqual(tilePixel(tiles[0], 0, 0), [bg, bg, bg, 255]);
    assert.deepEqual(tilePixel(tiles[0], 1, 1), [62, 62, 62, 255]);
    assert.deepEqual(tilePixel(tiles[1], 1, 1), [bg, bg, bg, 255]);
    assert.equal(tiles[1].data, tiles[2].data);
  }
  const [solid] = await extractPsdMaskTiles({ defaultColor: 255 }, undefined, opts);
  assert.deepEqual(tilePixel(solid, 1, 1), [255, 255, 255, 255]);
  assert.deepEqual(await extractPsdMaskTiles({}, undefined, opts), []);
});

test('PSD preview creates one bounded canvas and composites sampled pixels over white', (t) => {
  const pixels = { width: 2, height: 2, data: Uint8Array.of(
    255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0,
  ) };
  assert.equal(renderPsdPreviewDataUrl(pixels), null);
  const context = {
    createImageData: imageBytes,
    putImageData(preview: PixelData, x: number, y: number) {
      assert.deepEqual([x, y, preview.width, preview.height], [0, 0, 1, 1]);
      assert.deepEqual(Array.from(preview.data), [191, 128, 191, 255]);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL(type: string) {
      assert.equal(type, 'image/png');
      assert.deepEqual([this.width, this.height], [1, 1]);
      return 'data:image/png;base64,preview';
    },
  };
  const createElement = t.mock.fn((tag: string) => {
    assert.equal(tag, 'canvas');
    return canvas;
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement } });
  t.after(() => Reflect.deleteProperty(globalThis, 'document'));
  assert.equal(renderPsdPreviewDataUrl(pixels, 1), 'data:image/png;base64,preview');
  assert.equal(createElement.mock.callCount(), 1);
});

test('layered PSD imports deferred raster and mask tiles, releasing shared raw data after both providers', async () => {
  initializeCanvas(
    () => { throw new Error('PSD tiles must not create a canvas'); },
    (width, height) => imageBytes(width, height) as ImageData,
  );
  const oversize = imageBytes(70, 70);
  oversize.data.set([255, 255, 255, 255], 0);
  oversize.data.set([200, 100, 50, 128], (3 * 70 + 2) * 4);
  oversize.data.set([10, 20, 30, 255], (66 * 70 + 65) * 4);
  const image = (rgba: number[]) => ({ width: 1, height: 1, data: Uint8ClampedArray.from(rgba) });
  const buf = writePsdBuffer({
    width: 64,
    height: 64,
    children: [{
      name: 'Group',
      blendMode: 'pass through',
      mask: { left: 2, top: 0, defaultColor: 0, imageData: image([190, 190, 190, 255]) },
      children: [
        { name: 'Base', imageData: image([80, 90, 100, 255]) },
        {
          name: 'Overflow',
          left: -2, top: -3,
          imageData: oversize,
          blendMode: 'multiply',
          opacity: 0.5, hidden: true, clipping: true,
          protected: { composite: true, transparency: true },
          mask: { left: 1, top: 1, defaultColor: 255, disabled: true, imageData: image([72, 72, 72, 255]) },
        },
        { name: 'Legacy Brightness', adjustment: { type: 'brightness/contrast', brightness: 12, useLegacy: true } },
        { name: 'Unsupported', adjustment: { type: 'invert' } },
      ],
    }],
  });
  const view = Buffer.concat([Buffer.alloc(9), buf, Buffer.alloc(7)]).subarray(9, 9 + buf.length);
  const project = await unpackPsdProject(view, 'large.psd');
  const parse = trackedReadPsd.mock.calls.at(-1)!;
  assert.equal(parse.arguments[0], view);
  assert.deepEqual(parse.arguments[1], { useRawData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const parsed = parse.result!;
  assert.equal(parsed.rawCompositeData, undefined);
  assert.equal(parsed.rawCompositeDataInfo, undefined);

  const byName = new Map(project.layers.map((layer) => [layer.name, layer]));
  const group = byName.get('Group')!;
  const overflow = byName.get('Overflow')!;
  const base = byName.get('Base')!;
  const adjustment = byName.get('Legacy Brightness')!;
  const groupMask = project.layers.find((layer) => layer.parentId === group.id && layer.layerType === 'mask')!;
  const overflowMask = project.layers.find((layer) => layer.parentId === overflow.id && layer.layerType === 'mask')!;
  assert.equal(group.layerType, 'group');
  assert.equal(overflow.parentId, group.id);
  assert.equal(overflow.blendMode, 'multiply');
  assert.equal(overflow.opacity, 128 / 255);
  assert.equal(overflow.clipToBelow, true);
  assert.equal(overflow.isVisible, false);
  assert.equal(overflow.isLocked, true);
  assert.equal(overflow.alphaLocked, true);
  assert.equal(overflowMask.isVisible, false);
  assert.equal(adjustment.meta?.adjustment?.kind, 'brightness_contrast');
  assert.equal(byName.has('Unsupported'), false);
  assert.match(project.adjustmentNotes!.skipped[0], /^Unsupported/);
  assert.match(project.adjustmentNotes!.partial[0], /^Legacy Brightness/);
  assert.deepEqual(project.layerPngDataUrls, {});

  const providers = project.layerTileProviders!;
  assert.deepEqual(new Set(Object.keys(providers)), new Set([base.id, overflow.id, overflowMask.id, groupMask.id]));
  const rawGroup = parsed.children![0];
  const rawBase = rawGroup.children!.find((layer) => layer.name === 'Base')!;
  const rawOverflow = rawGroup.children!.find((layer) => layer.name === 'Overflow')!;
  assert.ok(rawOverflow.rawData);
  assert.ok(rawBase.rawData);
  assert.ok(rawGroup.rawData);
  assert.ok(rawGroup.children!.filter((layer) => layer.adjustment).every((layer) => !layer.rawData));

  const overflowDecode = providers[overflow.id]();
  assert.equal(providers[overflow.id](), overflowDecode);
  const [overflowTile] = await overflowDecode;
  assert.deepEqual(tilePixel(overflowTile, 0, 0), [100, 50, 25, 128]);
  assert.deepEqual(tilePixel(overflowTile, 63, 63), [10, 20, 30, 255]);
  assert.ok(rawOverflow.rawData);
  const [maskTile] = await providers[overflowMask.id]();
  assert.deepEqual(tilePixel(maskTile, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(tilePixel(maskTile, 1, 1), [72, 72, 72, 255]);
  assert.equal(rawOverflow.rawData, undefined);
  await assert.rejects(providers[overflow.id](), /已解碼/);

  const [baseTile] = await providers[base.id]();
  const [groupMaskTile] = await providers[groupMask.id]();
  assert.deepEqual(tilePixel(baseTile, 0, 0), [80, 90, 100, 255]);
  assert.deepEqual(tilePixel(groupMaskTile, 2, 0), [190, 190, 190, 255]);
  assert.deepEqual(tilePixel(groupMaskTile, 3, 0), [0, 0, 0, 255]);
  assert.equal(rawBase.rawData, undefined);
  assert.equal(rawGroup.rawData, undefined);
});

test('flattened PSD exposes its composite as a deferred background layer and releases it after decoding', async () => {
  const buf = writePsdBuffer({
    width: 1,
    height: 1,
    colorMode: 2, // Indexed PSD files have no layer records.
    palette: [{ r: 30, g: 80, b: 140 }],
    imageData: { width: 1, height: 1, data: Uint8ClampedArray.of(30, 80, 140, 255) },
  });
  const project = await unpackPsdProject(buf, 'flat.psd');
  const parsed = trackedReadPsd.mock.calls.at(-1)!.result!;
  assert.ok(!parsed.children?.length);
  assert.ok(parsed.rawCompositeData);
  assert.deepEqual(project.layerPngDataUrls, {});
  assert.equal(project.layers.length, 1);
  const [background] = project.layers;
  assert.equal(background.name, '背景');
  const [tile] = await project.layerTileProviders![background.id]();
  assert.deepEqual(tilePixel(tile, 0, 0), [30, 80, 140, 255]);
  assert.deepEqual(tilePixel(tile, 1, 0), [0, 0, 0, 0]);
  assert.equal(parsed.rawCompositeData, undefined);
  assert.equal(parsed.rawCompositeDataInfo, undefined);
});

test('project restore prefers tile providers, writes 48 tiles per batch, and reports empty providers', async (t) => {
  const buf = writePsdBuffer({
    width: 64,
    height: 64,
    children: [{ name: 'Pixels' }, { name: 'Empty' }],
  });
  const project = await unpackPsdProject(buf);
  const [pixels, empty] = project.layers;
  const tiles = Array.from({ length: 49 }, (_, col): TileData => ({
    col, row: 0, width: 1, height: 1, compression: 'raw', data: Uint8Array.of(0, 0, 0, 255),
  }));
  let yielded = false;
  project.layerPngDataUrls[pixels.id] = 'unused when the tile provider is present';
  project.layerTileProviders = {
    [pixels.id]: async () => {
      setTimeout(() => { yielded = true; }, 0);
      return tiles;
    },
    [empty.id]: async () => {
      assert.equal(yielded, true);
      return [];
    },
  };

  t.mock.method(OfflineSessionStore, 'persistRecordNow', async () => {});
  const created = await OfflineSessionStore.createCanvas(project.meta.canvas);
  t.after(() => OfflineSessionStore.deleteCanvas(created.canvas.id));
  t.mock.method(ApiService, 'createCanvas', async () => created);
  const write = t.mock.method(ApiService, 'writeLayerTiles', async () => 0);
  const progress = t.mock.fn();

  await LuminaProjectEngine.restoreToCanvas(project, progress);
  const target = (await OfflineSessionStore.listLayers(created.canvas.id)).find((layer) => layer.name === pixels.name)!;
  assert.deepEqual(write.mock.calls.map(({ arguments: args }) => args.slice(0, 3)), [
    [created.canvas.id, target.id, tiles.slice(0, 48)],
    [created.canvas.id, target.id, tiles.slice(48)],
  ]);
  assert.deepEqual(progress.mock.calls.map(({ arguments: args }) => args), [[1, 4], [2, 4], [3, 4], [4, 4]]);
});

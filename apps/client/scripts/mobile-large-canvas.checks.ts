import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Container, Graphics, RenderTexture, type Matrix, type Renderer } from 'pixi.js';
import { computeRecommendedGpuTileBudget, compressTileBuffer, decompressTileBuffer, TileGpuLruPool, type LayerModel } from '@atelier/shared';
import { adjustmentScopeRenderResolution } from '../src/engine/adjustmentView';
import { canAllocateFullCanvasTexture, computeSafeDisplayResolution, computeSafeTextureScale, detectConstrainedDevice, queryMaxTextureSize } from '../src/engine/gpuProfile';
import { LayerManager } from '../src/engine/LayerManager';
import { bucketMask } from '../src/engine/rasterToolPixels';
import { tiledBucketFill } from '../src/engine/tiledBucketFill';
import { buildTiledFilterPatch } from '../src/engine/tiledLayerFilter';

const W = 13500;
const H = 7500;
const MiB = 1048576;
const mobile = { userAgent: 'Mozilla Android Mobile', deviceMemory: 3, coarsePointer: true, screenMinSide: 393, maxTouchPoints: 5 };
const desktop = { userAgent: 'Desktop', deviceMemory: 16, screenMinSide: 1080 };
const testGlobal = globalThis as typeof globalThis & {
  __ATELIER_FORCE_MAX_TEXTURE_SIZE__?: number;
  __ATELIER_TEST_DEVICE_PROFILE__?: typeof mobile | typeof desktop;
};

function checkProfile() {
  const phone = detectConstrainedDevice(mobile);
  const computer = detectConstrainedDevice(desktop);
  assert.deepEqual(phone, { isMobileOrTablet: true, isAndroid: true, isConstrained: true, deviceMemoryGb: 3 });
  assert.equal(computer.isConstrained, false);
  assert.equal(detectConstrainedDevice({ userAgent: 'Macintosh', maxTouchPoints: 5 }).isMobileOrTablet, true);
  assert.equal(detectConstrainedDevice({ coarsePointer: true }).isConstrained, true);
  assert.equal(detectConstrainedDevice({ screenMinSide: 767 }).isConstrained, true);
  assert.equal(detectConstrainedDevice({ deviceMemory: 4 }).isConstrained, true);
  assert.equal(computeSafeDisplayResolution(W, H, 3, phone), 1);
  assert.equal(computeSafeDisplayResolution(4096, 4096, 3, phone), 1.25);
  assert.equal(computeSafeDisplayResolution(2048, 2048, 3, phone), 1.5);
  assert.equal(computeSafeDisplayResolution(W, H, 2, computer), 2);
  assert.equal(computeSafeDisplayResolution(W, H, 2, detectConstrainedDevice({ deviceMemory: 4 })), 1.5);
  assert.equal(queryMaxTextureSize(), 4096);
  const gl = { MAX_TEXTURE_SIZE: 3379, getParameter: (name: number) => name === 3379 ? 16384 : null };
  assert.equal(queryMaxTextureSize({ context: { gl } }), 16384);
  for (const limit of [4096, 8192, 16384]) {
    assert.equal(canAllocateFullCanvasTexture(W, H, limit, false), false);
    assert.equal(canAllocateFullCanvasTexture(W, H, limit, true), false);
    assert.equal(canAllocateFullCanvasTexture(limit + 1, 100, limit, false), false);
    for (const pixels of [4_194_304, 16_777_216]) {
      const size = computeSafeTextureScale(W, H, limit, pixels);
      assert.ok(size.width <= limit && size.height <= limit && size.width * size.height <= pixels);
      const res = adjustmentScopeRenderResolution(W, H, limit, pixels);
      assert.ok(Math.ceil(W * res) <= limit && Math.ceil(H * res) <= limit && W * H * res ** 2 <= pixels);
    }
  }
  assert.equal(canAllocateFullCanvasTexture(4096, 4096, 4096, false), true);
  assert.equal(canAllocateFullCanvasTexture(4096, 4096, 4096, true), false);
  assert.ok(computeSafeTextureScale(13500, 1, 4096, 64).width <= 64);
}

async function checkLayerManager(solo: boolean, limit: number, constrained: boolean) {
  testGlobal.__ATELIER_FORCE_MAX_TEXTURE_SIZE__ = limit;
  testGlobal.__ATELIER_TEST_DEVICE_PROFILE__ = constrained ? mobile : desktop;
  const coords = new WeakMap<RenderTexture, { x: number; y: number }>();
  let renderCalls = 0;
  const renderer = {
    gl: { MAX_TEXTURE_SIZE: 3379, getParameter: () => 16384 },
    render: ({ target, transform }: { target?: RenderTexture; transform?: Matrix }) => {
      if (!target) return;
      assert.ok(target.source.pixelWidth <= limit && target.source.pixelHeight <= limit, 'oversized render target');
      if (transform) coords.set(target, { x: -transform.tx, y: -transform.ty });
      renderCalls++;
    },
  } as unknown as Renderer;
  const lm = new LayerManager(renderer, W, H, '#FFFFFF', solo);
  try {
    const stats = lm.getTextureStats();
    assert.equal(stats.maxTextureSize, limit);
    assert.equal(stats.constrained, constrained);
    assert.equal(stats.allowFullCanvasTextures, false);
    if (constrained) assert.ok(stats.lruBudgetMegabytes <= 128);
    const layers = Array.from({ length: 20 }, (_, i) => ({
      id: `layer-${i}`, name: `Layer ${i}`, layerType: 'raster', opacity: 1, isVisible: true, blendMode: 'normal', sortOrder: i,
    } as LayerModel));
    lm.syncLayers(layers);
    lm.setViewportBounds({ x0: 100, y0: 100, x1: 700, y1: 700 });
    const raw = new Uint8Array(256 * 256 * 4).fill(127);
    const encoded = compressTileBuffer(raw);
    const read = async (target: RenderTexture, rects: Array<{ x: number; y: number; w: number; h: number }>) => rects.map(({ w, h }) => {
      const origin = coords.get(target);
      const pixels = new Uint8Array(w * h * 4);
      if (origin) {
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) pixels[(row * w + col) * 4] = (origin.x + col + origin.y + row) & 255;
        }
      }
      return pixels;
    });
    lm.setReader(read);
    for (const [i, layer] of layers.entries()) {
      lm.setActiveLayer(layer.id);
      lm.pin('test', layer.id);
      const target = lm.drawTarget(layer.id, { whole: true });
      assert.ok(target && !(target instanceof RenderTexture));
      const graphic = new Graphics().rect(i * 256, 0, 12, 12).fill(0xff0000);
      const holder = new Container();
      holder.addChild(graphic);
      target.draw(holder, i * 256, 0, 12, 12);
      lm.syncPingPong(layer.id);
      holder.destroy({ children: true });
      const tile = { col: i, row: 0, width: 256, height: 256, ...encoded, byteLength: encoded.data.byteLength };
      lm.applyTiles(layer.id, [tile]); // local or authoritative remote patch
      lm.applyTiles(layer.id, [{ ...tile, ...compressTileBuffer(new Uint8Array(raw.length)) }]); // undo
      lm.applyTiles(layer.id, [tile]); // redo
    }
    for (const [i, layer] of layers.entries()) {
      const row = i % 4;
      lm.setViewportBounds({ x0: i * 160, y0: 0, x1: i * 160 + 2600, y1: 1500 });
      const tiles = Array.from({ length: 50 }, (_, col) => ({
        col, row, width: 256, height: 256, ...encoded, byteLength: encoded.data.byteLength,
      }));
      lm.applyTiles(layer.id, tiles, solo ? undefined : { remoteIsNewer: () => true });
      const budget = lm.getTextureStats();
      assert.ok(budget.tiles <= budget.lruBudgetTiles);
      assert.ok(budget.atlasMegabytes <= budget.lruBudgetMegabytes);
    }
    assert.ok(renderCalls > 0);
    assert.equal(lm.getTextureStats().resident, 0);
    assert.equal(lm.getTextureStats().pingPong, 0);
    const [pixel] = await lm.readCompositeRegionsAsync([{ x: 13499, y: 7499, w: 1, h: 1 }], true);
    assert.equal(pixel.length, 4);
    assert.equal(pixel[0], (13499 + 7499) & 255);
    const [strip, edge] = await lm.readCompositeRegionsAsync([{ x: 52, y: 11, w: 5000, h: 2 }, { x: W - 2, y: H - 1, w: 4, h: 4 }]);
    assert.equal(strip.length, 5000 * 2 * 4);
    assert.equal(strip[4 * 2048], (52 + 11 + 2048) & 255);
    assert.equal(strip[4 * 9999], (52 + 12 + 4999) & 255);
    assert.equal(edge.length, 8);
    assert.equal(lm.getTextureStats().scratch, 0, 'regional reads must not allocate a cached full composite');
    const composite = lm.getCompositeTexture();
    assert.ok(composite.width <= limit && composite.height <= limit && composite.width * composite.height <= (constrained ? 4_194_304 : 16_777_216));
  } finally {
    lm.destroy();
    delete testGlobal.__ATELIER_FORCE_MAX_TEXTURE_SIZE__;
    delete testGlobal.__ATELIER_TEST_DEVICE_PROFILE__;
  }
}

function checkLru(solo: boolean) {
  const recommended = computeRecommendedGpuTileBudget(W, H, 3, true);
  const maxTiles = Math.min(recommended.maxTiles, 288);
  const maxBytes = Math.min(recommended.maxBytes, 128 * MiB);
  const pool = new TileGpuLruPool({ maxTiles, maxBytes, maxDirtyEvictBatch: 16 });
  const bytes = 264 * 264 * 4;
  const ids = new Set<string>();
  for (let step = 0; step < 48; step++) {
    for (const id of ids) pool.setInViewport(id, false);
    for (let layer = 0; layer < 20; layer++) {
      for (let tile = 0; tile < 10; tile++) {
        const tileKey = `${(step * 4 + tile) % Math.ceil(W / 256)}_${(step + layer) % Math.ceil(H / 256)}`;
        const id = `${layer}:${tileKey}`;
        if (tile === 1 && step % 3 === 0) pool.remove(id); // undo, followed by redo in the active view
        if (pool.getStats().activeTiles >= maxTiles) {
          const plan = pool.planEviction({ force: true });
          for (const old of plan.cleanIds) { pool.recordEviction(old, 'clean'); ids.delete(old); }
          for (const old of plan.dirtyIds) { pool.recordEviction(old, 'dirty'); ids.delete(old); }
        }
        pool.touch(id, { layerId: String(layer), tileKey, bytes, clean: solo || tile % 2 === 0, inViewport: tile < 3 }, step);
        ids.add(id);
        assert.equal(pool.isOverBudget(), false);
      }
    }
  }
  assert.ok(pool.getStats().totalEvictions > 0);
  assert.ok(pool.getStats().peakBytes <= maxBytes);
}

async function checkTiledPixels() {
  const width = 530;
  const height = 260;
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 260; col < 267; col++) pixels[(row * width + col) * 4 + 3] = 255;
    for (let col = 450; col < 457; col++) pixels[(row * width + col) * 4 + 3] = 255;
  }
  const read = async ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => {
    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * width + x) * 4;
      out.set(pixels.subarray(from, from + w * 4), row * w * 4);
    }
    return out;
  };
  for (const wrap of [false, true]) {
    const seeds = [{ x: 10, y: 40 }];
    const expected = bucketMask(pixels, width, height, seeds, 0, 2, wrap);
    const fill = await tiledBucketFill(width, height, seeds, 0, 2, wrap, read, () => true);
    assert.ok(expected?.data && fill);
    const actual = fill.maskFor({ x: 0, y: 0, w: width, h: height });
    const mismatch = actual.findIndex((value, index) => value !== expected.data![index]);
    assert.equal(mismatch, -1, `Tiled fill coverage diverged at pixel ${mismatch} (wrap = ${wrap})`);
  }
  const patch = await buildTiledFilterPatch({
    filter: { id: 'invert', values: {} }, width, height, budget: MiB, newLayer: false, current: () => true, read,
    compute: async (source) => Uint8Array.from(source, (value, i) => i % 4 === 3 ? value : value + 1),
  });
  assert.equal(patch?.afterTiles.length, 6);
  const edge = patch!.afterTiles[5];
  assert.equal(edge.width, 18);
  assert.equal(edge.height, 4);
  assert.equal(decompressTileBuffer(edge.data as Uint8Array, edge.compression, edge.width * edge.height * 4)?.[0], 1);
}

async function main() {
  checkProfile();
  for (const solo of [true, false]) {
    for (const limit of [4096, 8192]) {
      console.log(`Simulating ${limit}px WebGL limit in ${solo ? 'solo' : 'collaborative'} mode`);
      await checkLayerManager(solo, limit, true);
    }
    checkLru(solo);
  }
  console.log('Simulating the desktop GPU profile');
  await checkLayerManager(false, 16384, false);
  console.log('Checking tiled fill and filter pixels');
  await checkTiledPixels();
  const read = (file: string) => readFileSync(resolve(process.cwd(), 'apps/client/src', file), 'utf8');
  const manager = read('engine/LayerManager.ts');
  assert.match(manager, /constrained = this\.deviceProfile\.isConstrained/);
  for (const tool of ['useBrushTool', 'useFillTools', 'useSelectionTools']) {
    const source = read(`components/workspace/tools/${tool}.ts`);
    assert.match(source, /readCompositeRegionsAsync\(/);
    assert.doesNotMatch(source, /getCompositeTexture\(/);
  }
  console.log('mobile-large-canvas checks passed (renderer and GPU pressure simulation)');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

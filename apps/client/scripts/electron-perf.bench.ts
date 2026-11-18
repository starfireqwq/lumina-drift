/**
 * Real-machine Electron Performance Benchmark for Lumina Drift (atelier-sync)
 *
 * Tests against built Electron renderer (default) or packaged .exe (--packaged)
 * using an isolated --user-data-dir so running desktop instances & Port 3000 server are untouched.
 *
 * Suites:
 *   8k   : 8192x8192 + 5 full-tile layers (5,120 tiles) + Idle / Normal Brush / Lasso / Lasso + Mixer Brush + IDB save
 *   14k  : 14000x9800 + 5 dense layers + Lasso + Mixer Brush stress & VRAM headroom
 *   anim : 3000x2500 + 180 unique painted cels (1,800 frames = 2.5m @ 12fps) playback & scrub & DOM cost
 *
 * Usage:
 *   .\apps\server\node_modules\.bin\tsx.cmd apps/client/scripts/electron-perf.bench.ts [--suite=all|8k|14k|anim] [--packaged]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { compressTileBuffer } from '../../../packages/shared/src/tiles/tile-compress.ts';

const require = createRequire(path.resolve('apps/server/package.json'));
const { _electron: electron } = require('playwright-core') as typeof import('playwright-core');

type SuiteName = '8k' | '14k' | 'anim';

interface CliOpts {
  suites: SuiteName[];
  packaged: boolean;
}

function parseCli(): CliOpts {
  const args = process.argv.slice(2);
  let suiteArg = 'all';
  let packaged = false;
  for (const a of args) {
    if (a.startsWith('--suite=')) suiteArg = a.slice('--suite='.length);
    else if (a === '--packaged') packaged = true;
  }
  const suites: SuiteName[] =
    suiteArg === 'all' ? ['8k', '14k', 'anim'] : (suiteArg.split(',').filter(Boolean) as SuiteName[]);
  return { suites, packaged };
}

function generatePainterlyTilesLz4(variantCount = 12): Array<{ data: Uint8Array; compression: 'lz4' }> {
  const out: Array<{ data: Uint8Array; compression: 'lz4' }> = [];
  const buf = new Uint8Array(256 * 256 * 4);
  for (let v = 0; v < variantCount; v++) {
    const rBase = 50 + ((v * 37) % 180);
    const gBase = 60 + ((v * 53) % 170);
    const bBase = 80 + ((v * 71) % 160);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const idx = (y * 256 + x) * 4;
        const bx = x >> 2;
        const by = y >> 2;
        const wave = Math.sin((bx + v * 5) * 0.28) * Math.cos((by + v * 7) * 0.24);
        const edge = bx === 0 || by === 0 || bx === 63 || by === 63 ? 28 : 0;
        buf[idx] = Math.max(0, Math.min(255, (rBase + wave * 42 + edge) | 0));
        buf[idx + 1] = Math.max(0, Math.min(255, (gBase - wave * 35) | 0));
        buf[idx + 2] = Math.max(0, Math.min(255, (bBase + wave * 28) | 0));
        buf[idx + 3] = 248;
      }
    }
    const res = compressTileBuffer(buf, 'lz4');
    out.push({ data: new Uint8Array(res.data), compression: 'lz4' });
  }
  return out;
}

const INIT_MONITOR_SCRIPT = `
(() => {
  if (!window.__name) window.__name = (fn) => fn;
  if (window.__perfBenchInstalled) return;
  window.__perfBenchInstalled = true;

  const mon = {
    active: false,
    phase: '',
    phaseStartTs: 0,
    deltas: [],
    janks: [],
    lastRafTs: 0,
    rafId: 0,
    glCounts: { drawElements: 0, drawArrays: 0, readPixels: 0, texSubImage2D: 0, texImage2D: 0, readPixelsMs: 0 },
    extractStats: { calls: 0, totalMs: 0, maxMs: 0 },
    idbPuts: [],
    lastStatsSnapshot: null,
  };
  window.__perfMonitor = mon;

  function rafStep(ts) {
    if (mon.active) {
      if (mon.lastRafTs > 0) {
        const d = ts - mon.lastRafTs;
        mon.deltas.push(d);
        if (d > 50) {
          mon.janks.push({ atMs: Math.round(ts - mon.phaseStartTs), deltaMs: Math.round(d * 10) / 10 });
        }
      }
      mon.lastRafTs = ts;
    }
    mon.rafId = requestAnimationFrame(rafStep);
  }
  mon.rafId = requestAnimationFrame(rafStep);

  // Wrap WebGL2 draw & pixel readback calls lightly
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const proto = WebGL2RenderingContext.prototype;
    for (const fn of ['drawElements', 'drawArrays', 'texSubImage2D', 'texImage2D']) {
      const orig = proto[fn];
      if (typeof orig === 'function') {
        proto[fn] = function (...args) {
          if (mon.active) mon.glCounts[fn]++;
          return orig.apply(this, args);
        };
      }
    }
    const origReadPixels = proto.readPixels;
    if (typeof origReadPixels === 'function') {
      proto.readPixels = function (...args) {
        if (!mon.active) return origReadPixels.apply(this, args);
        const t0 = performance.now();
        try {
          return origReadPixels.apply(this, args);
        } finally {
          mon.glCounts.readPixels++;
          mon.glCounts.readPixelsMs += performance.now() - t0;
        }
      };
    }
  }

  // Wrap IDBObjectStore.prototype.put for offline_canvases to time synchronous structured clone + async commit
  if (typeof IDBObjectStore !== 'undefined') {
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...rest) {
      const storeName = this.name;
      if (storeName !== 'offline_canvases' && storeName !== 'offline_tiles') {
        return origPut.call(this, value, ...rest);
      }
      const t0 = performance.now();
      const req = origPut.call(this, value, ...rest);
      const syncCloneMs = performance.now() - t0;
      let layerCount = 0;
      let tileCount = 0;
      let totalTileBytes = 0;
      if (storeName === 'offline_tiles') {
        tileCount = 1;
        const d = value && value.tile && value.tile.data;
        if (d && d.byteLength) totalTileBytes = d.byteLength;
      } else {
        if (value && value.layers) layerCount = value.layers.length;
        if (value && value.tilesByLayer) {
          for (const lId of Object.keys(value.tilesByLayer)) {
            const map = value.tilesByLayer[lId];
            if (!map) continue;
            const keys = Object.keys(map);
            tileCount += keys.length;
            for (let i = 0; i < keys.length; i++) {
              const d = map[keys[i]] && map[keys[i]].data;
              if (d && d.byteLength) totalTileBytes += d.byteLength;
            }
          }
        }
      }
      const entry = {
        store: storeName,
        phase: mon.phase || 'idle',
        atRelMs: mon.phaseStartTs ? Math.round(t0 - mon.phaseStartTs) : -1,
        syncCloneMs: Math.round(syncCloneMs * 100) / 100,
        asyncCommitMs: -1,
        layerCount,
        tileCount,
        totalTileMB: Math.round((totalTileBytes / (1024 * 1024)) * 100) / 100,
      };
      mon.idbPuts.push(entry);
      const tx = req && req.transaction;
      if (tx && typeof tx.addEventListener === 'function') {
        tx.addEventListener('complete', () => {
          entry.asyncCommitMs = Math.round((performance.now() - t0) * 100) / 100;
        });
      }
      return req;
    };
  }

  window.__perfHookExtract = () => {
    const dbg = window.__debugPixi;
    if (!dbg || !dbg.app || !dbg.app.renderer || !dbg.app.renderer.extract) return false;
    const ext = dbg.app.renderer.extract;
    if (ext.__perfWrapped) return true;
    const origPixels = ext.pixels.bind(ext);
    ext.pixels = function (...args) {
      if (!mon.active) return origPixels(...args);
      const t0 = performance.now();
      try {
        return origPixels(...args);
      } finally {
        const dt = performance.now() - t0;
        mon.extractStats.calls++;
        mon.extractStats.totalMs += dt;
        if (dt > mon.extractStats.maxMs) mon.extractStats.maxMs = dt;
      }
    };
    ext.__perfWrapped = true;
    return true;
  };

  window.__perfStart = (name) => {
    window.__perfHookExtract();
    mon.phase = name;
    mon.deltas = [];
    mon.janks = [];
    mon.glCounts = { drawElements: 0, drawArrays: 0, readPixels: 0, texSubImage2D: 0, texImage2D: 0, readPixelsMs: 0 };
    mon.extractStats = { calls: 0, totalMs: 0, maxMs: 0 };
    mon.idbPutsStartIdx = mon.idbPuts.length;
    mon.phaseStartTs = performance.now();
    mon.lastRafTs = 0;
    mon.active = true;
  };

  window.__perfEnd = () => {
    mon.active = false;
    const totalMs = performance.now() - mon.phaseStartTs;
    const arr = mon.deltas.slice().sort((a, b) => a - b);
    const n = arr.length;
    const sum = arr.reduce((s, v) => s + v, 0);
    const pct = (p) => (n ? arr[Math.min(n - 1, Math.floor((n - 1) * p))] : 0);
    const dbg = window.__debugPixi;
    const texStats = dbg && dbg.layerManager ? dbg.layerManager.getTextureStats() : null;
    const selInfo = dbg && dbg.selectionEngine ? {
      active: Boolean(dbg.selectionEngine.hasSelection && dbg.selectionEngine.hasSelection()),
      edges: dbg.selectionEngine.maskEdges ? dbg.selectionEngine.maskEdges.length : -1,
    } : null;
    let totalSprites = 0;
    let visibleSprites = 0;
    let culledFalseCount = 0;
    if (dbg && dbg.layerManager && dbg.layerManager.layers) {
      for (const item of dbg.layerManager.layers.values()) {
        if (item && item.tiles) {
          for (const t of item.tiles.values()) {
            if (t && t.sprite) {
              totalSprites++;
              if (t.sprite.visible && t.sprite.renderable) visibleSprites++;
              if (t.sprite.culled === true) culledFalseCount++;
            }
          }
        }
      }
    }
    const gl = mon.glCounts;
    const draws = gl.drawElements + gl.drawArrays;
    const r = (x) => Math.round(x * 100) / 100;
    return {
      phase: mon.phase,
      durationMs: r(totalMs),
      frames: n,
      avgFps: n && sum ? r((n * 1000) / sum) : 0,
      avgDeltaMs: n ? r(sum / n) : 0,
      p50Ms: r(pct(0.5)),
      p95Ms: r(pct(0.95)),
      p99Ms: r(pct(0.99)),
      maxMs: n ? r(arr[n - 1]) : 0,
      over16ms: mon.deltas.filter((d) => d > 16.7).length,
      over33ms: mon.deltas.filter((d) => d > 33.3).length,
      over50ms: mon.deltas.filter((d) => d > 50).length,
      over100ms: mon.deltas.filter((d) => d > 100).length,
      topJanks: mon.janks.slice().sort((a, b) => b.deltaMs - a.deltaMs).slice(0, 5),
      drawCallsTotal: draws,
      drawCallsPerFrame: n ? r(draws / n) : 0,
      readPixelsCount: gl.readPixels,
      readPixelsMs: r(gl.readPixelsMs),
      texSubImage2DCount: gl.texSubImage2D,
      texImage2DCount: gl.texImage2D,
      extractPixelsCalls: mon.extractStats.calls,
      extractPixelsTotalMs: r(mon.extractStats.totalMs),
      extractPixelsMaxMs: r(mon.extractStats.maxMs),
      tileSprites: { total: totalSprites, visibleRenderable: visibleSprites, pixiCulledTrue: culledFalseCount },
      texStats,
      selInfo,
      idbPuts: mon.idbPuts.slice(mon.idbPutsStartIdx || 0),
    };
  };
})();
`;

async function launchIsolatedElectron(packaged: boolean) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-perf-'));
  const electronExe = path.resolve('apps/client/node_modules/electron/dist/electron.exe');
  const packagedExe = path.resolve('apps/client/release/win-unpacked/Lumina-Drift-Paint.exe');
  const mainJs = path.resolve('apps/client/dist-electron/main.js');

  const commonEnv = {
    ...process.env,
    APPDATA: userDataDir,
    LOCALAPPDATA: userDataDir,
  };

  const app = packaged
    ? await electron.launch({
        executablePath: packagedExe,
        args: [`--user-data-dir=${userDataDir}`],
        env: commonEnv,
      })
    : await electron.launch({
        executablePath: electronExe,
        args: [mainJs, `--user-data-dir=${userDataDir}`],
        env: commonEnv,
      });

  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(INIT_MONITOR_SCRIPT);
  await page.waitForLoadState('domcontentloaded');

  // Also inject into current live document immediately because addInitScript runs on next navigation/reload
  await page.evaluate(INIT_MONITOR_SCRIPT);

  const cleanup = async () => {
    try {
      await app.close();
    } catch {}
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  };

  return { app, page, userDataDir, cleanup };
}

async function enterOfflineAndCreateCanvas(page: import('playwright-core').Page, title: string, width: number, height: number) {
  const submitGateway = page.locator('button[type="submit"]:has-text("開始單機作畫")');
  if (await submitGateway.isVisible({ timeout: 8000 }).catch(() => false)) {
    await submitGateway.click();
  }
  await page.locator('.atelier-canvas-viewport').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('button[title="新建畫布"]').click();
  await page.locator('#new-canvas-w').waitFor({ state: 'visible', timeout: 5000 });
  const nameInput = page.locator('form input[type="text"]').first();
  if (await nameInput.isVisible()) {
    await nameInput.fill(title);
  }
  await page.locator('#new-canvas-w').fill(String(width));
  await page.locator('#new-canvas-h').fill(String(height));
  await page.locator('button[type="submit"]:has-text("建立畫布")').click();
  await page.waitForFunction(
    ({ w, h }) => {
      const dbg = (window as any).__debugPixi;
      return dbg && dbg.layerManager && dbg.viewport && dbg.viewport.canvasWidth === w && dbg.viewport.canvasHeight === h;
    },
    { w: width, h: height },
    { timeout: 20000 }
  );
  await page.waitForTimeout(400);
}

async function seedLayerTilesInIdb(
  page: import('playwright-core').Page,
  tileVariants: Array<{ data: Uint8Array; compression: 'lz4' }>,
  cols: number,
  rows: number,
  maxLayers: number,
  sparseStep = 1
) {
  const packedVariants = tileVariants.map((v) => Array.from(v.data));
  const summary = await page.evaluate(
    async ({ variants, cols: cCount, rows: rCount, maxLayers: layerCap, sparseStep: step }) => {
      const openDb = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('LuminaDrift_OfflineStorage');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const db = await openDb();
      const txRead = db.transaction('offline_canvases', 'readonly');
      const all: any[] = await new Promise((resolve, reject) => {
        const req = txRead.objectStore('offline_canvases').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      // Pick latest created canvas record
      all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const rec = all[0];
      if (!rec) throw new Error('No OfflineCanvasRecord found in IDB');

      const u8Variants = variants.map((arr) => new Uint8Array(arr));
      const rasterLayers = rec.layers
        .filter((l: any) => (l.layerType || l.type) === 'raster')
        .slice(0, layerCap);
      let seededTiles = 0;
      let totalBytes = 0;

      for (let li = 0; li < rasterLayers.length; li++) {
        const layerId = rasterLayers[li].id;
        const layerMap: Record<string, any> = {};
        for (let r = 0; r < rCount; r += step) {
          for (let c = 0; c < cCount; c += step) {
            const payload = u8Variants[(c * 3 + r * 5 + li) % u8Variants.length];
            layerMap[`${c}_${r}`] = {
              col: c,
              row: r,
              width: 256,
              height: 256,
              compression: 'lz4',
              data: payload,
            };
            seededTiles++;
            totalBytes += payload.byteLength;
          }
        }
        rec.tilesByLayer[layerId] = layerMap;
      }
      rec.updatedAt = Date.now();
      rec.seq = (rec.seq || 0) + 1;

      const txWrite = db.transaction('offline_canvases', 'readwrite');
      await new Promise<void>((resolve, reject) => {
        txWrite.objectStore('offline_canvases').put(rec);
        txWrite.oncomplete = () => resolve();
        txWrite.onerror = () => reject(txWrite.error);
      });
      db.close();
      return {
        canvasId: rec.canvas.id,
        width: rec.canvas.width,
        height: rec.canvas.height,
        rasterLayerIds: rasterLayers.map((l: any) => l.id),
        seededTiles,
        lz4PayloadMB: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
      };
    },
    { variants: packedVariants, cols, rows, maxLayers, sparseStep }
  );
  return summary;
}

async function reloadAndOpenCanvas(
  page: import('playwright-core').Page,
  title: string,
  expectedW: number,
  expectedH: number
) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(INIT_MONITOR_SCRIPT);
  const submitGateway = page.locator('button[type="submit"]:has-text("開始單機作畫")');
  if (await submitGateway.isVisible({ timeout: 8000 }).catch(() => false)) {
    await submitGateway.click();
  }
  await page.locator('.atelier-canvas-viewport').waitFor({ state: 'visible', timeout: 20000 });
  const tabBtn = page.locator(`button:has-text("${title}")`).first();
  if (await tabBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await tabBtn.click();
  }
  await page.waitForFunction(
    ({ w, h }) => {
      const dbg = (window as any).__debugPixi;
      return dbg && dbg.layerManager && dbg.viewport && dbg.viewport.canvasWidth === w && dbg.viewport.canvasHeight === h;
    },
    { w: expectedW, h: expectedH },
    { timeout: 60000 }
  );
  await page.waitForTimeout(1200);
}

async function setZoomAtCenter(page: import('playwright-core').Page, scale: number) {
  await page.evaluate((targetScale) => {
    const dbg = (window as any).__debugPixi;
    if (!dbg || !dbg.viewport) return;
    const vp = dbg.viewport;
    const rect = (dbg.app?.canvas as HTMLCanvasElement)?.getBoundingClientRect?.();
    const vw = rect?.width || vp.viewWidth || window.innerWidth;
    const vh = rect?.height || vp.viewHeight || window.innerHeight;
    if (typeof vp.centerInView === 'function') vp.centerInView(vw, vh, true);
    const curZoom = vp.getState?.()?.zoom || 1;
    if (typeof vp.zoomAt === 'function' && rect) {
      vp.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, targetScale / Math.max(0.01, curZoom));
    } else if (typeof vp.setZoom === 'function') {
      vp.setZoom(targetScale);
    }
  }, scale);
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const dbg = (window as any).__debugPixi;
    const vp = dbg?.viewport;
    return vp
      ? {
          canvasWidth: vp.canvasWidth,
          canvasHeight: vp.canvasHeight,
          ...(vp.getState?.() || {}),
        }
      : null;
  });
}

async function setRangeValue(page: import('playwright-core').Page, selector: string, value: number) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  await loc.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, String(v));
    else input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function dragStroke(
  page: import('playwright-core').Page,
  points: Array<[number, number]>,
  stepDelayMs = 12
) {
  if (points.length < 2) return;
  const [x0, y0] = points[0];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) {
    await page.mouse.move(points[i][0], points[i][1], { steps: 3 });
    if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
  }
  await page.mouse.up();
}

async function getViewportCenterBox(page: import('playwright-core').Page) {
  const box = await page.locator('.atelier-canvas-viewport').boundingBox();
  if (!box) throw new Error('Viewport box not found');
  return {
    cx: box.x + box.width * 0.5,
    cy: box.y + box.height * 0.5,
    w: box.width,
    h: box.height,
  };
}

async function runSuite8K(packaged: boolean) {
  console.log(`\n=== Running Suite 8K (8192x8192 + 5 Full Layers + Lasso + Mixer + IDB Save) [packaged=${packaged}] ===`);
  const { page, cleanup } = await launchIsolatedElectron(packaged);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await enterOfflineAndCreateCanvas(page, 'Perf8K', 8192, 8192);
    // Add 4 more raster layers (5 total)
    const addLayerBtn = page.locator('button[aria-label="新增點陣圖層"]');
    for (let i = 0; i < 4; i++) {
      await addLayerBtn.click();
      await page.waitForTimeout(80);
    }

    const variants = generatePainterlyTilesLz4(12);
    const seedInfo = await seedLayerTilesInIdb(page, variants, 32, 32, 5, 1);
    console.log('Seeded 8K IDB:', JSON.stringify(seedInfo));

    const tReload0 = performance.now();
    await reloadAndOpenCanvas(page, 'Perf8K', 8192, 8192);
    const reloadMs = Math.round(performance.now() - tReload0);
    console.log(`8K Reload & Decode Time: ${reloadMs} ms`);

    const vpInfo = await setZoomAtCenter(page, 1.5);
    const gpuCaps = await page.evaluate(() => {
      const dbg = (window as any).__debugPixi;
      const gl = dbg?.app?.renderer?.gl;
      return {
        maxTex: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null,
        renderer: gl ? gl.getParameter(gl.RENDERER) : null,
        vpInfo: dbg?.layerManager?.getTextureStats?.(),
      };
    });
    console.log('Viewport & GL Info:', JSON.stringify({ vpInfo, maxTex: gpuCaps.maxTex, renderer: gpuCaps.renderer }));

    const { cx, cy } = await getViewportCenterBox(page);

    async function clickTool(ariaPrefix: string) {
      const btn = page.locator(`button[aria-label^="${ariaPrefix}"]`).first();
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
    }

    // Phase 1: Idle Zoomed In (1.5s)
    await page.evaluate(() => (window as any).__perfStart('1_idle_zoomed_in'));
    await page.waitForTimeout(1500);
    const p1 = await page.evaluate(() => (window as any).__perfEnd());
    console.log('PHASE:', JSON.stringify(p1));

    // Phase 2: Normal Brush Baseline (colorMixing=0, no selection)
    await clickTool('一般畫筆');
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__perfStart('2_normal_brush'));
    for (let s = 0; s < 3; s++) {
      const yOff = (s - 1) * 60;
      await dragStroke(page, [
        [cx - 220, cy + yOff],
        [cx - 110, cy + yOff + 25],
        [cx, cy + yOff - 25],
        [cx + 110, cy + yOff + 25],
        [cx + 220, cy + yOff],
      ]);
      await page.waitForTimeout(120);
    }
    const p2 = await page.evaluate(() => (window as any).__perfEnd());
    console.log('PHASE:', JSON.stringify(p2));

    // Wait for Phase 2 IDB save to settle
    await page.waitForTimeout(1400);

    // Phase 3: Lasso Selection Creation + Normal Brush
    await clickTool('套索選區');
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__perfStart('3a_lasso_create'));
    await dragStroke(page, [
      [cx - 180, cy - 160],
      [cx + 180, cy - 150],
      [cx + 200, cy + 160],
      [cx - 170, cy + 170],
      [cx - 180, cy - 160],
    ]);
    await page.waitForTimeout(400);
    const p3a = await page.evaluate(() => (window as any).__perfEnd());
    console.log('PHASE:', JSON.stringify(p3a));

    // Switch back to Brush inside Lasso Selection
    await clickTool('一般畫筆');
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__perfStart('3b_lasso_plus_normal_brush'));
    await dragStroke(page, [
      [cx - 140, cy - 40],
      [cx, cy + 50],
      [cx + 140, cy - 40],
    ]);
    await page.waitForTimeout(150);
    const p3b = await page.evaluate(() => (window as any).__perfEnd());
    console.log('PHASE:', JSON.stringify(p3b));

    await page.waitForTimeout(1400);

    // Phase 4: Lasso Selection + Watercolor Mixer Brush (size=64, colorMixing=0.75, wetness=0.7)
    const settingsBtn = page.locator('button:has-text("筆刷動態設定")').first();
    await settingsBtn.click();
    await page.locator('input[aria-label="混色度 (Color Mixing)"]').waitFor({ state: 'visible', timeout: 5000 });
    await setRangeValue(page, 'input[aria-label="尺寸"]', 64);
    await setRangeValue(page, 'input[aria-label="混色度 (Color Mixing)"]', 0.75);
    await setRangeValue(page, 'input[aria-label="顏料飽和衰減 (Wetness)"]', 0.7);
    await page.locator('button:has-text("完成")').first().click();
    await page.waitForTimeout(200);

    await page.evaluate(() => (window as any).__perfStart('4a_lasso_plus_mixer_brush'));
    for (let s = 0; s < 3; s++) {
      const yOff = (s - 1) * 50;
      await dragStroke(page, [
        [cx - 160, cy + yOff],
        [cx - 60, cy + yOff + 40],
        [cx + 60, cy + yOff - 40],
        [cx + 160, cy + yOff],
      ]);
      await page.waitForTimeout(100);
    }
    const p4a = await page.evaluate(() => (window as any).__perfEnd());
    console.log('PHASE:', JSON.stringify(p4a));

    // Phase 4b: Pen-Up Idle Waiting for 1000ms offlineStore IDB persistRecordNow()
    await page.evaluate(() => (window as any).__perfStart('4b_pen_up_idb_persist'));
    await page.waitForTimeout(1800);
    const p4b = await page.evaluate(() => (window as any).__perfEnd());
    console.log('PHASE:', JSON.stringify(p4b));

    const results = { reloadMs, errors, phases: [p1, p2, p3a, p3b, p4a, p4b] };
    console.log('RESULT_8K:', JSON.stringify(results, null, 2));
    return results;
  } finally {
    await cleanup();
  }
}

async function runSuite14K(packaged: boolean) {
  console.log(`\n=== Running Suite 14K (14000x9800 + 5 Full Layers + Lasso + Mixer Brush) [packaged=${packaged}] ===`);
  const { page, cleanup } = await launchIsolatedElectron(packaged);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await enterOfflineAndCreateCanvas(page, 'Perf14K', 14000, 9800);
    const addLayerBtn = page.locator('button[aria-label="新增點陣圖層"]');
    for (let i = 0; i < 4; i++) {
      await addLayerBtn.click();
      await page.waitForTimeout(80);
    }

    // 14000 / 256 = 55 cols, 9800 / 256 = 39 rows (2,145 tiles/layer * 5 = 10,725 tiles!)
    const variants = generatePainterlyTilesLz4(8);
    const seedInfo = await seedLayerTilesInIdb(page, variants, 55, 39, 5, 1);
    console.log('Seeded 14K IDB:', JSON.stringify(seedInfo));

    const tReload0 = performance.now();
    await reloadAndOpenCanvas(page, 'Perf14K', 14000, 9800);
    const reloadMs = Math.round(performance.now() - tReload0);
    console.log(`14K Reload & Decode Time: ${reloadMs} ms`);

    await setZoomAtCenter(page, 1.0);
    const { cx, cy } = await getViewportCenterBox(page);

    // Phase 1: Idle Zoomed In
    await page.evaluate(() => (window as any).__perfStart('14k_idle'));
    await page.waitForTimeout(1500);
    const pIdle = await page.evaluate(() => (window as any).__perfEnd());

    // Phase 2: Normal Brush
    await page.locator('button[aria-label^="一般畫筆"]').click();
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__perfStart('14k_normal_brush'));
    await dragStroke(page, [
      [cx - 200, cy - 40],
      [cx, cy + 40],
      [cx + 200, cy - 40],
    ]);
    await page.waitForTimeout(120);
    const pBrush = await page.evaluate(() => (window as any).__perfEnd());

    // Phase 3: Lasso + Mixer Brush (test resident 14000x9800 double RT behavior & limits!)
    await page.waitForTimeout(1300);
    const lassoBtn = page.locator('button[aria-label^="套索選區"]').first();
    await lassoBtn.scrollIntoViewIfNeeded();
    await lassoBtn.click();
    await page.waitForTimeout(150);
    await dragStroke(page, [
      [cx - 150, cy - 120],
      [cx + 150, cy - 120],
      [cx + 150, cy + 120],
      [cx - 150, cy + 120],
      [cx - 150, cy - 120],
    ]);
    await page.waitForTimeout(300);

    await page.locator('button[aria-label^="一般畫筆"]').click();
    await page.locator('button:has-text("筆刷動態設定")').first().click();
    await page.locator('input[aria-label="混色度 (Color Mixing)"]').waitFor({ state: 'visible', timeout: 5000 });
    await setRangeValue(page, 'input[aria-label="尺寸"]', 64);
    await setRangeValue(page, 'input[aria-label="混色度 (Color Mixing)"]', 0.75);
    await page.locator('button:has-text("完成")').first().click();
    await page.waitForTimeout(200);

    await page.evaluate(() => (window as any).__perfStart('14k_lasso_mixer_brush'));
    await dragStroke(page, [
      [cx - 100, cy - 20],
      [cx, cy + 40],
      [cx + 100, cy - 20],
    ]);
    await page.waitForTimeout(1500);
    const pMixer = await page.evaluate(() => (window as any).__perfEnd());

    const results = { reloadMs, errors, phases: [pIdle, pBrush, pMixer] };
    console.log('RESULT_14K:', JSON.stringify(results, null, 2));
    return results;
  } finally {
    await cleanup();
  }
}

async function runSuiteAnim(packaged: boolean) {
  console.log(`\n=== Running Suite Anim (3000x2500 + 180 Painted Cels x Hold 10 = 1,800 Frames / 2.5m @ 12fps) [packaged=${packaged}] ===`);
  const { page, cleanup } = await launchIsolatedElectron(packaged);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await enterOfflineAndCreateCanvas(page, 'PerfAnim', 3000, 2500);

    // Open animation timeline and click Create Animation Folder via real UI
    await page.locator('button[aria-label^="逐格動畫"]').click();
    const createAnimBtn = page.locator('button:has-text("建立動畫資料夾")').first();
    await createAnimBtn.waitFor({ state: 'visible', timeout: 5000 });
    await createAnimBtn.click();
    await page.waitForTimeout(500);

    // Seed 180 unique cel layers inside the created animation folder (hold = 10 -> 1,800 frames = 150s @ 12fps!)
    // 3000x2500 -> 12 x 10 tiles/cel; seed 36 painted tiles per cel (6x6 center region = 36*180 = 6,480 tiles)
    const variants = generatePainterlyTilesLz4(6);
    const packedVariants = variants.map((v) => Array.from(v.data));

    const animSeedInfo = await page.evaluate(
      async ({ variants: vArr }) => {
        const openDb = () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('LuminaDrift_OfflineStorage');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
        const db = await openDb();
        const txRead = db.transaction('offline_canvases', 'readonly');
        const all: any[] = await new Promise((resolve, reject) => {
          const req = txRead.objectStore('offline_canvases').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const rec = all[0];
        if (!rec) throw new Error('No OfflineCanvasRecord found');

        const folder = rec.layers.find((l: any) => (l.layerType || l.type) === 'group' && l.meta?.animation);
        const templateCel = rec.layers.find((l: any) => l.parentId === folder?.id && (l.layerType || l.type) === 'raster');
        if (!folder || !templateCel) {
          throw new Error('Could not find created animation folder or template cel in IDB');
        }

        const u8Variants = vArr.map((arr) => new Uint8Array(arr));
        const TOTAL_CELS = 180;
        const HOLD = 10; // 180 * 10 = 1,800 frames (150s = 2.5 minutes at 12 FPS)
        const baseIdx = templateCel.orderIndex ?? 0;

        // Update template cel (cel 1)
        templateCel.meta = { ...(templateCel.meta || {}), cel: { ...(templateCel.meta?.cel || {}), hold: HOLD } };
        const celIds: string[] = [templateCel.id];

        for (let i = 1; i < TOTAL_CELS; i++) {
          const id = `cel_bench_${i}_${Date.now()}`;
          const newCel = {
            ...templateCel,
            id,
            name: `${i + 1}`,
            orderIndex: baseIdx + i * 0.01,
            meta: { ...(templateCel.meta || {}), cel: { ...(templateCel.meta?.cel || {}), hold: HOLD } },
          };
          rec.layers.push(newCel);
          celIds.push(id);
        }

        // Seed 6x6 central tiles (cols 3..8, rows 2..7) per cel so every cel is genuinely non-empty & unique
        let seededTiles = 0;
        for (let ci = 0; ci < celIds.length; ci++) {
          const cid = celIds[ci];
          const map: Record<string, any> = {};
          for (let r = 2; r < 8; r++) {
            for (let c = 3; c < 9; c++) {
              const payload = u8Variants[(c + r + ci) % u8Variants.length];
              map[`${c}_${r}`] = {
                col: c,
                row: r,
                width: 256,
                height: 256,
                compression: 'lz4',
                data: payload,
              };
              seededTiles++;
            }
          }
          rec.tilesByLayer[cid] = map;
        }
        rec.updatedAt = Date.now();
        rec.seq = (rec.seq || 0) + 1;

        const txWrite = db.transaction('offline_canvases', 'readwrite');
        await new Promise<void>((resolve, reject) => {
          txWrite.objectStore('offline_canvases').put(rec);
          txWrite.oncomplete = () => resolve();
          txWrite.onerror = () => reject(txWrite.error);
        });
        db.close();
        return {
          folderId: folder.id,
          totalCels: celIds.length,
          totalFrames: celIds.length * HOLD,
          seededTiles,
          totalLayers: rec.layers.length,
        };
      },
      { variants: packedVariants }
    );
    console.log('Seeded Anim IDB:', JSON.stringify(animSeedInfo));

    const tReload0 = performance.now();
    await reloadAndOpenCanvas(page, 'PerfAnim', 3000, 2500);
    const reloadMs = Math.round(performance.now() - tReload0);

    // Reopen timeline (if not auto-opened) and inspect DOM node bloat
    const playBtn = page.locator('button[title="播放動畫"]').first();
    const tOpen0 = performance.now();
    if (!(await playBtn.isVisible({ timeout: 500 }).catch(() => false))) {
      await page.locator('button[aria-label^="逐格動畫"]').first().click();
    }
    await playBtn.waitFor({ state: 'visible', timeout: 15000 });
    const timelineOpenMs = Math.round(performance.now() - tOpen0);

    const domCounts = await page.evaluate(() => {
      const slider = document.querySelector('[role="slider"][aria-label="時間"]');
      return {
        totalDomNodes: document.querySelectorAll('*').length,
        timelineNodes: slider ? slider.querySelectorAll('*').length : 0,
      };
    });
    console.log(`Anim Reload: ${reloadMs} ms, Timeline Open: ${timelineOpenMs} ms, DOM nodes: ${JSON.stringify(domCounts)}`);

    // Measure playback performance for 4s
    await page.evaluate(() => (window as any).__perfStart('anim_playback_4s'));
    await playBtn.click();
    await page.waitForTimeout(4000);
    await page.locator('button[title="暫停播放"]').first().click();
    const pPlay = await page.evaluate(() => (window as any).__perfEnd());

    // Measure rapid cel-to-cel stepping / scrub across different cels (triggers thaw & prefetch misses!)
    await page.waitForTimeout(400);
    const sliderBox = await page.locator('[role="slider"][aria-label="時間"]').boundingBox();
    await page.evaluate(() => (window as any).__perfStart('anim_scrub_and_nextcel'));
    if (sliderBox) {
      const y = sliderBox.y + 12;
      await page.mouse.click(sliderBox.x + 150, y);
      for (let i = 0; i < 15; i++) {
        await page.locator('button[aria-label="下一賽璐珞格"]').first().click();
        await page.waitForTimeout(60);
      }
    }
    const pScrub = await page.evaluate(() => (window as any).__perfEnd());

    const results = { reloadMs, timelineOpenMs, domCounts, errors, phases: [pPlay, pScrub] };
    console.log('RESULT_ANIM:', JSON.stringify(results, null, 2));
    return results;
  } finally {
    await cleanup();
  }
}

async function main() {
  const opts = parseCli();
  console.log(`Benchmark Config: suites=${opts.suites.join(',')} packaged=${opts.packaged}`);
  if (opts.suites.includes('8k')) await runSuite8K(opts.packaged);
  if (opts.suites.includes('14k')) await runSuite14K(opts.packaged);
  if (opts.suites.includes('anim')) await runSuiteAnim(opts.packaged);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

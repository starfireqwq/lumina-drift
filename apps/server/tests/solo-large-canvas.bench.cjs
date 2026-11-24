// Run against a built client: node apps/server/tests/solo-large-canvas.bench.cjs [desktop-4k|desktop-6k|phone-2k|phone-4k]
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve, extname, sep } = require('node:path');
const { chromium } = require('playwright-core');

const scenarios = {
  'desktop-4k': { size: 4096, phone: false, layers: 5, cels: 8, tiles: 25 },
  'desktop-6k': { size: 6000, phone: false, layers: 5, cels: 8, tiles: 36 },
  'phone-2k': { size: 2048, phone: true, layers: 3, cels: 6, tiles: 9 },
  'phone-4k': { size: 4096, phone: true, layers: 3, cels: 6, tiles: 16 },
};
const chosen = process.argv.slice(2);
assert(chosen.length <= 1 && (!chosen.length || Object.hasOwn(scenarios, chosen[0])), 'Unknown benchmark scenario');
const dist = process.env.LUMINA_BENCH_DIST ? resolve(process.env.LUMINA_BENCH_DIST) : resolve(__dirname, '../../client/dist');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };
const origin = 'http://localhost';

async function run(browser, name, config) {
  const { size, phone, layers, cels, tiles } = config;
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, serviceWorkers: 'block',
  });
  try {
    await context.route(`${origin}/**`, async (route) => {
      try {
        const pathname = new URL(route.request().url()).pathname;
        const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(dist + sep)) throw new Error('Outside fixture directory');
        await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] ?? 'application/octet-stream' });
      } catch { await route.fulfill({ status: 404 }); }
    });
    await context.addInitScript((phone) => {
      localStorage.setItem('atelier_language', 'zh-TW');
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_session_mode', 'offline');
      if (phone) {
        Object.defineProperty(navigator, 'deviceMemory', { value: 2 });
        window.atelierMobile = { isAndroid: true };
      }
    }, phone);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(origin);
    const startSolo = page.getByRole('button', { name: '開始單機作畫', exact: true });
    if (await startSolo.isVisible()) await startSolo.click();
    const ready = () => page.waitForFunction(() => window.__debugPixi?.layerManager.getLayers().length >= 1);
    await ready();
    const newCanvas = page.locator('button[title="新建畫布"]').first();
    if (await newCanvas.isVisible()) await newCanvas.click();
    else await page.keyboard.press('Control+KeyN');
    await page.locator('#new-canvas-w').fill(String(size));
    await page.locator('#new-canvas-h').fill(String(size));
    await page.getByRole('button', { name: '建立畫布', exact: true }).click();
    await page.waitForFunction((size) => window.__debugPixi?.viewport.canvasWidth === size, size);
    await page.waitForFunction((size) => window.__debugPixi?.viewport.canvasWidth === size && document.querySelector('[data-canvas-presented="true"]'), size);
    await page.evaluate(async ({ layers, cels, tiles, size }) => {
      const request = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const db = await request(indexedDB.open('LuminaDrift_OfflineStorage'));
      try {
        const store = 'offline_canvases';
        const rows = await request(db.transaction(store).objectStore(store).getAll());
        const rec = rows.filter((row) => row.canvas.width === size).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const base = rec?.layers.find((layer) => layer.layerType === 'raster');
        if (!base) throw new Error('Missing offline raster fixture');
        const folder = { ...base, id: 'bench-folder', layerType: 'group', name: 'Benchmark animation', sortOrder: 10, parentId: null, meta: { animation: { fps: 12 } } };
        const backgrounds = Array.from({ length: layers }, (_, i) => ({ ...base, id: i === 0 ? base.id : `bench-layer-${i}`, parentId: null, sortOrder: i, meta: {} }));
        const frames = Array.from({ length: cels }, (_, i) => ({ ...base, id: `bench-cel-${i}`, parentId: folder.id, name: String(i + 1), sortOrder: 11 + i, meta: { cel: { hold: 3 } } }));
        rec.layers = [...backgrounds, folder, ...frames];
        rec.tilesByLayer = {};
        const grid = Math.ceil(Math.sqrt(tiles));
        const start = Math.floor((Math.floor(size / 256) - grid) / 2);
        [...backgrounds, ...frames].forEach(({ id }, index) => {
          const data = new Uint8Array(256 * 256 * 4);
          for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
            if ((x + y + index * 5) % 31 >= 2) continue;
            const p = (y * 256 + x) * 4;
            data.set([25, 18 + index * 8, 70, 255], p);
          }
          rec.tilesByLayer[id] = {};
          for (let n = 0; n < tiles; n++) {
            const col = start + n % grid;
            const row = start + Math.floor(n / grid);
            rec.tilesByLayer[id][`${col}_${row}`] = { col, row, width: 256, height: 256, compression: 'raw', data };
          }
        });
        const tx = db.transaction(store, 'readwrite');
        const completed = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        tx.objectStore(store).put(rec);
        await completed;
      } finally { db.close(); }
    }, config);
    await page.reload();
    await page.waitForFunction(({ size, count }) => document.querySelector('[data-canvas-presented="true"]') &&
      window.__debugPixi?.viewport.canvasWidth === size && window.__debugPixi?.layerManager.getLayers().length >= count, { size, count: layers + cels });
    await page.evaluate(() => {
      const mon = window.bench = { gaps: [], paint: [], step: [], save: [], running: true, frames: 0, drawFrames: 0, pendingPaint: null, pendingStep: null };
      const { app, animationEngine } = window.__debugPixi;
      const render = app.render.bind(app);
      app.render = () => {
        render();
        const now = performance.now();
        if (mon.pendingPaint !== null) { mon.paint.push(now - mon.pendingPaint); mon.pendingPaint = null; }
        if (mon.pendingStep !== null) { mon.step.push(now - mon.pendingStep); mon.pendingStep = null; }
        if (animationEngine.getIsPlaying()) mon.drawFrames++;
      };
      animationEngine.onFrameChange(() => { if (animationEngine.getIsPlaying()) mon.frames++; });
      let last = performance.now();
      const tick = (now) => { mon.gaps.push(now - last); last = now; if (mon.running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      document.addEventListener('pointerdown', (e) => {
        if (e.target.closest?.('.atelier-canvas-viewport')) mon.pendingPaint = performance.now();
      }, true);
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const start = performance.now();
        const tx = original.apply(this, args);
        if (this.name === 'LuminaDrift_OfflineStorage' && args[1] === 'readwrite') {
          tx.addEventListener('complete', () => mon.save.push(performance.now() - start));
        }
        return tx;
      };
    });
    const box = await page.locator('.atelier-canvas-viewport canvas').first().boundingBox();
    assert(box, 'Rendering canvas unavailable');
    const x = Math.round(box.x + box.width * 0.5);
    const y = Math.round(box.y + box.height * 0.4);
    for (let i = 0; i < 4; i++) {
      if (phone) await page.touchscreen.tap(x + i * 7, y + i * 7);
      else { await page.mouse.move(x, y + i * 7); await page.mouse.down(); await page.mouse.move(x + 75, y + i * 7 + 20, { steps: 12 }); await page.mouse.up(); }
    }
    await page.waitForTimeout(800);
    await page.waitForFunction(() => window.__debugPixi.animationEngine.getLength() >= 6);
    for (let i = 0; i < 8; i++) {
      await page.evaluate((index) => {
        const { animationEngine } = window.__debugPixi;
        window.bench.pendingStep = performance.now();
        animationEngine.goTo((index * 3) % animationEngine.getLength());
      }, i + 1);
      await page.waitForTimeout(50);
    }
    await page.evaluate(() => {
      window.bench.gaps.length = 0;
      window.bench.playStartedAt = performance.now();
      window.__debugPixi.animationEngine.play();
    });
    await page.waitForTimeout(3000);
    const result = await page.evaluate(() => {
      const { gaps, paint, step, save, frames, drawFrames, playStartedAt } = window.bench;
      window.bench.running = false;
      const elapsed = (performance.now() - playStartedAt) / 1000;
      const p95 = (values) => values.length ? Number(values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(2)) : null;
      return { rafFps: Number((1000 * gaps.length / gaps.reduce((sum, value) => sum + value, 0)).toFixed(1)),
        animationFps: Number((frames / elapsed).toFixed(1)), presentedFps: Number((drawFrames / elapsed).toFixed(1)),
        playbackGapP95Ms: p95(gaps), playbackGapMaxMs: Math.round(Math.max(...gaps)),
        inputToFrameP95Ms: p95(paint), frameSwitchToFrameP95Ms: p95(step), saveTransactionP95Ms: p95(save),
        samples: { paint: paint.length, step: step.length, save: save.length },
        jsHeapBytes: performance.memory?.usedJSHeapSize ?? null, textures: window.__debugPixi.layerManager.getTextureStats() };
    });
    assert.ok(result.animationFps > 0 && result.samples.paint > 0 && result.samples.step > 0 && result.samples.save > 0,
      `Missing benchmark samples: ${JSON.stringify(result)}`);
    console.log(JSON.stringify({ scenario: name, config, result }));
  } finally { await context.close(); }
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.LUMINA_BENCH_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--enable-precise-memory-info'] });
  try {
    for (const [name, cfg] of Object.entries(scenarios)) if (!chosen.length || chosen[0] === name) await run(browser, name, cfg);
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

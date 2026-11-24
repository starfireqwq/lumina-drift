// Run after building the client: node apps/server/tests/brush-feel-browser.cjs
// Add --electron after building dist-electron, or --manual --size=6 for a live pen.
// Both modes use an offline canvas. Browser mode serves the built assets without a server.
const assert = require('node:assert/strict');
const { appendFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { extname, join, resolve, sep } = require('node:path');
const { chromium, _electron: electron } = require('playwright-core');
const { evaluatePressureCurve } = require('@atelier/shared');

const dist = process.env.BRUSH_FEEL_DIST ? resolve(process.env.BRUSH_FEEL_DIST) : resolve(__dirname, '../../client/dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const origin = 'http://localhost';
const pressureLine = (y, stride, pressure) => Array.from({ length: 240 / stride + 1 },
  (_, i) => [110 + i * stride, y, pressure, 8 * i]);
const fixtures = {
  lightSlow: pressureLine(100, 4, 0.02),
  lightFast: pressureLine(145, 60, 0.02),
  ramp: [[110, 190, 0.02, 0], [150, 190, 0.1, 8], [220, 190, 0.5, 16],
    [290, 190, 1, 24], [300, 190, 0.025, 32], [380, 190, 0.02, 40]],
  dot: [[110, 240, 0.02, 0]],
  flick: [[110, 285, 0.15, 0], [124, 285, 0.09, 8], [150, 272, 0.025, 16]],
  corner: [[110, 350, 0.7, 0], [230, 350, 0.7, 8], [230, 410, 0.7, 16]],
  // The last six pressures and packet intervals come from a HUION pen flick.
  physicalFlick: [[110, 300, 0.42, 0], [200, 300, 0.42, 16], [218, 300, 0.4111, 21],
    [223, 300, 0.3691, 25], [228, 300, 0.3203, 29], [233, 300, 0.2627, 32],
    [238, 300, 0.1934, 38], [242, 300, 0.1133, 40]],
  jitter: Array.from({ length: 61 }, (_, i) => [110 + i * 4, 60 + (i % 2 ? -2 : 2), 0.6, i * 4]),
  opacity: [[110, 450, 0.1, 0], [170, 450, 0.1, 8], [230, 450, 0.5, 16], [350, 450, 0.9, 24]],
};

async function setup(browser, settings) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    try {
      await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] ?? 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await context.addInitScript(configureBrush, settings);
  const page = await context.newPage();
  await page.goto(origin);
  await prepareCanvas(page);
  return { page, close: () => context.close() };
}

function configureBrush({ opacityOnly = false, size = 36, stabilizerLevel = 0 } = {}) {
  localStorage.setItem('atelier_language', 'en-US');
  localStorage.setItem('atelier_gateway_resolved', '1');
  localStorage.setItem('atelier_gateway_skip_on_launch', '1');
  localStorage.setItem('atelier_session_mode', 'offline');
  localStorage.setItem('atelier_brush_tools', JSON.stringify({
    brushDefaultsVersion: 1,
    brush: {
      brushType: 'pen', size, minSize: 0, hardness: 1, opacity: 1, flow: 1, spacing: 0.02,
      antiAlias: 'medium', stabilizerLevel,
      dynamics: opacityOnly ? { size: { pressure: false }, opacity: { pressure: true, min: 0 } }
        : { opacity: { pressure: false } },
    },
    eraser: { size: 40, minSize: 0, opacity: 1, stabilizerLevel: 0, eraserMode: 'hard' },
  }));
}

async function prepareCanvas(page) {
  page.setDefaultTimeout(12000);
  const start = page.getByRole('button', { name: 'Start Drawing', exact: true });
  if (await start.isVisible()) await start.click();
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 15000 });
  const newCanvas = page.locator('button[title="New Canvas"]').first();
  if (await newCanvas.isVisible()) await newCanvas.click();
  else await page.keyboard.press('Control+KeyN');
  await page.locator('#new-canvas-w').fill('1024');
  await page.locator('#new-canvas-h').fill('640');
  await page.getByRole('button', { name: 'Create Canvas', exact: true }).click();
  await page.waitForFunction(() => {
    const viewport = window.__debugPixi?.viewport;
    return viewport?.canvasWidth === 1024 && viewport.canvasHeight === 640 &&
      document.querySelector('[data-canvas-presented="true"]');
  });
  await page.evaluate(() => window.__debugPixi.viewport.setZoom(1));
  await page.keyboard.press('KeyD');
}

async function launchDesktop(settings) {
  const root = mkdtempSync(join(tmpdir(), 'lumina-brush-feel-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  for (const key of ['APPDATA', 'LOCALAPPDATA']) {
    env[key] = join(root, key);
    mkdirSync(env[key]);
  }
  const client = resolve(__dirname, '../../client');
  const app = await electron.launch({
    executablePath: process.env.LUMINA_BRUSH_ELECTRON ?? join(client, 'node_modules/electron/dist/electron.exe'),
    args: [join(client, 'dist-electron/main.js'), `--user-data-dir=${join(root, 'profile')}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(configureBrush, settings);
    await page.reload();
    await prepareCanvas(page);
    return { page, close: () => app.close() };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function penStroke(page, points) {
  const count = await page.evaluate(() => window.__debugPixi.undo.getUndoCount());
  await page.evaluate((points) => {
    const surface = document.querySelector('.atelier-canvas-viewport');
    const { app, viewport } = window.__debugPixi;
    const rect = app.canvas.getBoundingClientRect();
    const start = performance.now();
    function send(type, [x, y, pressure, time]) {
      const screen = viewport.canvasToScreen(x, y);
      const event = new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 7, isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0,
        clientX: screen.x + rect.left, clientY: screen.y + rect.top, pressure,
      });
      Object.defineProperty(event, 'timeStamp', { value: start + time });
      surface.dispatchEvent(event);
    }
    send('pointerdown', points[0]);
    for (const point of points.slice(1)) send('pointermove', point);
    const [x, y, , time] = points.at(-1);
    send('pointerup', [x, y, 0, time + 1]);
  }, points);
  await page.waitForFunction(count => window.__debugPixi.undo.getUndoCount() === count + 1, count);
  await page.waitForTimeout(100);
}

async function mouseStroke(page, from, to) {
  const count = await page.evaluate(() => window.__debugPixi.undo.getUndoCount());
  const points = await page.evaluate((points) => {
    const { app, viewport } = window.__debugPixi;
    const rect = app.canvas.getBoundingClientRect();
    return points.map(([x, y]) => {
      const screen = viewport.canvasToScreen(x, y);
      return [screen.x + rect.left, screen.y + rect.top];
    });
  }, [from, to]);
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  await page.mouse.move(...points[1], { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(count => window.__debugPixi.undo.getUndoCount() === count + 1, count);
}

async function readPixels(page) {
  return page.evaluate(async () => {
    const { layerManager } = window.__debugPixi;
    const layer = layerManager.getLayers().find(layer => layer.model.layerType === 'raster');
    const width = 512;
    const [pixels] = await layerManager.readAsync(layer.model.id, [{ x: 0, y: 0, w: width, h: 640 }]);
    const alpha = (x, y) => pixels[(y * width + x) * 4 + 3];
    const column = (x, y, r = 3) => Array.from({ length: r * 2 + 1 }, (_, i) => alpha(x, y - r + i));
    const gaps = (y, from, to) => Array.from({ length: to - from + 1 }, (_, i) => column(i + from, y))
      .filter(values => Math.max(...values) === 0).length;
    const peakWidth = (x, y) => column(x, y, 22).filter(a => a > 30).length;
    const maxAt = (x, y) => Math.max(...column(x, y));
    const center = Array.from({ length: 180 }, (_, i) => column(i + 140, 60, 22)).map(values =>
      values.reduce((sum, a, i) => sum + (i - 22) * a, 0) / Math.max(1, values.reduce((a, b) => a + b, 0)));
    return {
      slowGaps: gaps(100, 110, 349), fastGaps: gaps(145, 110, 349), tailGaps: gaps(190, 329, 379),
      firstLightInkX: Array.from({ length: 240 }, (_, i) => 110 + i).find(x => maxAt(x, 145) > 0),
      rampWidths: [110, 150, 220, 290, 350].map(x => peakWidth(x, 190)),
      dotAlpha: Math.max(...[108, 109, 110, 111, 112].flatMap(x => column(x, 240))),
      flickTipAlpha: maxAt(149, 272),
      cornerAlpha: alpha(229, 350), opacity: [130, 215, 320].map(x => alpha(x, 450)),
      physicalFlickWidths: [218, 228, 233, 238, 241, 242].map(x => peakWidth(x, 300)),
      physicalFlickTipAlpha: maxAt(242, 300),
      jitterRmsPx: Number(Math.sqrt(center.reduce((sum, y) => sum + y * y, 0) / center.length).toFixed(3)),
      mouseWidth: peakWidth(250, 500), hardErased: [alpha(190, 500), alpha(204, 500)],
      softErased: [alpha(190, 560), alpha(204, 560)],
    };
  });
}

async function recordPhysicalPen(page, settings, runtime) {
  const log = join(mkdtempSync(join(tmpdir(), 'lumina-physical-pen-')), 'strokes.jsonl');
  await page.exposeFunction('recordBrushFeelStroke', stroke => {
    // Mapping the browser's raw samples here records the configured response before stabilization.
    const mappedPointerPressure = stroke.pointerType === 'pen'
      ? stroke.samples.map(point => evaluatePressureCurve(point.pressure, stroke.curve)) : null;
    appendFileSync(log, JSON.stringify({ runtime, ...settings, ...stroke, mappedPointerPressure }) + '\n');
    const pressures = stroke.samples.map(point => point.pressure);
    console.log(JSON.stringify({ type: stroke.pointerType, source: stroke.source, samples: pressures.length,
      minPressure: Math.min(...pressures), maxPressure: Math.max(...pressures), pixelAlpha: stroke.pixelAlpha }));
  });
  await page.evaluate(({ size, opacityOnly, stabilizerLevel }) => {
    document.title = `Lumina HUION · ${size} px · ${opacityOnly ? 'Opacity' : 'Size'} · ${stabilizerLevel}`;
    const surface = document.querySelector('.atelier-canvas-viewport');
    const { viewport, layerManager, undo } = window.__debugPixi;
    const active = new Map();
    const curve = JSON.parse(localStorage.getItem('atelier_stylus_pressure_curve') ?? 'null') ?? 'linear';
    const point = event => ({ ...viewport.screenToCanvas(event.clientX, event.clientY),
      pressure: event.pressure, time: event.timeStamp });
    surface.addEventListener('pointerdown', event => {
      if (event.isTrusted) active.set(event.pointerId, [point(event)]);
    }, true);
    surface.addEventListener('pointermove', event => {
      const samples = active.get(event.pointerId);
      if (!samples) return;
      const batch = event.getCoalescedEvents();
      for (const event of batch.length ? batch : [event]) samples.push(point(event));
    }, true);
    surface.addEventListener('pointercancel', event => active.delete(event.pointerId), true);
    surface.addEventListener('pointerup', event => {
      const samples = active.get(event.pointerId);
      active.delete(event.pointerId);
      if (!samples) return;
      const source = document.documentElement.dataset.drawingInput ?? 'pointer';
      const lift = point(event);
      setTimeout(async () => {
        const layer = layerManager.getLayers().find(layer => layer.model.layerType === 'raster');
        const checkpoints = [samples[0], samples[Math.floor(samples.length / 2)], samples.at(-1)];
        const positions = checkpoints.map(point => ({
          x: Math.min(1023, Math.max(0, Math.round(point.x))),
          y: Math.min(639, Math.max(0, Math.round(point.y))), w: 1, h: 1,
        }));
        const pixels = await layerManager.readAsync(layer.model.id, positions);
        await window.recordBrushFeelStroke({ pointerType: event.pointerType, source, curve, samples, lift,
          pixelAlpha: pixels.map(pixel => pixel[3]), undoCount: undo.getUndoCount() });
      }, 200);
    }, true);
  }, settings);
  await page.bringToFront();
  console.log(JSON.stringify({ ready: true, title: await page.title(), log }));
  await new Promise(resolve => page.once('close', resolve));
}

async function replay(open, runtime, settings) {
  const { page, close } = await open(settings);
  let result;
  try {
    for (const [name, points] of Object.entries(fixtures)) {
      if (name !== 'opacity') await penStroke(page, points);
    }
    await mouseStroke(page, [110, 500], [350, 500]);
    await mouseStroke(page, [110, 560], [350, 560]);
    await page.keyboard.press('KeyE');
    await page.getByRole('radio', { name: 'Hard Edge', exact: true }).click();
    await mouseStroke(page, [190, 475], [190, 525]);
    await page.getByRole('radio', { name: 'Soft Edge', exact: true }).click();
    await mouseStroke(page, [190, 535], [190, 585]);
    result = await readPixels(page);
    const inkingPreset = page.locator('button[title*="Crisp Inking Pen"]').first();
    await inkingPreset.click();
    assert.equal(await inkingPreset.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => {
      const { brushType, size, minSize, stabilizerLevel } = JSON.parse(localStorage.getItem('atelier_brush_tools')).brush;
      return { brushType, size, minSize, stabilizerLevel };
    }), { brushType: 'pen', size: 14, minSize: 0, stabilizerLevel: 4 });
    await penStroke(page, pressureLine(60, 60, 0.65));
    assert.ok(await page.evaluate(async () => {
      const { layerManager } = window.__debugPixi;
      const layer = layerManager.getLayers().find(layer => layer.model.layerType === 'raster');
      const [pixels] = await layerManager.readAsync(layer.model.id, [{ x: 210, y: 60, w: 1, h: 1 }]);
      return pixels[3] > 200;
    }), 'the built-in inking preset draws with stabilization enabled');
  } finally {
    await close();
  }
  const opacity = await open({ ...settings, opacityOnly: true });
  try {
    await penStroke(opacity.page, fixtures.opacity);
    result.opacity = (await readPixels(opacity.page)).opacity;
  } finally {
    await opacity.close();
  }
  console.log(JSON.stringify({ runtime, ...settings, ...result }));
  if (process.env.BRUSH_FEEL_BASELINE !== '1') {
    assert.ok(result.opacity[0] > 0 && result.opacity[1] > result.opacity[0] && result.opacity[2] > result.opacity[1]);
    assert.ok(result.mouseWidth > 0);
    assert.deepEqual(result.hardErased, [0, 0]);
    assert.ok(result.softErased[0] < result.softErased[1] && result.softErased[1] > 0 && result.softErased[1] < 255);
    if (settings.stabilizerLevel === 0 || settings.stabilizerLevel === 4) {
      assert.equal(result.slowGaps, 0);
      assert.equal(result.fastGaps, 0);
      assert.equal(result.tailGaps, 0);
      const [start, light, medium, peak, tail] = result.rampWidths;
      assert.ok(start <= light && light <= medium && medium < peak, 'line width grows as pressure increases');
      assert.ok(tail < peak, 'line width drops as the pen lifts');
      assert.ok(result.dotAlpha > 0);
      assert.ok(result.flickTipAlpha >= 4);
      assert.ok(result.physicalFlickWidths.at(-1) < result.physicalFlickWidths[0]);
      assert.ok(result.cornerAlpha > 0);
    }
  }
}

async function main() {
  const desktop = process.argv.includes('--electron');
  const manual = process.argv.includes('--manual');
  const runtime = desktop ? 'electron' : 'browser';
  const browser = desktop ? null : await chromium.launch({
    executablePath: process.env.LUMINA_BENCH_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: !manual,
  });
  const open = desktop ? launchDesktop : settings => setup(browser, settings);
  const sizeArg = process.argv.find(arg => arg.startsWith('--size='));
  const levelArg = process.argv.find(arg => arg.startsWith('--stabilizer='));
  const sizes = sizeArg ? [Number(sizeArg.slice('--size='.length))] : manual ? [36] : [6, 10, 36];
  const stabilizerLevel = levelArg ? Number(levelArg.slice('--stabilizer='.length)) : 0;
  try {
    for (const size of sizes) {
      assert.ok(Number.isFinite(size) && size > 0, 'Provide a positive brush size');
      const settings = { size, stabilizerLevel };
      if (manual) {
        settings.opacityOnly = process.argv.includes('--opacity-only');
        const { page, close } = await open(settings);
        try { await recordPhysicalPen(page, settings, runtime); } finally { await close(); }
      } else {
        await replay(open, runtime, settings);
      }
    }
  } finally {
    await browser?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

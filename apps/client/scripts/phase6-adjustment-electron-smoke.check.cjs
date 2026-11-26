/**
 * Phase 6 Electron smoke check for solo adjustment editing, PNG parity, and multiplayer sync.
 * Build @atelier/shared and the Electron client first, then run from the repo root:
 *   node apps/client/scripts/phase6-adjustment-electron-smoke.check.cjs
 * Each Electron instance has a fresh profile. The multiplayer server uses an ephemeral port and database.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');
const {
  DEFAULT_TILE_SIZE, getTileBounds, normalizeAdjustment, compileAdjustment, applyCompiledAdjustmentRgb,
} = require('../../../packages/shared/dist/index.js');

const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const tolerance = 4;
const checkTimeout = 10_000;
const pollInterval = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const passed = (message) => console.log(`✓ ${message}`);

function waitForExit(proc, timeout) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      resolve(false);
    }, timeout);
    proc.once('exit', onExit);
  });
}

async function stopTempServer(proc) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  if (await waitForExit(proc, 2000)) return;
  const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true,
  });
  killer.on('error', () => {});
  assert.ok(await waitForExit(proc, 5000), 'Temp server did not exit after cleanup');
}

async function startTempServer(dataDir) {
  const appModuleUrl = pathToFileURL(path.join(serverRoot, 'src/app.ts')).href;
  const tsxImportUrl = pathToFileURL(requireServer.resolve('tsx')).href;
  const launcherPath = path.join(dataDir, 'launch-temp-server.mjs');
  fs.writeFileSync(launcherPath, `
    import { buildApp } from ${JSON.stringify(appModuleUrl)};
    const app = await buildApp();
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    if (new URL(addr).port === '3000') throw new Error('Reserved server port');
    console.log('TEST_SERVER_READY=' + addr);
    process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
  `, 'utf8');
  const proc = spawn(process.execPath, ['--import', tsxImportUrl, launcherPath], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATABASE_PATH: path.join(dataDir, 'phase6-smoke.db'),
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
      JWT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Temp server start timed out')), 25_000);
      let stderr = '';
      let stdout = '';
      proc.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-4096);
        const match = stdout.match(/TEST_SERVER_READY=(http:\/\/127\.0\.0\.1:\d+)\r?\n/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-400); });
      proc.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Temp server exited (${code}): ${stderr.trim()}`));
      });
    });
    return { proc, url };
  } catch (error) {
    await stopTempServer(proc);
    throw error;
  }
}

async function launchIsolated(tempRoot, apps, label) {
  assert.ok(fs.existsSync(electronExe), 'Missing Electron executable');
  assert.ok(fs.existsSync(mainJs), 'Missing compiled Electron main');
  assert.ok(fs.existsSync(path.join(clientRoot, 'dist/index.html')), 'Missing compiled renderer');
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, `electron-${label}-`));
  const launcherPath = path.join(userDataDir, 'phase6-launcher.cjs');
  // Block the desktop startup health probe and any renderer requests to the resident port.
  fs.writeFileSync(launcherPath, `
    const { app, session } = require('electron');
    const http = require('node:http');
    const { EventEmitter } = require('node:events');
    app.setPath('userData', ${JSON.stringify(userDataDir)});
    app.setPath('sessionData', ${JSON.stringify(userDataDir)});
    const get = http.get;
    http.get = function (url, ...args) {
      if (typeof url === 'string' && new URL(url).port === '3000') {
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.destroy = () => request;
        process.nextTick(() => request.emit('error', new Error('Reserved server port')));
        return request;
      }
      return get.call(this, url, ...args);
    };
    app.whenReady().then(() => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: new URL(details.url).port === '3000' });
      });
    });
    require(${JSON.stringify(mainJs)});
  `, 'utf8');
  const env = { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir, PORT: '0' };
  delete env.VITE_DEV_SERVER_URL;
  const app = await electron.launch({
    executablePath: electronExe,
    args: [launcherPath, `--user-data-dir=${userDataDir}`],
    env,
  });
  apps.push(app);
  const pageErrors = [];
  app.context().on('weberror', (event) => pageErrors.push(event.error().message));
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  return { page, pageErrors };
}

async function waitForCanvas(page) {
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25_000 });
  await page.waitForFunction(() => Boolean(window.__debugPixi?.layerManager && window.__debugPixi?.tileEngine),
    undefined, { timeout: 15_000 });
}

async function enterOfflineCanvas(page) {
  await page.evaluate(() => localStorage.setItem('atelier_language', 'en-US'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
  await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
  await page.getByRole('spinbutton', { name: /^Width/ }).fill('768');
  await page.getByRole('spinbutton', { name: /^Height/ }).fill('640');
  await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
  await waitForCanvas(page);
}

async function loginAndOpenMpWindow(tempRoot, apps, label, serverUrl, auth, canvasId) {
  const launched = await launchIsolated(tempRoot, apps, label);
  const { page } = launched;
  await page.evaluate(({ url, token, user, id }) => {
    localStorage.setItem('atelier_language', 'en-US');
    localStorage.setItem('atelier_server_url', url);
    localStorage.setItem('atelier_gateway_resolved', 'true');
    localStorage.setItem('atelier_gateway_skip_on_launch', 'true');
    localStorage.setItem('atelier_active_canvas_id', id);
    localStorage.setItem(`atelier_token:${url}`, token);
    localStorage.setItem('atelier_token', token);
    localStorage.setItem('atelier_user', JSON.stringify(user));
  }, { url: serverUrl, ...auth, id: canvasId });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForCanvas(page);
  return launched;
}

async function getCanvasDims(page) {
  return page.evaluate(() => {
    const { canvasWidth, canvasHeight } = window.__debugPixi.tileEngine;
    return { width: canvasWidth, height: canvasHeight };
  });
}

async function setBrushColorAndSize(page, hex, sizeSteps = 5) {
  const input = page.locator('input[maxlength="7"]:visible').first();
  await input.fill(hex);
  await input.press('Enter');
  await input.blur();
  await page.keyboard.press('KeyB');
  // The CSP-style rail may show the paint category (its current sub tool) as the pressed button
  await page.locator('[aria-pressed="true"][data-tool-id="brush"]:visible, [aria-pressed="true"][data-category-id="paint"]:visible').first()
    .waitFor({ timeout: 3000 }).catch(() => {});
  await sleep(200);
  for (let i = 0; i < sizeSteps; i++) await page.keyboard.press('BracketRight');
}

async function drawPathOnCanvas(page, points) {
  await page.evaluate(async (points) => {
    const { app, viewport } = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || app.canvas;
    const rect = app.canvas.getBoundingClientRect();
    const fire = (type, [x, y], buttons) => {
      const point = viewport.canvasToScreen(x, y);
      surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 61,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: rect.left + point.x,
        clientY: rect.top + point.y,
        button: 0,
        buttons,
        pressure: buttons ? 1 : 0,
      }));
    };
    fire('pointerdown', points[0], 1);
    for (const point of points.slice(1)) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      fire('pointermove', point, 1);
    }
    fire('pointerup', points.at(-1), 0);
  }, points);
}

const row = (page, id) => page.locator(`[data-layer-id=${JSON.stringify(id)}]`);
const selectedRow = (page) => page.locator('[data-layer-id][aria-selected="true"]');
const adjustmentDialog = (page) => page.getByTestId('adjustment-dialog');
const adjustmentParam = (page, name) => adjustmentDialog(page).getByTestId(`adjustment-param-${name}`);

async function createAdjustment(page, kind) {
  await page.getByTestId('layer-add-adjustment').click();
  await page.getByTestId(`adjustment-kind-${kind}`).click();
  const dialog = adjustmentDialog(page);
  await dialog.waitFor({ timeout: checkTimeout });
  assert.equal(await dialog.getAttribute('data-adjustment-kind'), kind, 'Adjustment dialog kind');
  return selectedRow(page).filter({ has: page.locator('[data-testid^="adjustment-icon-"]') })
    .getAttribute('data-layer-id', { timeout: checkTimeout });
}

async function waitForDialogClosed(page) {
  await adjustmentDialog(page).waitFor({ state: 'hidden', timeout: checkTimeout });
  await page.locator('[aria-modal="true"]:visible').waitFor({ state: 'hidden', timeout: checkTimeout });
}

async function commitAdjustment(page) {
  await adjustmentDialog(page).getByTestId('adjustment-ok').click();
  await waitForDialogClosed(page);
}

async function runShortcut(page, shortcut) {
  await waitForDialogClosed(page);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(shortcut);
}

async function seedRegion(page, id, rect, rgba) {
  const seeded = await poll(() => page.evaluate(({ id, rect, rgba }) => {
    const { layerManager } = window.__debugPixi;
    if (!layerManager.getLayerItem(id)) return false;
    const { x, y, w, h } = rect;
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
    layerManager.writeRegion(id, x, y, w, h, pixels);
    return true;
  }, { id, rect, rgba }), Boolean);
  assert.ok(seeded, `Layer ${id} was unavailable for seeding within 10 s`);
}

async function poll(read, matches) {
  const deadline = Date.now() + checkTimeout;
  let observed = await read();
  while (!matches(observed) && Date.now() < deadline) {
    await sleep(Math.min(pollInterval, deadline - Date.now()));
    observed = await read();
  }
  return observed;
}

function maxDiff(actual, expected) {
  return Math.max(...expected.map((channel, index) => Math.abs(channel - actual[index])));
}

function pixelDetails(label, point, actual, expected) {
  return `${label} at (${point.join(', ')}): observed RGBA [${actual}], expected RGBA ${expected}`;
}

function assertPixel(actual, expected, point, label) {
  assert.ok(maxDiff(actual, expected) <= tolerance,
    pixelDetails(label, point, actual, `[${expected}] (±${tolerance})`));
}

async function readCompositePixels(page, points) {
  return page.evaluate(async (points) => {
    const { layerManager, tileEngine } = window.__debugPixi;
    const pixels = await layerManager.readVisibleCompositeAsync(true);
    return points.map(([x, y]) => {
      const offset = (y * tileEngine.canvasWidth + x) * 4;
      const a = pixels[offset + 3];
      const rgb = Array.from(pixels.subarray(offset, offset + 3), (v) => a ? Math.min(255, Math.round(v * 255 / a)) : 0);
      return [...rgb, a];
    });
  }, points);
}

async function waitForCompositePixels(page, checks, layerId) {
  const points = checks.map(([point]) => point);
  const { pixels, layerVisible } = await poll(async () => ({
    pixels: await readCompositePixels(page, points),
    layerVisible: !layerId || await row(page, layerId).isVisible(),
  }), ({ pixels, layerVisible }) => layerVisible
    && checks.every(([, expected], i) => maxDiff(pixels[i], expected) <= tolerance));
  checks.forEach(([point, expected, label], i) => {
    assertPixel(pixels[i], expected, point, `${label} (10 s timeout)`);
  });
  assert.ok(layerVisible, `Layer row ${layerId} did not appear within 10 s`);
  return pixels;
}

async function snapshotLayer(page, id, rect) {
  return page.evaluateHandle(async ({ id, rect }) => {
    const [pixels] = await window.__debugPixi.layerManager.readAsync(id, [rect]);
    return pixels.slice();
  }, { id, rect });
}

async function assertLayerUnchanged(page, id, rect, before, label) {
  const change = await page.evaluate(async ({ id, rect, before }) => {
    const [after] = await window.__debugPixi.layerManager.readAsync(id, [rect]);
    if (before.length !== rect.w * rect.h * 4 || after.length !== before.length) {
      throw new Error(`Unexpected layer readback lengths: ${before.length}, ${after.length}`);
    }
    const index = after.findIndex((channel, i) => channel !== before[i]);
    if (index === -1) return null;
    const pixel = Math.floor(index / 4);
    const offset = pixel * 4;
    return {
      point: [rect.x + pixel % rect.w, rect.y + Math.floor(pixel / rect.w)],
      actual: Array.from(after.subarray(offset, offset + 4)),
      expected: Array.from(before.subarray(offset, offset + 4)),
    };
  }, { id, rect, before });
  if (change) {
    assert.fail(pixelDetails(label, change.point, change.actual, `[${change.expected}] (raw layer bytes)`));
  }
}

async function waitForBlueStroke(page, id, rect) {
  const { best, closest } = await poll(() => page.evaluate(async ({ id, rect }) => {
    const [pixels] = await window.__debugPixi.layerManager.readAsync(id, [rect]);
    let best = null;
    let closest = null;
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3];
      const straight = (v) => a ? Math.min(255, Math.round(v * 255 / a)) : 0;
      const [r, g, b] = [straight(pixels[i]), straight(pixels[i + 1]), straight(pixels[i + 2])];
      const margin = Math.min(a - 64, b - r - 61, b - g - 61);
      const candidate = { offset: i / 4, rgba: [r, g, b, a], margin };
      if (a >= 64 && b > r + 60 && b > g + 60 && (!best || a > best.rgba[3])) best = candidate;
      if (!closest || margin > closest.margin) closest = candidate;
    }
    return { best, closest };
  }, { id, rect }), ({ best }) => Boolean(best));
  const pointOf = ({ offset }) => [rect.x + offset % rect.w, rect.y + Math.floor(offset / rect.w)];
  if (!best) {
    const sample = closest ?? { offset: 0, rgba: 'unavailable' };
    assert.fail(pixelDetails('Blue brush stroke (10 s timeout)', pointOf(sample), sample.rgba,
      '[R, G, B, A] with A ≥ 64, B > R + 60 and B > G + 60'));
  }
  return pointOf(best);
}

async function waitForCommittedHue(page, layerId, hue) {
  const actual = await poll(() => page.evaluate((id) => window.__debugPixi.layerManager
    .getLayerItem(id)?.model.meta?.adjustment?.params?.hue, layerId), (value) => value === hue);
  assert.equal(actual, hue, 'Committed HSL hue within 10 s');
}

function adjusted(compiled, rgba) {
  return [...applyCompiledAdjustmentRgb(compiled, rgba[0], rgba[1], rgba[2]), rgba[3]];
}

function compile(kind, params) {
  return compileAdjustment(normalizeAdjustment({ kind, params }));
}

async function compareExportPng(page, dims) {
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    const images = new Map();
    URL.createObjectURL = function (blob) {
      const url = original.call(URL, blob);
      if (blob.type === 'image/png') images.set(url, blob);
      return url;
    };
    const onDownload = (event) => {
      const anchor = event.target.closest?.('a[download]');
      if (anchor?.download.endsWith('.png') && images.has(anchor.href)) {
        event.preventDefault();
        window.__phase6Png = images.get(anchor.href);
      }
    };
    document.addEventListener('click', onDownload, true);
    window.__phase6RestoreDownload = () => {
      document.removeEventListener('click', onDownload, true);
      URL.createObjectURL = original;
      delete window.__phase6Png;
      delete window.__phase6RestoreDownload;
    };
  });
  try {
    await page.getByTitle('File', { exact: true }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name: /Export \(PNG\/PSD\/ORA\)/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Multi-Layer Artwork Export', exact: true });
    await dialog.getByRole('radio', { name: /^Flattened PNG \(with background\)/ }).click();
    await dialog.getByRole('button', { name: 'Download Now', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__phase6Png), undefined,
      { polling: pollInterval, timeout: checkTimeout });
    const stats = await page.evaluate(async ({ width, height, tolerance }) => {
      const bitmap = await createImageBitmap(window.__phase6Png);
      if (bitmap.width !== width || bitmap.height !== height) {
        const size = `${bitmap.width}x${bitmap.height}`;
        bitmap.close();
        throw new Error(`Exported PNG has unexpected dimensions ${size}`);
      }
      const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = ctx.getImageData(0, 0, width, height).data;
      const live = await window.__debugPixi.layerManager.readVisibleCompositeAsync(true);
      if (live.length !== png.length) throw new Error('Live composite byte count differs from PNG');
      let max = -1;
      let worst = 0;
      let sum = 0;
      let withinTolerance = 0;
      const straight = (value, alpha) => alpha ? Math.min(255, Math.round(value * 255 / alpha)) : 0;
      for (let i = 0; i < png.length; i += 4) {
        const a = live[i + 3];
        let pixelMax = Math.abs(a - png[i + 3]);
        sum += pixelMax;
        for (let c = 0; c < 3; c++) {
          const diff = Math.abs(straight(live[i + c], a) - png[i + c]);
          sum += diff;
          pixelMax = Math.max(pixelMax, diff);
        }
        if (pixelMax > max) {
          max = pixelMax;
          worst = i;
        }
        if (pixelMax <= tolerance) withinTolerance++;
      }
      const pixel = worst / 4;
      const alpha = live[worst + 3];
      return {
        max, mean: sum / png.length, fraction: withinTolerance / (width * height),
        point: [pixel % width, Math.floor(pixel / width)],
        actual: Array.from(png.subarray(worst, worst + 4)),
        expected: [...Array.from(live.subarray(worst, worst + 3), (v) => straight(v, alpha)), alpha],
      };
    }, { ...dims, tolerance });
    const summary = `max ${stats.max}, mean ${stats.mean.toFixed(3)}, ${(stats.fraction * 100).toFixed(3)}% of pixels within ±${tolerance}`;
    assert.ok(stats.fraction >= 0.999 && stats.mean <= 1,
      pixelDetails(`PNG parity (${summary}), worst pixel`, stats.point, stats.actual, `[${stats.expected}]`));
    passed(`PNG export matches the live composite (${summary})`);
  } finally {
    await page.evaluate(() => window.__phase6RestoreDownload?.());
  }
}

async function runSoloVerification(tempRoot, apps) {
  const { page, pageErrors } = await launchIsolated(tempRoot, apps, 'solo');
  await enterOfflineCanvas(page);
  const dims = await getCanvasDims(page);
  assert.deepEqual(dims, { width: 768, height: 640 }, 'Offline canvas dimensions');
  const baseId = await page.evaluate(() => window.__debugPixi.layerManager.getLayers()
    .map(({ model }) => model)
    .filter((model) => model.layerType === 'raster')
    .sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id);
  assert.ok(baseId, 'Missing bottom raster layer');
  await row(page, baseId).click();

  const red = [255, 0, 0, 255];
  const grey = [96, 96, 96, 255];
  const blue = [0, 0, 255, 255];
  const redRect = { x: 284, y: 80, w: 200, h: 200 };
  const greyRect = { x: 520, y: 80, w: 200, h: 200 };
  const redLeft = [330, 180];
  const redRight = [430, 180];
  const greyPoint = [620, 180];
  const paper = [80, 80];
  const probes = [redLeft, redRight, greyPoint, paper];
  await seedRegion(page, baseId, redRect, red);
  await seedRegion(page, baseId, greyRect, grey);
  const [, , , baselinePaper] = await waitForCompositePixels(page, [
    [redLeft, red, 'Solo baseline, left red'],
    [redRight, red, 'Solo baseline, right red'],
    [greyPoint, grey, 'Solo baseline, grey'],
    [paper, [255, 255, 255, 255], 'Solo baseline, paper'],
  ]);
  const baseRect = { x: 0, y: 0, w: dims.width, h: dims.height };
  const beforePreview = await snapshotLayer(page, baseId, baseRect);
  passed('Seeded and verified the solo canvas baseline');

  const plus120 = compile('hsl', { hue: 120 });
  const minus60 = compile('hsl', { hue: -60 });
  let hslId;
  try {
    hslId = await createAdjustment(page, 'hsl');
    await adjustmentParam(page, 'hue').fill('120');
    await waitForCompositePixels(page, [[redLeft, adjusted(plus120, red), 'HSL live preview']]);
    await assertLayerUnchanged(page, baseId, baseRect, beforePreview, 'HSL preview changed base layer bytes');
    await commitAdjustment(page);
    await waitForCommittedHue(page, hslId, 120);
  } finally {
    await beforePreview.dispose();
  }
  passed('HSL preview changed red to green before OK and preserved the base bytes');

  await row(page, baseId).click();
  await setBrushColorAndSize(page, '#0000FF');
  await drawPathOnCanvas(page, [[185, 370], [200, 370], [215, 370], [230, 370], [245, 370]]);
  const strokeRect = { x: 204, y: 364, w: 23, h: 13 };
  const strokePoint = await waitForBlueStroke(page, baseId, strokeRect);
  const beforeStrokePreview = await snapshotLayer(page, baseId, baseRect);
  try {
    let unadjusted;
    try {
      await page.evaluate((id) => window.__debugPixi.layerManager.setAdjustmentPreview(id, {
        kind: 'hsl', params: { hue: 0, saturation: 0, lightness: 0, colorize: false },
      }), hslId);
      [unadjusted] = await readCompositePixels(page, [strokePoint]);
    } finally {
      await page.evaluate((id) => window.__debugPixi.layerManager.setAdjustmentPreview(id, null), hslId);
    }
    const [actual] = await readCompositePixels(page, [strokePoint]);
    assertPixel(actual, adjusted(plus120, unadjusted), strokePoint, 'Adjusted brush pixel');
    await assertLayerUnchanged(page, baseId, baseRect, beforeStrokePreview, 'HSL changed the painted base layer bytes');
  } finally {
    await beforeStrokePreview.dispose();
  }
  passed('A brush stroke stored blue on the base layer and displayed its adjusted colour');

  await page.getByTestId(`adjustment-icon-${hslId}`).dblclick();
  await adjustmentDialog(page).waitFor({ timeout: checkTimeout });
  assert.equal(await adjustmentParam(page, 'hue').inputValue(), '120', 'Reopened HSL hue');
  await adjustmentParam(page, 'hue').fill('-60');
  await commitAdjustment(page);
  await waitForCommittedHue(page, hslId, -60);
  await waitForCompositePixels(page, [[redLeft, adjusted(minus60, red), 'Committed hue -60']]);
  await runShortcut(page, 'Control+KeyZ');
  await waitForCompositePixels(page, [[redLeft, adjusted(plus120, red), 'Undo hue edit']]);
  await runShortcut(page, 'Control+KeyY');
  await waitForCompositePixels(page, [[redLeft, adjusted(minus60, red), 'Redo hue edit']]);
  passed('Reopened HSL, edited hue, and verified single-step undo and redo');

  await row(page, baseId).click();
  const curvesId = await createAdjustment(page, 'curves');
  await adjustmentDialog(page).getByTestId('adjustment-curve-preset-invert').click();
  await commitAdjustment(page);
  const clip = page.getByRole('button', { name: 'Clip to Layer Below', exact: true });
  assert.equal(await clip.getAttribute('aria-pressed'), 'false', 'Initial curves clip state');
  await clip.click();
  await page.getByRole('button', { name: 'Clip to Layer Below', exact: true, pressed: true })
    .waitFor({ timeout: checkTimeout });
  const invert = compile('curves', { master: [{ x: 0, y: 255 }, { x: 255, y: 0 }] });
  const invertedRed = adjusted(minus60, adjusted(invert, red));
  const invertedGrey = adjusted(minus60, adjusted(invert, grey));
  await waitForCompositePixels(page, [
    [redLeft, invertedRed, 'Clipped curves over red'],
    [greyPoint, invertedGrey, 'Clipped curves over grey'],
    [paper, baselinePaper, 'Paper outside the clip base'],
  ]);
  passed('Clipped curves inverted raster content and preserved the paper colour');

  await row(page, curvesId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add Layer Mask', exact: true }).click();
  const maskHandle = await page.waitForFunction((ownerId) => window.__debugPixi.layerManager.getLayers()
    .find(({ model }) => model.layerType === 'mask' && model.parentId === ownerId)?.model.id, curvesId,
  { polling: pollInterval, timeout: checkTimeout });
  const maskId = await maskHandle.jsonValue();
  await maskHandle.dispose();
  const white = [255, 255, 255, 255];
  const maskPixel = await poll(() => page.evaluate(async ({ id, point }) => {
    const [x, y] = point;
    const [pixels] = await window.__debugPixi.layerManager.readAsync(id, [{ x, y, w: 1, h: 1 }]);
    return Array.from(pixels);
  }, { id: maskId, point: redLeft }), (pixel) => maxDiff(pixel, white) === 0);
  assert.ok(maxDiff(maskPixel, white) === 0, pixelDetails('Initial mask (10 s timeout)', redLeft, maskPixel, `[${white}]`));
  await seedRegion(page, maskId, { x: 0, y: 0, w: dims.width / 2, h: dims.height }, [0, 0, 0, 255]);
  await waitForCompositePixels(page, [
    [redLeft, adjusted(minus60, red), 'Black half of adjustment mask'],
    [redRight, invertedRed, 'White half of adjustment mask'],
  ]);
  passed('The adjustment mask limited curves to the white half');

  await row(page, hslId).click();
  await page.getByRole('button', { name: 'New Layer Folder', exact: true }).click();
  const groupId = await page.locator('[data-layer-id][aria-selected="true"][data-is-group="true"]')
    .getAttribute('data-layer-id', { timeout: checkTimeout });
  await page.getByRole('button', { name: 'New Raster Layer', exact: true }).click();
  const groupRasterId = await page.locator('[data-layer-id][aria-selected="true"][data-is-group="false"]')
    .getAttribute('data-layer-id', { timeout: checkTimeout });
  const blueRect = { x: 500, y: 380, w: 180, h: 160 };
  const bluePoint = [590, 460];
  await seedRegion(page, groupRasterId, blueRect, blue);
  await waitForCompositePixels(page, [[bluePoint, blue, 'Group raster baseline']]);
  const outsideGroup = await readCompositePixels(page, probes);
  const brightnessId = await createAdjustment(page, 'brightness_contrast');
  const parents = await poll(() => page.evaluate((ids) => ids.map((id) => window.__debugPixi.layerManager
    .getLayerItem(id)?.model.parentId), [groupRasterId, brightnessId]), (ids) => ids.every((id) => id === groupId));
  assert.deepEqual(parents, [groupId, groupId], 'Raster and brightness adjustment share the new group');
  await adjustmentParam(page, 'brightness').fill('90');
  await commitAdjustment(page);
  await waitForCompositePixels(page, [
    [bluePoint, adjusted(compile('brightness_contrast', { brightness: 90 }), blue), 'Group brightness on blue'],
    ...probes.map((point, i) => [point, outsideGroup[i], 'Outside group']),
  ]);
  passed('Group brightness changed the blue raster and preserved the outer red, grey, and paper');

  await compareExportPng(page, dims);
  assert.equal(pageErrors.length, 0, `Solo page error: ${pageErrors[0]}`);
  passed('Solo renderer reported zero page errors');
}

async function postJson(url, route, body, token) {
  const response = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function seedRemoteBlock(url, token, canvas, layerId, block) {
  const tiles = [];
  const size = DEFAULT_TILE_SIZE;
  for (let row = Math.floor(block.y / size); row * size < block.y + block.h; row++) {
    for (let col = Math.floor(block.x / size); col * size < block.x + block.w; col++) {
      const { x, y, width, height } = getTileBounds(col, row, size, canvas.width, canvas.height);
      const data = Buffer.alloc(width * height * 4);
      for (let py = Math.max(y, block.y); py < Math.min(y + height, block.y + block.h); py++) {
        for (let px = Math.max(x, block.x); px < Math.min(x + width, block.x + block.w); px++) {
          const i = ((py - y) * width + px - x) * 4;
          data[i] = data[i + 3] = 255;
        }
      }
      tiles.push({ col, row, width, height, compression: 'raw', data: data.toString('base64') });
    }
  }
  for (let i = 0; i < tiles.length; i += 3) {
    await postJson(url, `/api/canvases/${canvas.id}/layers/${layerId}/tiles`, { tiles: tiles.slice(i, i + 3) }, token);
  }
}

async function runMultiplayerTwoClientVerification(tempRoot, apps, url) {
  const register = (artist) => postJson(url, '/api/auth/register', {
    username: `phase6_artist_${artist.toLowerCase()}`, password: 'Password123!', displayName: `Artist ${artist}`,
  });
  const authA = await register('A');
  const authB = await register('B');
  const { canvas, layers } = await postJson(url, '/api/canvases', {
    title: 'Phase 6 Adjustment Smoke', width: 320, height: 272,
  }, authA.token);
  const base = layers.find((layer) => layer.layerType === 'raster' && !layer.isLocked && layer.ownerId === authA.user.id);
  assert.ok(base, 'Missing Artist A raster layer');
  await postJson(url, '/api/canvases/join', { canvasId: canvas.id }, authB.token);
  await seedRemoteBlock(url, authA.token, canvas, base.id, { x: 230, y: 225, w: 64, h: 40 });

  const a = await loginAndOpenMpWindow(tempRoot, apps, 'a', url, authA, canvas.id);
  const b = await loginAndOpenMpWindow(tempRoot, apps, 'b', url, authB, canvas.id);
  const red = [255, 0, 0, 255];
  const point = [270, 260];
  await waitForCompositePixels(a.page, [[point, red, 'Artist A seeded raster']], base.id);
  await waitForCompositePixels(b.page, [[point, red, 'Artist B seeded raster']], base.id);
  passed('Both clients loaded the REST-seeded raster from the isolated canvas');

  const hue120 = adjusted(compile('hsl', { hue: 120 }), red);
  const hueMinus60 = adjusted(compile('hsl', { hue: -60 }), red);
  await row(a.page, base.id).click();
  const hslId = await createAdjustment(a.page, 'hsl');
  await adjustmentParam(a.page, 'hue').fill('120');
  await commitAdjustment(a.page);
  await waitForCompositePixels(b.page, [[point, hue120, 'Artist B adjustment creation']], hslId);
  passed('Artist B received the new HSL layer and hue 120');

  await row(a.page, hslId).click({ button: 'right' });
  await a.page.getByTestId('layer-menu-edit-adjustment').click();
  await adjustmentDialog(a.page).waitFor({ timeout: checkTimeout });
  assert.equal(await adjustmentParam(a.page, 'hue').inputValue(), '120', 'Artist A committed hue');
  await adjustmentParam(a.page, 'hue').fill('-60');
  await commitAdjustment(a.page);
  await waitForCompositePixels(b.page, [[point, hueMinus60, 'Artist B adjustment edit']], hslId);
  passed('Artist B received the edit to hue -60');

  await runShortcut(a.page, 'Control+KeyZ');
  await waitForCompositePixels(b.page, [[point, hue120, 'Artist B adjustment undo']], hslId);
  passed('Artist B returned to hue 120 after Artist A undid the edit');
  for (const [artist, errors] of [['A', a.pageErrors], ['B', b.pageErrors]]) {
    assert.equal(errors.length, 0, `Artist ${artist} page error: ${errors[0]}`);
  }
  passed('Both multiplayer renderers reported zero page errors');
}

async function closeApps(apps) {
  const results = await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase6-'));
  const apps = [];
  let server;
  try {
    await runSoloVerification(tempRoot, apps);
    await closeApps(apps);
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'server-data-'));
    server = await startTempServer(dataDir);
    await runMultiplayerTwoClientVerification(tempRoot, apps, server.url);
  } finally {
    try {
      await closeApps(apps);
    } finally {
      try {
        await stopTempServer(server?.proc);
      } finally {
        try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
      }
    }
  }
  console.log('PHASE6 SMOKE PASSED');
}

main().catch((error) => {
  console.error(`PHASE6 SMOKE FAILED: ${String(error.message || error).split(/\r?\n/)[0]}`);
  process.exit(1);
});

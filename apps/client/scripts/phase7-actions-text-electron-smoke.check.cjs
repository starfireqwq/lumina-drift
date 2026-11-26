/**
 * Phase 7 Electron smoke check for auto actions and editable rich text.
 * From the repo root:
 *   pnpm --filter @atelier/shared build
 *   pnpm --filter @atelier/client build:electron
 *   node apps/client/scripts/phase7-actions-text-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { isDeepStrictEqual } = require('node:util');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const checkTimeout = 10_000;
const undo = 'Control+KeyZ';
const redo = 'Control+KeyY';
const passed = (message) => console.log('✓ ' + message);

async function withinCheckTime(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out after 10 s')), checkTimeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function poll(read, matches, label) {
  return withinCheckTime((async () => {
    const deadline = Date.now() + checkTimeout;
    let observed = await read();
    while (!matches(observed)) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, label + ' timed out after 10 s');
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
      observed = await read();
    }
    return observed;
  })(), label);
}

function waitForExit(proc, timeout) {
  if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve(true);
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

async function stopOwnedProcess(proc) {
  if (!proc?.pid || proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGTERM');
  if (await waitForExit(proc, 2000)) return;
  const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true,
  });
  killer.on('error', () => {});
  assert.ok(await waitForExit(proc, 5000), 'Isolated process did not exit after cleanup');
}

async function startTempServer(dataDir) {
  const appModuleUrl = pathToFileURL(path.join(serverRoot, 'src/app.ts')).href;
  const tsxImportUrl = pathToFileURL(requireServer.resolve('tsx')).href;
  const launcherPath = path.join(dataDir, 'launch-temp-server.mjs');
  fs.writeFileSync(launcherPath, [
    'import { buildApp } from ' + JSON.stringify(appModuleUrl) + ';',
    'const app = await buildApp();',
    'const addr = await app.listen({ port: 0, host: "127.0.0.1" });',
    'if (new URL(addr).port === "3000") throw new Error("Reserved server port");',
    'console.log("TEST_SERVER_READY=" + addr);',
    'process.on("SIGTERM", async () => { await app.close(); process.exit(0); });',
  ].join('\n'), 'utf8');
  const proc = spawn(process.execPath, ['--import', tsxImportUrl, launcherPath], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATABASE_PATH: path.join(dataDir, 'phase7-smoke.db'),
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
    const ready = new Promise((resolve, reject) => {
      let stderr = '';
      let stdout = '';
      proc.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-4096);
        const match = stdout.match(/TEST_SERVER_READY=(http:\/\/127\.0\.0\.1:\d+)\r?\n/);
        if (match) resolve(match[1]);
      });
      proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-400); });
      proc.once('error', reject);
      proc.once('exit', (code) => reject(new Error('Temp server exited (' + code + '): ' + stderr.trim())));
    });
    const url = await withinCheckTime(ready, 'Temp server startup');
    return { proc, url };
  } catch (error) {
    await stopOwnedProcess(proc);
    throw error;
  }
}

function isolatedLauncher(userDataDir, appData) {
  const { app, session } = require('electron');
  const childProcess = require('node:child_process');
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  app.setPath('appData', appData);
  app.setPath('userData', userDataDir);
  app.setPath('sessionData', userDataDir);

  // Block the startup probe, renderer requests, and embedded server launch on the reserved port.
  const get = http.get;
  http.get = function (url, ...args) {
    const port = typeof url === 'string' || url instanceof URL ? new URL(url).port : url?.port;
    if (String(port) === '3000') {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = () => request;
      process.nextTick(() => request.emit('error', new Error('Reserved server port')));
      return request;
    }
    return get.call(this, url, ...args);
  };
  const fork = childProcess.fork;
  childProcess.fork = function (file, args, options) {
    const opts = Array.isArray(args) ? options : args ?? options;
    if (String(opts?.env?.PORT) === '3000') {
      throw new Error('Reserved server port');
    }
    return fork.apply(this, arguments);
  };
  require('node:module').syncBuiltinESMExports();
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).port === '3000' });
    });
  });
}

async function launchIsolated(tempRoot, apps, label, userDataDir = fs.mkdtempSync(path.join(tempRoot, 'electron-' + label + '-'))) {
  assert.ok(fs.existsSync(electronExe), 'Missing Electron executable');
  assert.ok(fs.existsSync(mainJs), 'Missing compiled Electron main');
  assert.ok(fs.existsSync(path.join(clientRoot, 'dist/index.html')), 'Missing compiled renderer');
  assert.equal(path.dirname(path.resolve(userDataDir)), tempRoot, 'Electron profile must be inside the smoke directory');
  const appData = path.join(userDataDir, 'app-data');
  const localAppData = path.join(userDataDir, 'local-app-data');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const launcherPath = path.join(userDataDir, 'phase7-launcher.cjs');
  fs.writeFileSync(launcherPath, [
    '(' + isolatedLauncher.toString() + ')(' + JSON.stringify(userDataDir) + ', ' + JSON.stringify(appData) + ');',
    'require(' + JSON.stringify(mainJs) + ');',
  ].join('\n'), 'utf8');
  const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData, PORT: '0' };
  delete env.VITE_DEV_SERVER_URL;
  const { _electron: electron } = requireServer('playwright-core');
  const app = await electron.launch({
    executablePath: electronExe,
    args: [launcherPath, '--user-data-dir=' + userDataDir],
    env,
    timeout: checkTimeout,
  });
  apps.push(app);
  const pageErrors = [];
  app.context().on('weberror', (event) => pageErrors.push(event.error().message));
  const page = await app.firstWindow({ timeout: checkTimeout });
  page.setDefaultTimeout(checkTimeout);
  page.setDefaultNavigationTimeout(checkTimeout);
  await withinCheckTime(page.setViewportSize({ width: 1440, height: 900 }), 'Setting the viewport size');
  await page.waitForLoadState('domcontentloaded');
  return { app, page, pageErrors, userDataDir };
}

async function closeApps(apps) {
  const results = await Promise.allSettled(apps.splice(0).map(async (app) => {
    try {
      await withinCheckTime(app.close(), 'Closing isolated Electron');
    } catch (error) {
      await stopOwnedProcess(app.process());
      throw error;
    }
  }));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function waitForCanvas(page, width, height) {
  await page.locator('[data-canvas-presented="true"]').waitFor();
  await page.waitForFunction(({ width, height }) => {
    const debug = window.__debugPixi;
    return debug?.layerManager && debug.autoActions && debug.tileEngine?.canvasWidth === width
      && debug.tileEngine.canvasHeight === height;
  }, { width, height });
}

async function enterOfflineCanvas(page) {
  await withinCheckTime(page.evaluate(() => localStorage.setItem('atelier_language', 'en-US')), 'Setting the UI language');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
  await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
  await page.getByRole('spinbutton', { name: /^Width/ }).fill('768');
  await page.getByRole('spinbutton', { name: /^Height/ }).fill('640');
  await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
  await waitForCanvas(page, 768, 640);
}

async function loginAndOpenMpWindow(tempRoot, apps, label, serverUrl, auth, canvas) {
  const launched = await launchIsolated(tempRoot, apps, label);
  const { page } = launched;
  await withinCheckTime(page.evaluate(({ url, token, user, id }) => {
    localStorage.setItem('atelier_language', 'en-US');
    localStorage.setItem('atelier_server_url', url);
    localStorage.setItem('atelier_gateway_resolved', 'true');
    localStorage.setItem('atelier_gateway_skip_on_launch', 'true');
    localStorage.setItem('atelier_active_canvas_id', id);
    localStorage.setItem('atelier_token:' + url, token);
    localStorage.setItem('atelier_token', token);
    localStorage.setItem('atelier_user', JSON.stringify(user));
  }, { url: serverUrl, ...auth, id: canvas.id }), 'Setting isolated canvas credentials');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForCanvas(page, canvas.width, canvas.height);
  return launched;
}

const row = (page, id) => page.locator('[data-layer-id=' + JSON.stringify(id) + ']');
const filterWindow = (page) => page.locator('[data-tool-window="layer-filter"]');
const textarea = (page) => page.getByRole('textbox', { name: 'Text layer editor', exact: true });
const actionRow = (page, name) => page.getByTestId('auto-action-row').filter({ has: page.getByText(name, { exact: true }) });
const builtinRow = (page, key) => page.locator('[data-testid="auto-action-row"][data-builtin-key=' + JSON.stringify(key) + ']');

async function runShortcut(page, shortcut) {
  await page.locator('[aria-modal="true"]:visible').waitFor({ state: 'hidden' });
  await filterWindow(page).waitFor({ state: 'hidden' });
  await withinCheckTime(page.evaluate(() => document.activeElement?.blur()), 'Clearing shortcut focus');
  await page.keyboard.press(shortcut);
}

async function seedRegion(page, id, rect, rgba) {
  await poll(() => page.evaluate(({ id, rect, rgba }) => {
    const { layerManager } = window.__debugPixi;
    if (!layerManager.getLayerItem(id)) return false;
    const { x, y, w, h } = rect;
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
    layerManager.writeRegion(id, x, y, w, h, pixels);
    layerManager.syncPingPong(id);
    return true;
  }, { id, rect, rgba }), Boolean, 'Seeding raster layer ' + id);
}

function readLayers(page) {
  return page.evaluate(() => window.__debugPixi.layerManager.getLayers()
    .map(({ model }) => model).sort((a, b) => a.sortOrder - b.sortOrder));
}

function layerProperties(layers) {
  // Creation can renumber sort keys. Array order checks the actual stack position.
  return layers.map(({ createdAt, updatedAt, sortOrder, ...props }) => props);
}

async function expectLayers(page, expected, label) {
  return poll(async () => layerProperties(await readLayers(page)),
    (layers) => isDeepStrictEqual(layers, expected), label);
}

function pixelSnapshot(page, layerId) {
  return withinCheckTime(page.evaluate(async (id) => {
    const { layerManager, tileEngine } = window.__debugPixi;
    const rect = { x: 0, y: 0, w: tileEngine.canvasWidth, h: tileEngine.canvasHeight };
    const pixels = id ? (await layerManager.readAsync(id, [rect]))[0] : await layerManager.readVisibleCompositeAsync();
    let binary = '';
    for (let start = 0; start < pixels.length; start += 8192) {
      binary += String.fromCharCode(...pixels.subarray(start, start + 8192));
    }
    return btoa(binary);
  }, layerId), 'Reading full pixel snapshot');
}

function readCompositePixels(page, points) {
  return page.evaluate(async (points) => {
    const { layerManager, tileEngine } = window.__debugPixi;
    const pixels = await layerManager.readVisibleCompositeAsync();
    return points.map(([x, y]) => {
      const offset = (y * tileEngine.canvasWidth + x) * 4;
      return Array.from(pixels.subarray(offset, offset + 4));
    });
  }, points);
}

async function expectHalo(page, layerId, block) {
  const rect = { x: block.x - 4, y: block.y + 8, w: 4, h: block.h - 16 };
  await poll(() => page.evaluate(async ({ layerId, rect }) => {
    const [pixels] = await window.__debugPixi.layerManager.readAsync(layerId, [rect]);
    return pixels.some((value, i) => i % 4 === 3 && value > 0 && value < 255);
  }, { layerId, rect }), Boolean, 'Reading a semitransparent halo outside the original raster');
}

async function openAutoActions(page) {
  await page.getByRole('button', { name: 'Window', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Auto Actions', exact: true }).click();
  await page.getByTestId('auto-actions-panel').waitFor();
}

async function playAction(page, action) {
  await action.getByTestId('auto-action-play').click();
  const status = page.getByTestId('auto-actions-status');
  await status.and(page.locator('[data-status="done"], [data-status="failed"]')).waitFor();
  assert.equal(await status.getAttribute('data-status'), 'done', await status.innerText());
}

async function expectAddedLayer(page, before, anchorId, props, label) {
  const knownIds = new Set(before.map(({ id }) => id));
  const layers = await poll(() => readLayers(page), (models) => {
    if (models.length !== before.length + 1) return false;
    const anchorIndex = models.findIndex(({ id }) => id === anchorId);
    const newLayer = anchorIndex < 0 ? undefined : models[anchorIndex + 1];
    return newLayer && !knownIds.has(newLayer.id)
      && Object.entries(props).every(([key, value]) => newLayer[key] === value);
  }, label);
  const added = layers.find(({ id }) => !knownIds.has(id));
  assert.deepEqual(layerProperties(layers.filter(({ id }) => knownIds.has(id))), layerProperties(before), label);
  return added;
}

async function expectSelected(page, id) {
  await row(page, id).and(page.locator('[aria-selected="true"]')).waitFor();
}

async function storedActionSteps(page, name) {
  return withinCheckTime(page.evaluate((name) => {
    const actions = JSON.parse(localStorage.getItem('atelier_auto_actions_v1') ?? '[]');
    return actions.find((action) => action.name === name)?.steps.map(({ kind, params, enabled }) => ({ kind, params, enabled }));
  }, name), 'Reading saved action ' + name);
}

async function recordGlow(page, layerId) {
  await openAutoActions(page);
  await page.getByTestId('auto-actions-record').click();
  await row(page, layerId).click();
  await expectSelected(page, layerId);
  const before = await withinCheckTime(readLayers(page), 'Reading layers before recording');
  await runShortcut(page, 'Control+KeyJ');
  const duplicate = await expectAddedLayer(page, before, layerId, { layerType: 'raster' }, 'Duplicating the recording target');
  await expectSelected(page, duplicate.id);
  await poll(() => page.evaluate(() => window.__debugPixi.autoActions.recorder.getSnapshot().steps.map(({ kind }) => kind)),
    (kinds) => isDeepStrictEqual(kinds, ['layer.duplicate']), 'Recording the duplication before applying the filter');

  await page.getByRole('button', { name: 'Layer Filters', exact: true }).click();
  const filters = filterWindow(page);
  await filters.getByRole('button', { name: 'Blur', exact: true }).click();
  await filters.locator('button.atelier-filter-item')
    .and(filters.getByRole('button', { name: 'Gaussian Blur', exact: true })).click();
  await filters.getByRole('spinbutton', { name: 'Radius (px)', exact: true }).fill('10');
  await filters.getByRole('button', { name: 'Apply', exact: true }).click();
  await filters.waitFor({ state: 'hidden' });

  await page.locator('#layer-blend').selectOption('screen');
  const opacity = page.getByRole('slider', { name: 'Layer opacity', exact: true });
  for (let i = 0; i < 6; i++) await opacity.press('PageDown');
  assert.equal(await opacity.getAttribute('aria-valuenow'), '40', 'Recording opacity slider');
  await page.getByTestId('auto-actions-stop').click();
  await page.getByTestId('auto-actions-name-input').fill('Glow Test');
  await page.getByTestId('auto-actions-name-save').click();
  await actionRow(page, 'Glow Test').waitFor();

  assert.deepEqual(await storedActionSteps(page, 'Glow Test'), [
    { kind: 'layer.duplicate', params: {}, enabled: true },
    { kind: 'filter.apply', params: { filterId: 'gaussian', values: { radius: 10 } }, enabled: true },
    { kind: 'layer.set_blend', params: { blendMode: 'screen' }, enabled: true },
    { kind: 'layer.set_opacity', params: { opacity: 0.4 }, enabled: true },
  ], 'Recorded Glow Test steps');
  passed('Solo recorded and saved exactly four Glow Test steps');
}

async function verifyGlowUndoRedo(page, layerId, block) {
  await row(page, layerId).click();
  await expectSelected(page, layerId);
  const before = await withinCheckTime(readLayers(page), 'Reading layers before playback');
  const sourcePixels = await pixelSnapshot(page, layerId);
  const glowProps = { layerType: 'raster', blendMode: 'screen', opacity: 0.4 };
  const verifyGlow = async (label) => {
    const layer = await expectAddedLayer(page, before, layerId, glowProps, label);
    await expectSelected(page, layer.id);
    await expectHalo(page, layer.id, block);
    assert.ok(await pixelSnapshot(page, layerId) === sourcePixels, label + ' changed the source raster');
    return layer;
  };
  const verifyUndone = async () => {
    await expectLayers(page, layerProperties(before), 'Restoring the layer stack with one undo');
    assert.ok(await pixelSnapshot(page, layerId) === sourcePixels, 'Undo changed the source raster');
  };

  await playAction(page, actionRow(page, 'Glow Test'));
  const glow = await verifyGlow('Playing Glow Test on the second raster');
  const glowPixels = await pixelSnapshot(page, glow.id);
  passed('Solo playback inserted and selected a Screen 40% layer with a blur halo');

  await runShortcut(page, undo);
  await verifyUndone();
  await runShortcut(page, redo);
  const restored = await verifyGlow('Restoring the complete action with one redo');
  assert.deepEqual(layerProperties([{ ...restored, id: glow.id }]), layerProperties([glow]),
    'Redo restored the glow layer properties');
  assert.ok(await pixelSnapshot(page, restored.id) === glowPixels, 'Redo changed the glow raster');
  await runShortcut(page, undo);
  await verifyUndone();
  passed('Solo undid, redid, and undid the full action with one shortcut each');
}

async function verifyShadowAndImport(page, layerId, tempRoot) {
  await row(page, layerId).click();
  await expectSelected(page, layerId);
  const before = await withinCheckTime(readLayers(page), 'Reading layers before Clipped Shadow');
  await playAction(page, builtinRow(page, 'shadowClip'));
  await expectAddedLayer(page, before, layerId, {
    layerType: 'raster', blendMode: 'multiply', opacity: 0.6, clipToBelow: true,
  }, 'Creating a clipped Multiply layer');
  await runShortcut(page, undo);
  await expectLayers(page, layerProperties(before), 'Undoing Clipped Shadow once');
  passed('Solo played the built-in Clipped Shadow and removed it with one undo');

  const importPath = path.join(tempRoot, 'import-test.lumina-action');
  fs.writeFileSync(importPath, JSON.stringify({
    format: 'lumina-action',
    version: 1,
    actions: [{
      name: 'Imported Opacity',
      steps: [
        { kind: 'layer.set_opacity', params: { opacity: 0.5 }, enabled: true },
        { kind: 'unknown.step', params: {}, enabled: true },
      ],
    }],
  }), 'utf8');
  await page.getByTestId('auto-actions-import-input').setInputFiles(importPath);
  const result = page.getByRole('dialog').filter({ hasText: 'Imported 1 actions and skipped 1 steps.' });
  await result.waitFor();
  await result.getByRole('button', { name: 'Close', exact: true }).click();
  await result.waitFor({ state: 'hidden' });
  await actionRow(page, 'Imported Opacity').waitFor();
  assert.deepEqual(await storedActionSteps(page, 'Imported Opacity'), [
    { kind: 'layer.set_opacity', params: { opacity: 0.5 }, enabled: true },
  ], 'Imported action steps');
  passed('Solo imported the valid step and reported one skipped step');
}

async function clickCanvasAt(page, x, y) {
  const point = await withinCheckTime(page.evaluate(({ x, y }) => {
    const { app, viewport } = window.__debugPixi;
    const point = viewport.canvasToScreen(x, y);
    const { left, top, right, bottom } = app.canvas.getBoundingClientRect();
    const clientX = left + point.x;
    const clientY = top + point.y;
    if (clientX < left || clientX >= right || clientY < top || clientY >= bottom) {
      throw new Error('Requested canvas point is outside the viewport');
    }
    return [clientX, clientY];
  }, { x, y }), 'Resolving canvas click coordinates');
  await page.mouse.click(...point);
  await textarea(page).waitFor();
}

async function selectText(page, start, end) {
  await textarea(page).evaluate((area, { start, end }) => {
    area.focus();
    area.setSelectionRange(start, end);
    area.dispatchEvent(new Event('select', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange'));
  }, { start, end });
}

async function expectSwatch(swatch, expected) {
  await poll(() => swatch.evaluate((button) => button.style.backgroundColor),
    (color) => color === expected, 'Checking selected text color ' + expected);
}

async function setTextColor(page, start, end, hex, swatchColor) {
  await selectText(page, start, end);
  const swatch = page.getByTestId('text-editor-color');
  await swatch.click();
  const picker = page.locator('[data-outline-color][role="dialog"]');
  await picker.locator('input[type="text"][aria-label="HEX Code"]').fill(hex);
  await expectSwatch(swatch, swatchColor);
  await swatch.click();
  await picker.waitFor({ state: 'hidden' });
}

async function setPaintOrder(page, order) {
  const button = page.getByTestId('text-editor-paint-order');
  await button.click();
  if (await button.getAttribute('data-value') !== order) await button.click();
  assert.equal(await button.getAttribute('data-value'), order, 'Text stroke paint order');
}

async function commitText(page) {
  await textarea(page).press('Control+Enter');
  await textarea(page).waitFor({ state: 'hidden' });
}

function assertRedRun(meta, start, end) {
  assert.ok(meta.runs?.some((run) => run.start === start && run.end === end && run.color?.toLowerCase() === '#ff0000'),
    'Missing red text run at ' + start + '–' + end + ': ' + JSON.stringify(meta.runs));
}

function readTextPixels(page, layerId, splitAt, composite) {
  return page.evaluate(async ({ layerId, splitAt, composite }) => {
    const { layerManager, tileEngine } = window.__debugPixi;
    const meta = layerManager.getLayerItem(layerId)?.model.meta?.text;
    if (!meta) return null;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = meta.fontSize + 'px ' + meta.fontFamily;
    const glyphs = Array.from(meta.content);
    const advance = (chars) => chars.reduce((sum, char) => sum + ctx.measureText(char).width, 0);
    const splitX = meta.x + advance(glyphs.slice(0, splitAt));
    const padding = 10;
    const rect = {
      x: Math.max(0, meta.x - padding),
      y: Math.max(0, meta.y - padding),
      w: Math.ceil(advance(glyphs)) + padding * 2,
      h: Math.ceil(meta.fontSize * meta.lineHeight) + padding * 2,
    };
    let rgba;
    if (composite) rgba = await layerManager.readVisibleCompositeAsync();
    else [rgba] = await layerManager.readAsync(layerId, [rect]);
    let red = 0;
    let black = 0;
    let white = 0;
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const i = 4 * (composite ? (rect.y + y) * tileEngine.canvasWidth + rect.x + x : y * rect.w + x);
        if (rgba[i + 3] < 220) continue;
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        if (rect.x + x >= splitX && r > 200 && g < 45 && b < 45) red++;
        if (rect.x + x < splitX && r < 45 && g < 45 && b < 45) black++;
        if (r > 200 && g > 200 && b > 200) white++;
      }
    }
    return { red, black, white };
  }, { layerId, splitAt, composite });
}

function readTextLayer(page, content, id) {
  return readLayers(page).then((layers) => layers.find((layer) =>
    layer.layerType === 'text' && layer.meta?.text?.content === content && (!id || layer.id === id)));
}

function waitForTextCommit(page, layerId, paintOrder) {
  return poll(() => page.evaluate(({ layerId, paintOrder }) => {
    const { undo } = window.__debugPixi;
    return undo.peekLatestForLayer(layerId)?.metaAfter?.text?.paintOrder === paintOrder;
  }, { layerId, paintOrder }), Boolean, 'Waiting for the text pixels and undo entry to commit');
}

async function verifySoloText(page) {
  const content = 'Hello 世界';
  const more = page.getByTestId('text-editor-more');
  await runShortcut(page, 'KeyT');
  await clickCanvasAt(page, 350, 170);
  await setTextColor(page, 0, 0, '#000000', 'rgb(0, 0, 0)');
  await textarea(page).fill(content);
  await setTextColor(page, 6, 8, '#ff0000', 'rgb(255, 0, 0)');
  await more.click();
  await page.getByTestId('text-editor-stroke-width').fill('6');
  await expectSwatch(page.getByTestId('text-editor-stroke-color'), 'rgb(255, 255, 255)');
  await setPaintOrder(page, 'stroke-behind');
  await more.click();
  await commitText(page);

  const layer = await poll(() => readTextLayer(page, content), Boolean, 'Creating the solo text layer');
  const meta = layer.meta.text;
  assertRedRun(meta, 6, 8);
  assert.equal(meta.strokeWidth, 6, 'Text stroke width');
  assert.equal(meta.strokeColor.toLowerCase(), '#ffffff', 'Text stroke color');
  assert.equal(meta.paintOrder, 'stroke-behind', 'Initial text paint order');
  await waitForTextCommit(page, layer.id, 'stroke-behind');
  const behind = await poll(() => readTextPixels(page, layer.id, 6, false),
    (pixels) => pixels?.red > 100 && pixels.black > 100 && pixels.white > 100, 'Checking black, red, and white text pixels');
  passed('Solo kept Hello black, colored 世界 red, and rendered the white outline');

  await clickCanvasAt(page, meta.x + 4, meta.y + 8);
  assert.equal(await textarea(page).inputValue(), content, 'Existing text editor contents');
  await more.click();
  await setPaintOrder(page, 'stroke-front');
  await more.click();
  await commitText(page);
  await waitForTextCommit(page, layer.id, 'stroke-front');
  await poll(() => readTextLayer(page, content, layer.id), (layer) => layer?.meta.text.paintOrder === 'stroke-front',
    'Saving stroke-front paint order');
  await poll(() => readTextPixels(page, layer.id, 6, false),
    (pixels) => pixels && pixels.red < behind.red * 0.8, 'Checking that stroke-front covers at least 20% of the red fill');

  await runShortcut(page, undo);
  await poll(() => readTextLayer(page, content, layer.id), (layer) => isDeepStrictEqual(layer?.meta.text, meta),
    'Undoing the paint-order change');
  await poll(() => readTextPixels(page, layer.id, 6, false),
    (pixels) => pixels && Math.abs(pixels.red - behind.red) <= behind.red * 0.02, 'Restoring red text pixels within 2%');
  passed('Solo stroke-front covered the red fill and undo restored the original red pixel count');
  return layer;
}

function expectNoPageErrors(errors, label) {
  assert.equal(errors.length, 0, label + ' page error: ' + errors[0]);
}

async function runSoloVerification(tempRoot, apps) {
  const initial = await launchIsolated(tempRoot, apps, 'solo');
  const { page, userDataDir } = initial;
  await enterOfflineCanvas(page);
  const first = await poll(() => readLayers(page), (layers) => layers.some((layer) =>
    layer.layerType === 'raster' && !layer.isLocked), 'Loading the first solo raster');
  const layerB = first.find((layer) => layer.layerType === 'raster' && !layer.isLocked);
  await row(page, layerB.id).click();
  await expectSelected(page, layerB.id);
  await page.getByRole('button', { name: 'New Raster Layer', exact: true }).click();
  const layerA = await expectAddedLayer(page, first, layerB.id, { layerType: 'raster' }, 'Adding a second solo raster');
  const blockA = { x: 130, y: 130, w: 64, h: 48 };
  const blockB = { x: 350, y: 360, w: 64, h: 48 };
  const red = [255, 0, 0, 255];
  const blue = [0, 0, 255, 255];
  await seedRegion(page, layerA.id, blockA, red);
  await seedRegion(page, layerB.id, blockB, blue);
  await poll(() => readCompositePixels(page, [[140, 140], [360, 370]]),
    (pixels) => isDeepStrictEqual(pixels, [red, blue]), 'Reading the two solo raster colors');
  passed('Solo seeded distinct red and blue raster layers in the 768 × 640 canvas');

  await recordGlow(page, layerA.id);
  await verifyGlowUndoRedo(page, layerB.id, blockB);
  await verifyShadowAndImport(page, layerA.id, tempRoot);
  const text = await verifySoloText(page);
  await closeApps(apps);
  expectNoPageErrors(initial.pageErrors, 'Solo');

  const reopened = await launchIsolated(tempRoot, apps, 'solo-reopen', userDataDir);
  const resumeCard = reopened.page.locator('[data-resume-card=' + JSON.stringify(text.canvasId) + ']');
  await resumeCard.getByRole('button', { name: /^Continue: / }).click();
  await waitForCanvas(reopened.page, 768, 640);
  const persisted = await poll(() => readTextLayer(reopened.page, text.meta.text.content, text.id), Boolean,
    'Finding the text layer in the same reopened canvas');
  assert.deepEqual(persisted.meta.text, text.meta.text, 'Persisted editable text metadata');
  await runShortcut(reopened.page, 'KeyT');
  await clickCanvasAt(reopened.page, persisted.meta.text.x + 4, persisted.meta.text.y + 8);
  assert.equal(await textarea(reopened.page).inputValue(), 'Hello 世界', 'Persisted editor contents');
  await selectText(reopened.page, 6, 8);
  await expectSwatch(reopened.page.getByTestId('text-editor-color'), 'rgb(255, 0, 0)');
  await textarea(reopened.page).press('Escape');
  await textarea(reopened.page).waitFor({ state: 'hidden' });
  passed('Solo reopened the same canvas and recovered the text, styles, and selected red swatch');
  await closeApps(apps);
  expectNoPageErrors(reopened.pageErrors, 'Reopened solo');
  passed('Both solo renderer sessions reported zero page errors');
}


async function postJson(url, route, body, token) {
  const response = await fetch(url + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(checkTimeout),
  });
  if (!response.ok) {
    throw new Error(route + ' returned ' + response.status + ': ' + (await response.text()).slice(0, 200));
  }
  return response.json();
}

async function seedRemoteBlock(url, token, canvas, layerId, block) {
  const { DEFAULT_TILE_SIZE: size, getTileBounds } = require('../../../packages/shared/dist/index.js');
  const tiles = [];
  for (let row = Math.floor(block.y / size); row * size < block.y + block.h; row++) {
    for (let col = Math.floor(block.x / size); col * size < block.x + block.w; col++) {
      const { x, y, width, height } = getTileBounds(col, row, size, canvas.width, canvas.height);
      const pixels = Buffer.alloc(width * height * 4);
      for (let py = Math.max(y, block.y); py < Math.min(y + height, block.y + block.h); py++) {
        for (let px = Math.max(x, block.x); px < Math.min(x + width, block.x + block.w); px++) {
          const offset = ((py - y) * width + px - x) * 4;
          pixels[offset] = pixels[offset + 3] = 255;
        }
      }
      tiles.push({ col, row, width, height, compression: 'raw', data: pixels.toString('base64') });
    }
  }
  for (let i = 0; i < tiles.length; i += 3) {
    await postJson(url, '/api/canvases/' + canvas.id + '/layers/' + layerId + '/tiles', { tiles: tiles.slice(i, i + 3) }, token);
  }
}

async function runMultiplayerTwoClientVerification(tempRoot, apps, url) {
  const register = (artist) => postJson(url, '/api/auth/register', {
    username: 'phase7_artist_' + artist.toLowerCase(), password: 'Password123!', displayName: 'Artist ' + artist,
  });
  const authA = await register('A');
  const authB = await register('B');
  const { canvas, layers } = await postJson(url, '/api/canvases', {
    title: 'Phase 7 Actions and Text Smoke', width: 512, height: 384,
  }, authA.token);
  const base = layers.find((layer) => layer.layerType === 'raster' && !layer.isLocked && layer.ownerId === authA.user.id);
  assert.ok(base, 'Missing Artist A raster layer');
  await postJson(url, '/api/canvases/join', { canvasId: canvas.id }, authB.token);
  const block = { x: 96, y: 240, w: 64, h: 48 };
  await seedRemoteBlock(url, authA.token, canvas, base.id, block);

  const a = await loginAndOpenMpWindow(tempRoot, apps, 'artist-a', url, authA, canvas);
  const b = await loginAndOpenMpWindow(tempRoot, apps, 'artist-b', url, authB, canvas);
  const aPage = a.page;
  const bPage = b.page;
  const samples = [[block.x + 16, block.y + 16], [block.x - 1, block.y + 24], [block.x - 3, block.y + 24]];
  const seed = [[255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]];
  await Promise.all([aPage, bPage].map((page) => poll(() => readCompositePixels(page, samples),
    (pixels) => isDeepStrictEqual(pixels, seed), 'Loading the REST-seeded red raster without a halo')));
  const beforeLayers = await withinCheckTime(readLayers(bPage), 'Reading the observer stack before playback');
  const beforePixels = await pixelSnapshot(bPage);
  passed('Both clients loaded the REST-seeded red layer in the isolated canvas');

  await openAutoActions(aPage);
  await row(aPage, base.id).click();
  await expectSelected(aPage, base.id);
  await playAction(aPage, builtinRow(aPage, 'softGlow'));
  const glow = await expectAddedLayer(bPage, beforeLayers, base.id, {
    layerType: 'raster', blendMode: 'screen', opacity: 0.4,
  }, 'Receiving Soft Glow on Artist B');
  await row(bPage, glow.id).waitFor();
  await poll(() => readCompositePixels(bPage, samples), ([center, ...halo]) =>
    isDeepStrictEqual(center, seed[0]) && halo.some(([r, g, b, alpha]) => r > 0 && g === 0 && b === 0 && alpha > 0 && alpha < 255),
  'Reading the Soft Glow halo on Artist B');
  passed('Artist B received the Screen 40% layer and a composite halo outside the source');

  await runShortcut(aPage, undo);
  await expectLayers(bPage, layerProperties(beforeLayers), 'Receiving the grouped undo on Artist B');
  await row(bPage, glow.id).waitFor({ state: 'hidden' });
  await poll(() => pixelSnapshot(bPage), (snapshot) => snapshot === beforePixels, 'Restoring Artist B’s exact pre-action composite');
  passed('Artist A undid the full action once and Artist B’s composite returned to its original pixels');

  await runShortcut(aPage, 'KeyT');
  await clickCanvasAt(aPage, 208, 105);
  await textarea(aPage).fill('AB');
  await setTextColor(aPage, 1, 2, '#ff0000', 'rgb(255, 0, 0)');
  await commitText(aPage);
  const textA = await poll(() => readTextLayer(aPage, 'AB'), Boolean, 'Creating Artist A’s text layer');
  assertRedRun(textA.meta.text, 1, 2);
  const textB = await poll(() => readTextLayer(bPage, 'AB', textA.id), Boolean, 'Receiving the text layer on Artist B');
  assert.deepEqual(textB.meta.text.runs, textA.meta.text.runs, 'Artist B’s text style runs');
  await poll(() => readTextPixels(bPage, textB.id, 1, true), (pixels) => pixels?.red > 50,
    'Reading the red B glyph in Artist B’s composite');
  passed('Artist B received the same red text run and rendered the red glyph');
  await closeApps(apps);
  expectNoPageErrors(a.pageErrors, 'Artist A');
  expectNoPageErrors(b.pageErrors, 'Artist B');
  passed('Both multiplayer renderers reported zero page errors');
}

async function main() {
  const tempDir = path.resolve(os.tmpdir());
  const prefix = 'atelier-phase7-';
  const tempRoot = fs.mkdtempSync(path.join(tempDir, prefix));
  const apps = [];
  let server;
  try {
    await runSoloVerification(tempRoot, apps);
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'server-data-'));
    server = await startTempServer(dataDir);
    await runMultiplayerTwoClientVerification(tempRoot, apps, server.url);
  } finally {
    try {
      await closeApps(apps);
    } finally {
      try {
        await stopOwnedProcess(server?.proc);
      } finally {
        const cleanupPath = path.resolve(tempRoot);
        assert.ok(path.dirname(cleanupPath) === tempDir && path.basename(cleanupPath).startsWith(prefix),
          'Unsafe smoke test cleanup path');
        fs.rmSync(cleanupPath, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
  console.log('PHASE7 SMOKE PASSED');
}

main().catch((error) => {
  console.error('PHASE7 SMOKE FAILED: ' + String(error.message || error).split(/\r?\n/)[0]);
  process.exit(1);
});

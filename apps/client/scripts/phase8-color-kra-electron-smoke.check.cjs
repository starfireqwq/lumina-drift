/**
 * Phase 8 Electron smoke check: soft proof and gamut warning (view only), ICC import and embedding,
 * and the .kra export → drag back round trip. From the repo root:
 *   pnpm --filter @atelier/shared build
 *   pnpm --filter @atelier/client build:electron
 *   node apps/client/scripts/phase8-color-kra-electron-smoke.check.cjs
 * Every Electron instance gets its own --user-data-dir, APPDATA and LOCALAPPDATA; the two-client part
 * uses a PORT=0 temporary server, and port 3000 is never touched.
 */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const repoRoot = path.resolve(clientRoot, '../..');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const requireClient = createRequire(path.join(clientRoot, 'package.json'));
const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const checkTimeout = 15_000;
const FIX_W = 512;
const FIX_H = 384;
const SWATCHES = { blue: [64, 64], green: [176, 64], gray: [288, 64], skin: [400, 64] };
const WARN = [0xff, 0x2b, 0xd6];

const passed = (message) => console.log('✓ ' + message);
const note = (message) => console.log('  · ' + message);

async function withinCheckTime(promise, label, timeout = checkTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeout / 1000 + ' s')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function poll(read, matches, label, timeout = checkTimeout) {
  return withinCheckTime((async () => {
    const deadline = Date.now() + timeout;
    let observed = await read();
    while (!matches(observed)) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, label + ' timed out; last value: ' + JSON.stringify(observed)?.slice(0, 200));
      await new Promise((resolve) => setTimeout(resolve, Math.min(120, remaining)));
      observed = await read();
    }
    return observed;
  })(), label, timeout + 1000);
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
  const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  killer.on('error', () => {});
  assert.ok(await waitForExit(proc, 5000), 'Isolated process did not exit after cleanup');
}

function runTsx(script, output) {
  const tsxImportUrl = pathToFileURL(requireServer.resolve('tsx')).href;
  const result = spawnSync(process.execPath, ['--import', tsxImportUrl, path.join(__dirname, script), output], {
    cwd: repoRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  assert.equal(result.status, 0, script + ' failed: ' + String(result.stderr || result.error || '').slice(0, 300));
  assert.ok(fs.existsSync(output), script + ' wrote no file');
  return fs.readFileSync(output);
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
      DATABASE_PATH: path.join(dataDir, 'phase8-smoke.db'),
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

async function launchIsolated(tempRoot, apps, label) {
  assert.ok(fs.existsSync(electronExe), 'Missing Electron executable');
  assert.ok(fs.existsSync(mainJs), 'Missing compiled Electron main');
  assert.ok(fs.existsSync(path.join(clientRoot, 'dist/index.html')), 'Missing compiled renderer');
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, 'electron-' + label + '-'));
  assert.equal(path.dirname(path.resolve(userDataDir)), tempRoot, 'Electron profile must be inside the smoke directory');
  const appData = path.join(userDataDir, 'app-data');
  const localAppData = path.join(userDataDir, 'local-app-data');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const launcherPath = path.join(userDataDir, 'phase8-launcher.cjs');
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
  const dialogs = [];
  app.context().on('weberror', (event) => pageErrors.push(event.error().message));
  const page = await app.firstWindow({ timeout: checkTimeout });
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss().catch(() => {});
  });
  page.setDefaultTimeout(checkTimeout);
  page.setDefaultNavigationTimeout(checkTimeout);
  await withinCheckTime(page.setViewportSize({ width: 1440, height: 900 }), 'Setting the viewport size');
  await page.waitForLoadState('domcontentloaded');
  return { app, page, pageErrors, dialogs, userDataDir };
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
    return debug?.layerManager && debug.softProof && debug.tileEngine?.canvasWidth === width
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

function expectNoPageErrors(launched, label) {
  assert.equal(launched.pageErrors.length, 0, label + ' page error: ' + launched.pageErrors[0]);
  assert.equal(launched.dialogs.length, 0, label + ' dialog: ' + launched.dialogs[0]);
}

async function waitForModalsClosed(page) {
  await page.locator('[aria-modal="true"]').first().waitFor({ state: 'detached' }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-modal="true"]'));
}

// ---------------------------------------------------------------- page helpers

const currentCanvasId = (page) => page.evaluate(() => window.__debugPixi?.layerManager?.getLayers()[0]?.model.canvasId ?? null);

async function readLayerPixel(page, name, [x, y]) {
  return page.evaluate(async ({ name, x, y }) => {
    const debug = window.__debugPixi;
    const item = debug?.layerManager?.getLayers().find((i) => i.model.name === name);
    if (!item) return null;
    const [pixels] = await debug.layerManager.readAsync(item.model.id, [{ x, y, w: 1, h: 1 }]);
    return Array.from(pixels);
  }, { name, x, y });
}

/** Screen pixels (CSS-pixel canvas points → device framebuffer), read right after a full render */
function readScreen(page, points, size = 1) {
  return page.evaluate(({ points, size }) => {
    const { app, viewport, layerManager } = window.__debugPixi;
    const renderer = app.renderer;
    const gl = renderer.gl;
    layerManager.prepareView(viewport.getState().zoom * renderer.resolution);
    app.render();
    const res = renderer.resolution;
    return points.map(([cx, cy]) => {
      const s = viewport.canvasToScreen(cx, cy);
      const x = Math.round(s.x * res) - Math.floor(size / 2);
      const y = gl.drawingBufferHeight - 1 - Math.round(s.y * res) - Math.floor(size / 2);
      const px = new Uint8Array(size * size * 4);
      gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return Array.from(px);
    });
  }, { points, size });
}

const diff = (a, b) => Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i])));

async function proofState(page) {
  return page.evaluate(async () => {
    await window.__debugPixi.softProof.whenIdle();
    return window.__debugPixi.softProof.getDebugState();
  });
}

async function openViewMenu(page) {
  await waitForModalsClosed(page);
  await page.getByTestId('navbar-view-menu').click();
}

async function openProofSettings(page) {
  await openViewMenu(page);
  await page.getByTestId('view-menu-proof-settings').click();
  await page.getByTestId('soft-proof-settings').waitFor();
}

async function closeTopModal(page) {
  await page.keyboard.press('Escape');
  await waitForModalsClosed(page);
}

async function toggleFromViewMenu(page, testId) {
  await openViewMenu(page);
  await page.getByTestId(testId).click();
}

async function installDownloadCapture(page) {
  await page.evaluate(() => {
    if (window.__phase8Downloads) return;
    window.__phase8Downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) {
        window.__phase8Downloads.push({ name: this.download, bytes: fetch(this.href).then((r) => r.arrayBuffer()) });
        return;
      }
      return click.call(this);
    };
  });
}

async function takeDownload(page, ext) {
  const found = await poll(() => page.evaluate(async (ext) => {
    const list = window.__phase8Downloads || [];
    const index = list.findIndex((d) => d.name.endsWith(ext));
    if (index < 0) return null;
    const { name, bytes } = list.splice(index, 1)[0];
    const data = new Uint8Array(await bytes);
    let binary = '';
    for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
    return { name, base64: btoa(binary) };
  }, ext), Boolean, 'Capturing the ' + ext + ' download', 30_000);
  return { name: found.name, bytes: Buffer.from(found.base64, 'base64') };
}

async function exportFromModal(page, format, icc) {
  await waitForModalsClosed(page);
  await page.locator('header').getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /Export \(PNG\/PSD\/ORA\/KRA\)/ }).click();
  await page.getByTestId('export-format-' + format).click();
  if (icc) await page.getByTestId('export-icc-embed').selectOption(icc);
  await page.getByTestId('export-download').click();
  const ext = format === 'kra' ? '.kra' : format === 'jpeg' ? '.jpg' : '.png';
  const file = await takeDownload(page, ext);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await waitForModalsClosed(page);
  return file;
}

async function dropFile(page, name, bytes) {
  await page.evaluate(({ name, base64 }) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { name, base64: Buffer.from(bytes).toString('base64') });
}

/** Layer count and composite stop changing between two reads 400 ms apart */
async function waitForStableDocument(page, minLayers, label) {
  let last = null;
  await poll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const state = await page.evaluate(async () => {
      const { layerManager } = window.__debugPixi;
      const px = await layerManager.readVisibleCompositeAsync();
      let hash = 2166136261;
      for (let i = 0; i < px.length; i += 3) { hash ^= px[i]; hash = Math.imul(hash, 16777619); }
      return { count: (layerManager.lastSyncedLayers || layerManager.getLayers()).length, hash: hash >>> 0 };
    });
    const stable = last !== null && last.count === state.count && last.hash === state.hash && state.count >= minLayers;
    last = state;
    return stable;
  }, Boolean, label, 30_000);
}

async function openDroppedProject(page, name, bytes, previousCanvasId, minLayers = 1) {
  await dropFile(page, name, bytes);
  await poll(() => currentCanvasId(page), (id) => id && id !== previousCanvasId, 'Opening the dropped ' + name, 30_000);
  await waitForCanvas(page, FIX_W, FIX_H);
  await poll(() => readLayerPixel(page, 'Proof Swatches', SWATCHES.blue),
    (px) => px && px[2] === 255 && px[3] === 255, 'Loading the pixels of ' + name, 30_000);
  await waitForStableDocument(page, minLayers, 'Waiting for ' + name + ' to finish loading');
  return currentCanvasId(page);
}

/** Layer tree + properties; raw pixels are kept in the page under `slot` for the later comparison */
function documentSnapshot(page, slot) {
  return withinCheckTime(page.evaluate(async (slot) => {
    const { layerManager, tileEngine } = window.__debugPixi;
    const W = tileEngine.canvasWidth;
    const H = tileEngine.canvasHeight;
    // Groups have no drawable item: the full model list (groups included) is the last synced one
    const models = [...(layerManager.lastSyncedLayers || layerManager.getLayers().map((i) => i.model))];
    const byId = new Map(models.map((m) => [m.id, m]));
    const pathOf = (m) => {
      const parts = [];
      for (let cur = m, guard = 0; cur && guard < 20; guard++) {
        parts.unshift((cur.layerType === 'mask' ? '#mask:' : '') + cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      return parts.join('/');
    };
    const siblings = (m) => models.filter((o) => (o.parentId || null) === (m.parentId || null) && (o.layerType === 'mask') === (m.layerType === 'mask'))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const tree = models.map((m) => ({
      path: pathOf(m), type: m.layerType, blend: m.blendMode, opacity: m.opacity, visible: m.isVisible,
      locked: Boolean(m.isLocked), alphaLocked: Boolean(m.alphaLocked), clip: Boolean(m.clipToBelow),
      inverted: Boolean(m.meta && m.meta.maskInverted), order: siblings(m).indexOf(m),
    })).sort((a, b) => a.path.localeCompare(b.path));
    const pixels = {};
    for (const m of models) {
      if (m.layerType === 'group') continue;
      try {
        const [data] = await layerManager.readAsync(m.id, [{ x: 0, y: 0, w: W, h: H }]);
        pixels[pathOf(m)] = new Uint8Array(data);
      } catch {
        pixels[pathOf(m)] = null;
      }
    }
    pixels['#composite'] = new Uint8Array(await layerManager.readVisibleCompositeAsync());
    window.__phase8Pixels = window.__phase8Pixels || {};
    window.__phase8Pixels[slot] = pixels;
    return { tree, pixelKeys: Object.keys(pixels).sort() };
  }, slot), 'Reading the document snapshot', 30_000);
}

function comparePixels(page, a, b) {
  return page.evaluate(({ a, b }) => {
    const A = window.__phase8Pixels[a];
    const B = window.__phase8Pixels[b];
    const out = {};
    for (const key of Object.keys(A)) {
      const x = A[key];
      const y = B[key];
      if (!x || !y || x.length !== y.length) { out[key] = { missing: true }; continue; }
      let premulMismatch = 0;
      let opaqueMismatch = 0;
      let rawMax = 0;
      for (let i = 0; i < x.length; i += 4) {
        const ax = x[i + 3];
        const ay = y[i + 3];
        for (let c = 0; c < 4; c++) rawMax = Math.max(rawMax, Math.abs(x[i + c] - y[i + c]));
        if (ax !== ay) { premulMismatch++; opaqueMismatch++; continue; }
        for (let c = 0; c < 3; c++) {
          if (Math.round(x[i + c] * ax / 255) !== Math.round(y[i + c] * ay / 255)) { premulMismatch++; break; }
        }
        if ((ax === 255) && (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2])) opaqueMismatch++;
      }
      out[key] = { premulMismatch, opaqueMismatch, rawMax };
    }
    return out;
  }, { a, b });
}

// ---------------------------------------------------------------- A. solo soft proof

async function verifySoftProof(page, tempRoot, iccBytes) {
  const points = Object.values(SWATCHES);
  const before = await readScreen(page, points);
  const layersBefore = await documentSnapshot(page, 'beforeProof');
  note('screen before proof: ' + JSON.stringify(before));

  await openProofSettings(page);
  await page.getByTestId('soft-proof-profile-builtin-fogra39').click();
  await closeTopModal(page);
  await toggleFromViewMenu(page, 'view-menu-soft-proof');
  const ready = await poll(() => proofState(page), (s) => s.filterAttached && s.proof && s.profileId === 'builtin:fogra39',
    'Building the FOGRA39 soft proof', 30_000);
  note('FOGRA39 LUT ' + ready.lutSize + '³ built in ' + ready.buildMs.toFixed(0) + ' ms');
  const proofed = await readScreen(page, points);
  note('screen with proof: ' + JSON.stringify(proofed));
  const [blue, green, gray, skin] = proofed.map((px, i) => diff(px, before[i]));
  assert.ok(blue >= 20 && green >= 20, 'Saturated blue / green must change under the proof: ' + [blue, green]);
  assert.ok(gray <= 6 && skin <= 12, 'Neutral gray / skin must barely change: ' + [gray, skin]);
  await documentSnapshot(page, 'duringProof');
  const unchanged = await comparePixels(page, 'beforeProof', 'duringProof');
  for (const [key, value] of Object.entries(unchanged)) {
    assert.ok(!value.missing && value.rawMax === 0, 'Soft proof changed the pixels of ' + key + ': ' + JSON.stringify(value));
  }
  passed('Soft proof (FOGRA39) recolours saturated blue / green on screen only; layers and the internal composite are untouched');

  await toggleFromViewMenu(page, 'view-menu-gamut-warning');
  await poll(() => proofState(page), (s) => s.gamutWarning && s.filterAttached, 'Turning on the gamut warning');
  const blocks = await readScreen(page, points, 6);
  const warnShare = blocks.map((block) => {
    let near = 0;
    for (let i = 0; i < block.length; i += 4) if (diff(block.slice(i, i + 4), WARN) <= 45) near++;
    return near / (block.length / 4);
  });
  note('warning share per swatch (blue, green, gray, skin): ' + warnShare.map((v) => v.toFixed(2)).join(', '));
  assert.ok(warnShare[0] >= 0.4 && warnShare[1] >= 0.4, 'Out-of-gamut swatches show the warning stripes');
  assert.ok(warnShare[2] === 0 && warnShare[3] === 0, 'In-gamut swatches show no warning');
  passed('Gamut warning stripes the out-of-gamut blue and green swatches and leaves gray and skin alone');

  // Frame cost of the view filter while panning (proof + warning on vs. both off)
  const measure = () => page.evaluate(async (frames) => {
    const { app, viewport, layerManager } = window.__debugPixi;
    const gl = app.renderer.gl;
    const px = new Uint8Array(4);
    const start = viewport.getState();
    const times = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      viewport.panBy(i % 2 ? -3 : 3, i % 3 ? 1 : -1);
      layerManager.prepareView(viewport.getState().zoom * app.renderer.resolution);
      app.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - t0);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    viewport.setState({ panX: start.panX, panY: start.panY });
    times.sort((a, b) => a - b);
    return { avg: times.reduce((s, t) => s + t, 0) / times.length, p95: times[Math.floor(times.length * 0.95)] };
  }, 90);
  const on = await measure();
  await toggleFromViewMenu(page, 'view-menu-soft-proof');
  await toggleFromViewMenu(page, 'view-menu-gamut-warning');
  await poll(() => proofState(page), (s) => !s.filterAttached, 'Turning the proof off for the baseline');
  const off = await measure();
  note(`frame time off avg ${off.avg.toFixed(2)} ms p95 ${off.p95.toFixed(2)} ms; on avg ${on.avg.toFixed(2)} ms p95 ${on.p95.toFixed(2)} ms`);
  assert.ok(on.avg <= Math.max(off.avg * 1.6, off.avg + 4), 'Soft proof frame cost is too high');
  assert.ok(on.p95 <= 40, 'Soft proof p95 frame time is too high');
  const restored = await readScreen(page, points);
  restored.forEach((px, i) => assert.ok(diff(px, before[i]) <= 1, 'Screen returns to normal after turning the proof off'));
  passed('Proof + warning add no noticeable frame cost while panning, and the screen returns to normal when off');

  // Import a CMYK .icc from disk through the settings dialog
  const iccPath = path.join(tempRoot, 'Lumina Test CMYK.icc');
  fs.writeFileSync(iccPath, iccBytes);
  await openProofSettings(page);
  await page.getByTestId('soft-proof-import-input').setInputFiles(iccPath);
  const iccId = await poll(() => page.evaluate(() => {
    const radios = [...document.querySelectorAll('[data-testid^="soft-proof-profile-icc-"]')];
    return radios.length ? radios[0].getAttribute('data-testid') : null;
  }), Boolean, 'Listing the imported ICC profile');
  await poll(() => page.getByTestId(iccId).getAttribute('aria-checked'), (v) => v === 'true', 'Selecting the imported profile');
  await page.getByTestId('soft-proof-toggle').click();
  await poll(() => page.getByTestId('soft-proof-status').getAttribute('data-state'), (v) => v === 'ready', 'Building the ICC soft proof', 30_000);
  await closeTopModal(page);
  const viaIcc = await readScreen(page, points);
  assert.ok(diff(viaIcc[0], before[0]) >= 20 && diff(viaIcc[2], before[2]) <= 6, 'Imported ICC proof recolours blue and keeps gray');
  passed('Imported .icc (synthetic CMYK, lut16) is parsed, selected and applied: ' + JSON.stringify(viaIcc[0]));

  // Exports ignore the proof: PNG with sRGB embedded while proofing == PNG without proof
  await installDownloadCapture(page);
  const withProof = await exportFromModal(page, 'merged_png', 'srgb');
  const iccChunk = readPngIccName(withProof.bytes);
  assert.equal(iccChunk, 'sRGB IEC61966-2.1', 'Exported PNG carries the embedded sRGB profile');
  await openProofSettings(page);
  await page.getByTestId('soft-proof-toggle').click();
  await poll(() => proofState(page), (s) => !s.filterAttached, 'Turning the ICC proof off');
  await closeTopModal(page);
  const withoutProof = await exportFromModal(page, 'merged_png', 'none');
  assert.equal(readPngIccName(withoutProof.bytes), null, 'A PNG exported with "None" has no iCCP chunk');
  const same = await page.evaluate(async ({ a, b }) => {
    const decode = async (base64) => {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [x, y] = await Promise.all([decode(a), decode(b)]);
    if (x.length !== y.length) return -1;
    let max = 0;
    for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i] - y[i]));
    return max;
  }, { a: withProof.bytes.toString('base64'), b: withoutProof.bytes.toString('base64') });
  assert.equal(same, 0, 'PNG exported while proofing must match the unproofed export');
  passed('PNG export embeds sRGB IEC61966-2.1 and its pixels are identical with the proof on or off');
}

function readPngIccName(bytes) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'iCCP') {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const end = data.indexOf(0);
      const name = data.toString('latin1', 0, end);
      zlib.inflateSync(data.subarray(end + 2)); // must be a valid zlib stream
      return name;
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return null;
}

// ---------------------------------------------------------------- B. .kra round trip

async function verifyKraRoundTrip(page, fixtureBytes) {
  const blankId = await currentCanvasId(page);
  const fixtureId = await openDroppedProject(page, 'Phase 8 Fixture.kra', fixtureBytes, blankId);
  const original = await documentSnapshot(page, 'original');
  const find = (p) => original.tree.find((n) => n.path === p);
  note('imported layers: ' + original.tree.map((n) => `${n.path}[${n.type},${n.blend}]`).join('; '));
  assert.equal(find('Group G')?.type, 'group');
  assert.ok(find('Group G/#mask:Transparency Mask'), 'Group mask imported');
  assert.equal(find('Group G/Clip')?.clip, true);
  assert.equal(find('Group G/Mul')?.blend, 'multiply');
  assert.equal(find('Screen 37')?.blend, 'screen');
  assert.ok(Math.abs(find('Screen 37').opacity - 0.37) < 1e-9, 'Precise 37% opacity');
  assert.equal(find('Glow')?.blend, 'glow');
  assert.equal(find('Lum')?.blend, 'luminosity');
  assert.equal(find('Lum/#mask:Transparency Mask')?.inverted, true);
  assert.equal(find('Alpha Locked')?.alphaLocked, true);
  assert.equal(find('Hidden')?.visible, false);
  assert.equal(find('Mask Off/#mask:Transparency Mask')?.visible, false);
  assert.equal(find('Locked')?.locked, true);
  passed('The .kra fixture opened in Lumina with its group, masks, clipping, blend modes, 37% opacity and locks (' + original.tree.length + ' layers)');

  const exported = await exportFromModal(page, 'kra');
  const JSZip = requireClient('jszip');
  assert.equal(exported.bytes.toString('latin1', 30, 38), 'mimetype', 'mimetype is the first zip entry');
  assert.equal(exported.bytes.readUInt16LE(8), 0, 'mimetype is stored uncompressed');
  assert.equal(exported.bytes.toString('latin1', 38, 57), 'application/x-krita');
  const zip = await JSZip.loadAsync(exported.bytes);
  for (const name of ['maindoc.xml', 'documentinfo.xml', 'mergedimage.png', 'preview.png']) assert.ok(zip.file(name), 'Missing ' + name);
  const maindoc = await zip.file('maindoc.xml').async('string');
  const files = [...maindoc.matchAll(/nodetype="paintlayer"[^>]*?filename="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 10, 'Paint layers listed in maindoc.xml');
  for (const file of files) assert.ok(zip.file('Lumina/layers/' + file), 'Missing tile stream ' + file);
  note('exported ' + exported.name + ' (' + exported.bytes.length + ' bytes, ' + Object.keys(zip.files).length + ' entries)');
  passed('Export .kra wrote a STORE mimetype first, maindoc.xml, merged / preview PNGs and every layer tile stream');

  await openDroppedProject(page, 'phase8-roundtrip.kra', exported.bytes, fixtureId, original.tree.length);
  const reopened = await documentSnapshot(page, 'reopened');
  assert.deepEqual(reopened.tree, original.tree, 'Layer tree, blend modes, opacity, visibility, locks, clipping and masks');
  assert.deepEqual(reopened.pixelKeys, original.pixelKeys);
  const result = await comparePixels(page, 'original', 'reopened');
  let worst = 0;
  for (const [key, value] of Object.entries(result)) {
    assert.ok(!value.missing, 'Missing pixels for ' + key);
    assert.equal(value.premulMismatch, 0, 'Premultiplied pixel mismatch in ' + key + ': ' + JSON.stringify(value));
    assert.equal(value.opaqueMismatch, 0, 'Opaque / transparent pixel mismatch in ' + key);
    worst = Math.max(worst, value.rawMax);
  }
  note('largest raw RGBA difference over all layers, masks and the composite: ' + worst);
  passed('Dragging the exported .kra back reproduced the same tree and identical pixels in all ' + Object.keys(result).length + ' layers, masks and the composite');
}

async function runSolo(tempRoot, apps, fixtures) {
  const solo = await launchIsolated(tempRoot, apps, 'solo');
  const { page } = solo;
  await enterOfflineCanvas(page);
  // Exports are captured in the page: nothing is ever written to the real Downloads folder
  await installDownloadCapture(page);
  await verifyKraRoundTrip(page, fixtures.kra);
  await verifySoftProof(page, tempRoot, fixtures.icc);
  await closeApps(apps);
  expectNoPageErrors(solo, 'Solo');
  passed('The solo renderer reported zero page errors and dialogs');
}

// ---------------------------------------------------------------- C. two clients

async function postJson(url, route, body, token) {
  const response = await fetch(url + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(checkTimeout),
  });
  if (!response.ok) throw new Error(route + ' returned ' + response.status + ': ' + (await response.text()).slice(0, 200));
  return response.json();
}

/** Uploads several coloured blocks at once (blocks sharing a tile are composed into the same upload) */
async function seedRemoteBlocks(url, token, canvas, layerId, blocks) {
  const { DEFAULT_TILE_SIZE: size, getTileBounds } = require('../../../packages/shared/dist/index.js');
  const byTile = new Map();
  for (const [block, rgba] of blocks) {
    for (let row = Math.floor(block.y / size); row * size < block.y + block.h; row++) {
      for (let col = Math.floor(block.x / size); col * size < block.x + block.w; col++) {
        const { x, y, width, height } = getTileBounds(col, row, size, canvas.width, canvas.height);
        const key = col + ',' + row;
        if (!byTile.has(key)) byTile.set(key, { col, row, x, y, width, height, pixels: Buffer.alloc(width * height * 4) });
        const tile = byTile.get(key);
        for (let py = Math.max(y, block.y); py < Math.min(y + height, block.y + block.h); py++) {
          for (let px = Math.max(x, block.x); px < Math.min(x + width, block.x + block.w); px++) {
            tile.pixels.set(rgba, ((py - y) * width + px - x) * 4);
          }
        }
      }
    }
  }
  const tiles = [...byTile.values()].map(({ col, row, width, height, pixels }) => ({
    col, row, width, height, compression: 'raw', data: pixels.toString('base64'),
  }));
  for (let i = 0; i < tiles.length; i += 3) {
    await postJson(url, '/api/canvases/' + canvas.id + '/layers/' + layerId + '/tiles', { tiles: tiles.slice(i, i + 3) }, token);
  }
}

async function openMpWindow(tempRoot, apps, label, serverUrl, auth, canvas, sentFrames) {
  const launched = await launchIsolated(tempRoot, apps, label);
  const { page } = launched;
  if (sentFrames) {
    page.on('websocket', (ws) => ws.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : '<binary>';
      sentFrames.push(payload);
    }));
  }
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

async function runDuo(tempRoot, apps, url) {
  const register = (artist) => postJson(url, '/api/auth/register', {
    username: 'phase8_artist_' + artist.toLowerCase(), password: 'Password123!', displayName: 'Artist ' + artist,
  });
  const authA = await register('A');
  const authB = await register('B');
  const { canvas, layers } = await postJson(url, '/api/canvases', { title: 'Phase 8 Proof Duo', width: FIX_W, height: FIX_H }, authA.token);
  const base = layers.find((layer) => layer.layerType === 'raster' && !layer.isLocked && layer.ownerId === authA.user.id);
  assert.ok(base, 'Missing Artist A raster layer');
  await postJson(url, '/api/canvases/join', { canvasId: canvas.id }, authB.token);
  await seedRemoteBlocks(url, authA.token, canvas, base.id, [
    [{ x: 16, y: 16, w: 96, h: 96 }, [0, 0, 255, 255]],
    [{ x: 240, y: 16, w: 96, h: 96 }, [128, 128, 128, 255]],
  ]);

  const sentA = [];
  const a = await openMpWindow(tempRoot, apps, 'artist-a', url, authA, canvas, sentA);
  const b = await openMpWindow(tempRoot, apps, 'artist-b', url, authB, canvas);
  const points = [SWATCHES.blue, SWATCHES.gray];
  const loaded = (px) => px[0][2] === 255 && px[0][0] === 0 && px[1][0] === 128;
  const compositeAt = (page) => page.evaluate(async (points) => {
    const { layerManager, tileEngine } = window.__debugPixi;
    const pixels = await layerManager.readVisibleCompositeAsync();
    return points.map(([x, y]) => Array.from(pixels.subarray((y * tileEngine.canvasWidth + x) * 4, (y * tileEngine.canvasWidth + x) * 4 + 4)));
  }, points);
  await Promise.all([a.page, b.page].map((page) => poll(() => compositeAt(page), loaded, 'Loading the seeded blue and gray blocks', 30_000)));
  const aBefore = await readScreen(a.page, points);
  const bBefore = await readScreen(b.page, points);
  passed('Both clients loaded the REST-seeded blue and gray blocks');

  await new Promise((resolve) => setTimeout(resolve, 500));
  const mark = sentA.length;
  await openProofSettings(a.page);
  await a.page.getByTestId('soft-proof-profile-builtin-fogra39').click();
  await closeTopModal(a.page);
  await toggleFromViewMenu(a.page, 'view-menu-soft-proof');
  await toggleFromViewMenu(a.page, 'view-menu-gamut-warning');
  await poll(() => proofState(a.page), (s) => s.filterAttached && s.proof && s.gamutWarning, 'Proofing on Artist A', 30_000);
  const aAfter = await readScreen(a.page, points);
  assert.ok(diff(aAfter[0], aBefore[0]) >= 20, 'Artist A sees the proofed / warned blue');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const bAfter = await readScreen(b.page, points);
  bAfter.forEach((px, i) => assert.ok(diff(px, bBefore[i]) <= 1, 'Artist B’s screen is untouched'));
  assert.equal((await proofState(b.page)).active, false, 'Artist B has no proof active');
  const sent = sentA.slice(mark).filter((payload) => payload !== '2' && payload !== '3');
  note('socket frames sent by A while toggling (excluding ping/pong): ' + sent.length + (sent.length ? ' ' + JSON.stringify(sent.map((p) => p.slice(0, 40))) : ''));
  assert.equal(sent.length, 0, 'Turning the proof on must not send anything to the room');
  passed('Artist A’s soft proof + gamut warning stayed local: B’s screen unchanged and A sent no room events');

  await closeApps(apps);
  expectNoPageErrors(a, 'Artist A');
  expectNoPageErrors(b, 'Artist B');
  passed('Both multiplayer renderers reported zero page errors and dialogs');
}

async function main() {
  const tempDir = path.resolve(os.tmpdir());
  const prefix = 'atelier-phase8-';
  const tempRoot = fs.mkdtempSync(path.join(tempDir, prefix));
  const apps = [];
  let server;
  try {
    const fixtures = {
      kra: runTsx('phase8-make-test-kra.ts', path.join(tempRoot, 'fixture.kra')),
      icc: runTsx('phase8-make-test-icc.ts', path.join(tempRoot, 'fixture.icc')),
    };
    passed('Generated the .kra fixture (' + fixtures.kra.length + ' bytes) and the synthetic CMYK .icc (' + fixtures.icc.length + ' bytes)');
    await runSolo(tempRoot, apps, fixtures);
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'server-data-'));
    server = await startTempServer(dataDir);
    await runDuo(tempRoot, apps, server.url);
  } finally {
    try {
      await closeApps(apps);
    } finally {
      try {
        await stopOwnedProcess(server?.proc);
      } finally {
        const cleanupPath = path.resolve(tempRoot);
        assert.ok(path.dirname(cleanupPath) === tempDir && path.basename(cleanupPath).startsWith(prefix), 'Unsafe smoke test cleanup path');
        fs.rmSync(cleanupPath, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
  console.log('PHASE8 SMOKE PASSED');
}

main().catch((error) => {
  console.error('PHASE8 SMOKE FAILED: ' + String(error.message || error).split(/\r?\n/).filter(Boolean).slice(0, 6).join(' | '));
  process.exit(1);
});

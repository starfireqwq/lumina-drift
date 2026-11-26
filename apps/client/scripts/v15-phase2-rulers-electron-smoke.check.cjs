/**
 * v1.5 Phase 2 Electron smoke check for Rulers v2:
 *   - Radial Line (集中線) & Curve / Bezier ruler overlays + snapping
 *   - 2D Perspective Spatial Grid (XY / XZ / YZ)
 *   - CSP-style Ruler-on-Layer binding, scope switching (all_layers / same_folder / target_layer),
 *     badge toggling, and multiplayer room Socket.IO sync.
 *
 * Build @atelier/shared, @atelier/server, and the Electron client first, then run from the repo root:
 *   node apps/client/scripts/v15-phase2-rulers-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireClient = createRequire(path.join(clientRoot, 'package.json'));
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');
const electronExe = requireClient('electron');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const rendererHtml = path.join(clientRoot, 'dist/index.html');
const serverApp = path.join(serverRoot, 'dist/app.js');
const tempPrefix = 'atelier-v15-phase2-rulers-';
const actionTimeout = 12_000;
const roomUpdateTimeout = 6_000;

function hasExited(child) {
  return !child?.pid || child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeout) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeout);
    child.once('exit', onExit);
  });
}

async function forceStop(child, label) {
  if (hasExited(child)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 5_000,
    });
  } else {
    child.kill('SIGKILL');
  }
  assert.ok(await waitForExit(child, 5_000), `${label} process did not exit during cleanup`);
}

function startTempServer(dataDir) {
  const launcher = path.join(dataDir, 'launch-temp-server.mjs');
  fs.writeFileSync(launcher, `
    import { buildApp } from ${JSON.stringify(pathToFileURL(serverApp).href)};
    const app = await buildApp();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    if (new URL(address).port === '3000') throw new Error('Reserved server port');
    process.once('message', async (message) => {
      if (message !== 'shutdown') return;
      await app.close();
      process.disconnect();
    });
    process.send({ address });
  `);
  const child = spawn(process.execPath, [launcher], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATABASE_PATH: path.join(dataDir, 'v15-phase2-rulers.sqlite'),
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
      JWT_SECRET: '',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2_000); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Temp server start timed out. ${stderr.trim()}`)), 25_000);
    child.once('message', ({ address }) => {
      clearTimeout(timer);
      resolve(address);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Temp server exited (${code}). ${stderr.trim()}`));
    });
  });
  return { child, ready };
}

async function stopTempServer(server) {
  const child = server?.child;
  if (hasExited(child)) return;
  if (child.connected) child.send('shutdown', () => {});
  if (!(await waitForExit(child, 3_000))) await forceStop(child, 'Temp server');
}

async function closeElectron(app) {
  const child = app.process();
  const closed = app.close().then(() => true, () => false);
  if (await waitForExit(child, 8_000)) return;
  await forceStop(child, 'Electron');
  assert.ok(await Promise.race([closed, delay(2_000, false)]), 'Electron did not close cleanly');
}

async function launchIsolated(tempRoot, apps, rendererErrors, label) {
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, `electron-${label}-`));
  const launcher = path.join(userDataDir, 'launch-electron.cjs');
  fs.writeFileSync(launcher, `
    const { app, BrowserWindow, ipcMain, session } = require('electron');
    const { EventEmitter } = require('node:events');
    const http = require('node:http');
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

    const loadFile = BrowserWindow.prototype.loadFile;
    const rendererReady = new Promise((resolve) => { globalThis.startSmokeRenderer = resolve; });
    BrowserWindow.prototype.loadFile = async function (...args) {
      try {
        await this.loadURL('data:text/html,<title>Smoke startup</title>');
        await rendererReady;
        await loadFile.apply(this, args);
      } catch (error) {
        console.error('Smoke renderer failed to load:', error);
        app.exit(1);
      }
    };
    require(${JSON.stringify(mainJs)});
    for (const channel of ['atelier:start-server', 'atelier:start-tunnel']) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle('atelier:start-server', () => false);
    ipcMain.handle('atelier:start-tunnel', () => ({ success: false }));
  `);
  const env = { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir, PORT: '0' };
  delete env.VITE_DEV_SERVER_URL;
  const args = ['--noerrdialogs'];
  if (process.env.ATELIER_SMOKE_SOFTWARE_GPU === '1') {
    args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--in-process-gpu');
  }
  if (process.env.ATELIER_SMOKE_NO_CHROMIUM_SANDBOX === '1') args.push('--no-sandbox');
  args.push(launcher, `--user-data-dir=${userDataDir}`);
  const app = await electron.launch({
    executablePath: electronExe,
    args,
    env,
    artifactsDir: userDataDir,
    timeout: 25_000,
  });
  apps.push(app);
  const context = app.context();
  context.on('console', (message) => {
    if (message.type() === 'error') {
      const { url, lineNumber } = message.location();
      rendererErrors.push(`${label} console error at ${url || '(renderer)'}:${lineNumber}: ${message.text()}`);
    }
  });
  context.on('weberror', (event) => {
    rendererErrors.push(`${label} pageerror: ${event.error().message}`);
  });
  const page = await app.firstWindow({ timeout: 25_000 });
  page.setDefaultTimeout(actionTimeout);
  await page.setViewportSize({ width: 1440, height: 900 });
  return { app, page };
}

async function openRenderer({ app, page }, storage) {
  const url = pathToFileURL(rendererHtml).href;
  await page.addInitScript(({ url, storage }) => {
    if (location.href !== url) return;
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, { url, storage: { atelier_language: 'en-US', ...storage } });
  await app.evaluate(() => globalThis.startSmokeRenderer());
  await page.waitForURL(url, { waitUntil: 'domcontentloaded' });
}

const layerRows = (page) => page.locator('[data-layer-id]');
const selectedLayer = (page) => layerRows(page).and(page.locator('[aria-selected="true"]'));

async function waitForCanvas(page) {
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25_000 });
  await page.getByTestId('layer-paper-row').waitFor();
}

async function openRulerModal(page) {
  await page.getByRole('button', { name: 'Rulers & Guides', exact: true }).click();
  await page.getByTestId('ruler-mode-radial_line').waitFor();
}

async function verifySolo(page) {
  await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
  await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
  await page.getByRole('spinbutton', { name: /^Width/ }).fill('800');
  await page.getByRole('spinbutton', { name: /^Height/ }).fill('600');
  await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
  await waitForCanvas(page);

  await openRulerModal(page);

  // 1. Radial Line Ruler
  await page.getByTestId('ruler-mode-radial_line').click();
  await page.getByTestId('radial-line-overlay').waitFor();
  const radialCheck = await page.evaluate(() => {
    const rm = window.__debugPixi.rulerManager;
    rm.onStrokeStart({ x: 500, y: 400 }); // center is (400, 300) -> 45 deg
    const res = rm.snapPoint({ x: 620, y: 480 });
    rm.onStrokeEnd();
    return { snapped: res.snapped, dx: res.point.x - 400, dy: res.point.y - 300 };
  });
  assert.equal(radialCheck.snapped, true, 'Radial line should snap stroke');
  assert.ok(Math.abs(radialCheck.dx - radialCheck.dy) < 0.1, `Radial snap must lock 45° ray, got ${JSON.stringify(radialCheck)}`);

  // 2. Curve / Bezier Ruler
  await page.getByTestId('ruler-mode-curve').click();
  await page.getByTestId('curve-ruler-overlay').waitFor();
  await page.getByTestId('curve-add-node-btn').click();
  const curveAnchors = await page.locator('[data-testid^="curve-anchor-"]').count();
  assert.equal(curveAnchors, 4, 'Curve ruler should have 4 anchors after adding one node');
  const curveSnap = await page.evaluate(() => {
    const rm = window.__debugPixi.rulerManager;
    rm.onStrokeStart({ x: 400, y: 300 });
    const res = rm.snapPoint({ x: 405, y: 305 });
    rm.onStrokeEnd();
    return res;
  });
  assert.equal(curveSnap.snapped, true, 'Curve ruler should snap stroke points');
  assert.equal(curveSnap.axisLabel, 'Curve');

  // 3. Perspective 2D Spatial Grid (XY / XZ / YZ)
  await page.getByTestId('ruler-mode-perspective').click();
  await page.getByTestId('perspective-grid-toggle').check();
  await page.getByTestId('perspective-grid-plane-xy').click();
  await page.getByTestId('perspective-grid-plane-yz').click();
  await page.getByTestId('perspective-grid-lines').waitFor();
  await page.getByTestId('perspective-grid-origin').waitFor();
  const planeCounts = await page.evaluate(() => ({
    xy: document.querySelectorAll('[data-grid-plane="xy"]').length,
    xz: document.querySelectorAll('[data-grid-plane="xz"]').length,
    yz: document.querySelectorAll('[data-grid-plane="yz"]').length,
  }));
  assert.ok(planeCounts.xy > 0 && planeCounts.xz > 0 && planeCounts.yz > 0,
    `All 3 perspective 2D grid planes should render: ${JSON.stringify(planeCounts)}`);

  // 4. CSP-style Ruler-on-Layer binding & scope switching
  const firstLayerId = await selectedLayer(page).getAttribute('data-layer-id');
  assert.ok(firstLayerId, 'Expected an active layer id');
  await page.getByTestId('ruler-bind-current-layer-btn').click();
  const badge = page.getByTestId(`layer-ruler-badge-${firstLayerId}`);
  await badge.waitFor();
  assert.equal(await badge.getAttribute('data-ruler-enabled'), 'true');
  assert.equal(await badge.getAttribute('data-ruler-effective'), 'true');

  // Switch scope to target_layer, then add a new raster layer and confirm ruler deactivates on the new layer
  await page.getByTestId('ruler-scope-target_layer').click();
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-testid="layer-ruler-badge-${id}"]`);
    return el?.getAttribute('data-ruler-scope') === 'target_layer';
  }, firstLayerId);

  await page.getByRole('button', { name: 'New Raster Layer', exact: true }).click();
  await page.waitForFunction((firstId) => {
    const active = document.querySelector('[data-layer-id][aria-selected="true"]');
    return active && active.getAttribute('data-layer-id') !== firstId;
  }, firstLayerId);

  assert.equal(await badge.getAttribute('data-ruler-effective'), 'false',
    'target_layer ruler badge should become inactive when another layer is selected');

  // Switch back to the bound layer -> perspective grid ruler automatically restores
  await page.locator(`[data-layer-id=${JSON.stringify(firstLayerId)}]`).click();
  await page.getByTestId('perspective-grid-lines').waitFor();
  assert.equal(await badge.getAttribute('data-ruler-effective'), 'true');

  // Click CSP ruler badge to disable/enable
  await badge.click();
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-testid="layer-ruler-badge-${id}"]`);
    return el?.getAttribute('data-ruler-enabled') === 'false';
  }, firstLayerId);
  await page.getByTestId('perspective-grid-lines').waitFor({ state: 'hidden' });

  await badge.click();
  await page.getByTestId('perspective-grid-lines').waitFor();
  console.log('Solo radial line, curve ruler, 2D perspective XY/XZ/YZ grid, and CSP layer-bound ruler verified');
}

async function postJson(url, route, body, token) {
  const response = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(actionTimeout),
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function prepareRoom(url) {
  async function loginArtist(displayName) {
    const credentials = { username: `phase2_${displayName.toLowerCase()}`, password: 'Password123!' };
    await postJson(url, '/api/auth/register', { ...credentials, displayName });
    return postJson(url, '/api/auth/login', credentials);
  }
  const alice = await loginArtist('Alice');
  const bob = await loginArtist('Bob');
  const { canvas, layers } = await postJson(url, '/api/canvases', {
    title: 'v1.5 Phase 2 Rulers Smoke', width: 640, height: 480,
  }, alice.token);
  const joined = await postJson(url, '/api/canvases/join', { canvasId: canvas.id }, bob.token);
  assert.equal(joined.canvas.id, canvas.id);
  const layer = layers.find((entry) => entry.layerType === 'raster' && !entry.isLocked && entry.aclMode === 'shared_all');
  assert.ok(layer, 'Expected shared raster layer in room');
  return { alice, bob, canvasId: canvas.id, layerId: layer.id };
}

async function enterRoom(window, url, auth, canvasId) {
  const { page } = window;
  await openRenderer(window, {
    atelier_server_url: url,
    atelier_gateway_resolved: 'true',
    atelier_gateway_skip_on_launch: 'true',
    atelier_active_canvas_id: canvasId,
    [`atelier_token:${url}`]: auth.token,
    atelier_token: auth.token,
    atelier_user: JSON.stringify(auth.user),
  });
  await waitForCanvas(page);
}

async function verifyMultiplayer(tempRoot, apps, rendererErrors, url) {
  const { alice, bob, canvasId, layerId } = await prepareRoom(url);
  const aliceWindow = await launchIsolated(tempRoot, apps, rendererErrors, 'Alice');
  await enterRoom(aliceWindow, url, alice, canvasId);
  const bobWindow = await launchIsolated(tempRoot, apps, rendererErrors, 'Bob');
  await enterRoom(bobWindow, url, bob, canvasId);

  const alicePage = aliceWindow.page;
  const bobPage = bobWindow.page;

  // Select shared layer on both sides
  for (const page of [alicePage, bobPage]) {
    const row = page.locator(`[data-layer-id=${JSON.stringify(layerId)}]`);
    await row.click();
    await row.and(selectedLayer(page)).waitFor();
  }

  // Alice creates a Radial Line ruler and binds it with all_layers scope
  await openRulerModal(alicePage);
  await alicePage.getByTestId('ruler-mode-radial_line').click();
  await alicePage.getByTestId('radial-line-overlay').waitFor();
  await alicePage.getByTestId('ruler-bind-current-layer-btn').click();
  await alicePage.getByTestId(`layer-ruler-badge-${layerId}`).waitFor();
  await alicePage.getByTestId('ruler-scope-all_layers').click();

  // Bob receives synced layer ruler badge & live radial line overlay automatically
  const bobBadge = bobPage.getByTestId(`layer-ruler-badge-${layerId}`);
  await bobBadge.waitFor({ timeout: roomUpdateTimeout });
  await bobPage.getByTestId('radial-line-overlay').waitFor({ timeout: roomUpdateTimeout });
  await bobPage.getByTestId('ruler-hud-bound-pill').waitFor({ timeout: roomUpdateTimeout });
  console.log('Multiplayer layer-bound ruler Socket.IO sync verified');
}

async function main() {
  for (const file of [electronExe, mainJs, rendererHtml, serverApp]) {
    assert.ok(fs.existsSync(file), `Missing smoke test build prerequisite: ${file}`);
  }
  const tempParent = fs.realpathSync(os.tmpdir());
  const tempRoot = fs.mkdtempSync(path.join(tempParent, tempPrefix));
  const apps = [];
  const rendererErrors = [];
  const failures = [];
  let server;
  try {
    const solo = await launchIsolated(tempRoot, apps, rendererErrors, 'Solo');
    await openRenderer(solo, { atelier_session_mode: 'offline' });
    await verifySolo(solo.page);
    await closeElectron(apps.at(-1));
    apps.pop();

    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'server-data-'));
    server = startTempServer(dataDir);
    await verifyMultiplayer(tempRoot, apps, rendererErrors, await server.ready);
  } catch (error) {
    failures.push(error);
  } finally {
    const appCleanup = await Promise.allSettled(apps.map(closeElectron));
    for (const result of appCleanup) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    try {
      await stopTempServer(server);
    } catch (error) {
      failures.push(error);
    }
    try {
      const resolved = fs.realpathSync(tempRoot);
      assert.ok(path.dirname(resolved) === tempParent && path.basename(resolved).startsWith(tempPrefix),
        `Unexpected temporary directory: ${resolved}`);
      fs.rmSync(resolved, { recursive: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (rendererErrors.length) failures.push(new Error(`Renderer errors recorded:\n${rendererErrors.join('\n')}`));
  if (failures.length) throw new AggregateError(failures, 'V15 PHASE 2 RULERS ELECTRON SMOKE FAILED');
  console.log('V15 PHASE 2 RULERS ELECTRON SMOKE PASSED (0 console errors, 0 page errors)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

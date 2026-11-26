/**
 * v1.5 Phase 1 Electron smoke check for paper, layer labels, and draft tint.
 * Build @atelier/shared, @atelier/server, and the Electron client first, then run from the repo root:
 *   node apps/client/scripts/v15-phase1-layer-colors-electron-smoke.check.cjs
 * Set ATELIER_SMOKE_SOFTWARE_GPU=1 for software rendering on test hosts without a usable GPU process.
 * ATELIER_SMOKE_NO_CHROMIUM_SANDBOX=1 is for trusted local smoke runs where nested sandboxing is unavailable.
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
const tempPrefix = 'atelier-v15-phase1-layer-colors-';
const actionTimeout = 10_000;
const roomUpdateTimeout = 5_000;

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
      DATABASE_PATH: path.join(dataDir, 'v15-phase1-layer-colors.sqlite'),
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

    // Block the startup health probe and any renderer requests to the resident server.
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

    // Attach Playwright's context listeners before the compiled renderer starts executing.
    const loadFile = BrowserWindow.prototype.loadFile;
    const rendererReady = new Promise((resolve) => { globalThis.startSmokeRenderer = resolve; });
    BrowserWindow.prototype.loadFile = async function (...args) {
      // Playwright launch waits for the first page to initialize before returning.
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
    // The test's Fastify instance is the only server these Electron windows may start with.
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
  // Configure the session before auth can probe the desktop's default server.
  await page.addInitScript(({ url, storage }) => {
    if (location.href !== url) return;
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, { url, storage: { atelier_language: 'en-US', ...storage } });
  await app.evaluate(() => globalThis.startSmokeRenderer());
  await page.waitForURL(url, { waitUntil: 'domcontentloaded' });
}

const layerRows = (page) => page.locator('[data-layer-id]');
const selectedLayer = (page) => layerRows(page).and(page.locator('[aria-selected="true"]'));
const paperRow = (page) => page.getByTestId('layer-paper-row');
const paperPopover = (page) => page.getByTestId('layer-paper-popover');

async function expectPressed(button, pressed) {
  await button.and(button.page().getByRole('button', { pressed })).waitFor();
}

async function expectPaper(page, color, timeout = actionTimeout) {
  await paperRow(page).getByText(color, { exact: true }).waitFor({ timeout });
}

async function openPaper(page) {
  await paperRow(page).getByTestId('layer-paper-color-btn').click();
  await paperPopover(page).waitFor();
  return paperPopover(page);
}

async function closePopover(page, popover) {
  await page.keyboard.press('Escape');
  await popover.waitFor({ state: 'hidden' });
}

async function waitForCanvas(page) {
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25_000 });
  await paperRow(page).waitFor();
}

async function verifySolo(page) {
  await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
  await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
  await page.getByRole('spinbutton', { name: /^Width/ }).fill('768');
  await page.getByRole('spinbutton', { name: /^Height/ }).fill('640');
  await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
  await waitForCanvas(page);

  assert.ok(await paperRow(page).evaluate((paper) => {
    const layers = paper.previousElementSibling?.querySelectorAll('[data-layer-id]');
    return layers?.length > 0 && [...layers].every((layer) =>
      Boolean(layer.compareDocumentPosition(paper) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), 'Paper row must follow the layer list');
  const paper = await openPaper(page);
  await paper.getByRole('button', { name: '#262626', exact: true }).click();
  await expectPaper(page, '#262626');
  await closePopover(page, paper);
  const eye = paperRow(page).getByTestId('layer-paper-eye');
  await expectPressed(eye, true);
  await eye.click();
  await expectPressed(eye, false);
  await eye.click();
  await expectPressed(eye, true);

  await page.getByTestId('layer-palette-color-btn').click();
  const palette = page.getByTestId('layer-palette-color-popover');
  const pink = palette.getByRole('button', { name: '#F472B6', exact: true });
  await pink.click();
  await expectPressed(pink, true);
  await closePopover(page, palette);
  const layerEye = selectedLayer(page).getByRole('button', { name: 'Hide Layer', exact: true });
  assert.equal(await layerEye.evaluate((button) => getComputedStyle(button.parentElement).backgroundColor),
    'rgb(244, 114, 182)', 'Selected layer visibility gutter should use the pink label color');

  const tint = page.getByTestId('layer-display-color-btn');
  await tint.click();
  await expectPressed(tint, true);
  await page.getByTestId('layer-display-color-menu-btn').click();
  const settings = page.getByTestId('layer-display-color-popover').and(page.getByRole('dialog', { name: 'Change layer color' }));
  await settings.waitFor();
  for (const label of ['Main color (lines)', 'Sub color (highlights)']) {
    await settings.getByLabel(label, { exact: true }).and(settings.locator('input[type="color"]')).waitFor();
  }
  await closePopover(page, settings);
  console.log('Solo paper color, visibility, layer label, and draft tint controls verified');
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
    const credentials = { username: `phase1_${displayName.toLowerCase()}`, password: 'Password123!' };
    await postJson(url, '/api/auth/register', { ...credentials, displayName });
    return postJson(url, '/api/auth/login', credentials);
  }
  const alice = await loginArtist('Alice');
  const bob = await loginArtist('Bob');
  const { canvas, layers } = await postJson(url, '/api/canvases', {
    title: 'v1.5 Phase 1 Layer Colors Smoke', width: 320, height: 272,
  }, alice.token);
  const joined = await postJson(url, '/api/canvases/join', { canvasId: canvas.id }, bob.token);
  assert.equal(joined.canvas.id, canvas.id, 'Bob should join the canvas created by Alice');
  assert.equal(joined.myMembership.role, 'editor', 'Bob should join as an editor');
  const layer = layers.find((entry) => entry.layerType === 'raster' && !entry.isLocked && entry.aclMode === 'shared_all');
  assert.ok(layer, 'The room should contain an unlocked raster layer shared with all editors');
  return { alice, bob, canvasId: canvas.id, layerId: layer.id };
}

function observeRoomPackets(page, serverUrl) {
  const packets = [];
  const serverHost = new URL(serverUrl).host;
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.host !== serverHost || url.pathname !== '/socket.io/') return;
    socket.on('framereceived', ({ payload }) => {
      // The default namespace uses Engine.IO message (4), Socket.IO event (2), then JSON.
      if (typeof payload !== 'string' || !payload.startsWith('42[')) return;
      const [event, data] = JSON.parse(payload.slice(2));
      if (event === 'room_state' || event === 'canvas_updated') {
        packets.push({ event, data, receivedAt: performance.now() });
      }
    });
  });
  return packets;
}

async function waitForRoomPacket(packets, match, deadline, message) {
  while (true) {
    if (packets.some((packet) => packet.receivedAt <= deadline && match(packet))) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) assert.fail(message);
    await delay(Math.min(25, remaining));
  }
}

async function enterRoom(window, url, auth, canvasId) {
  const { page } = window;
  const packets = observeRoomPackets(page, url);
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
  await waitForRoomPacket(packets, ({ event, data }) => event === 'room_state' && data.canvasId === canvasId,
    performance.now() + actionTimeout, `${auth.user.displayName} did not receive room_state for ${canvasId}`);
  await expectPaper(page, '#FFFFFF');
  return packets;
}

async function verifyMultiplayer(tempRoot, apps, rendererErrors, url) {
  const { alice, bob, canvasId, layerId } = await prepareRoom(url);
  const aliceWindow = await launchIsolated(tempRoot, apps, rendererErrors, 'Alice');
  const alicePackets = await enterRoom(aliceWindow, url, alice, canvasId);
  const alicePage = aliceWindow.page;
  const bobWindow = await launchIsolated(tempRoot, apps, rendererErrors, 'Bob');
  const bobPackets = await enterRoom(bobWindow, url, bob, canvasId);
  const bobPage = bobWindow.page;
  let bobNavigated = false;
  bobPage.on('framenavigated', (frame) => {
    if (frame === bobPage.mainFrame()) bobNavigated = true;
  });

  const alicePaper = await openPaper(alicePage);
  await expectPressed(alicePaper.getByRole('button', { name: 'Sync to room', exact: true }), true);
  const startedAt = performance.now();
  const deadline = startedAt + roomUpdateTimeout;
  await alicePaper.getByRole('button', { name: '#FAF6EE', exact: true }).click({ timeout: roomUpdateTimeout });
  await Promise.all([
    waitForRoomPacket(bobPackets, ({ event, data, receivedAt }) => receivedAt >= startedAt &&
      event === 'canvas_updated' && data.canvasId === canvasId && data.bgColor === '#FAF6EE' && data.byUser === alice.user.id,
    deadline, 'Bob did not receive Alice’s canvas_updated paper color for the room within 5 seconds'),
    expectPaper(bobPage, '#FAF6EE', Math.max(1, deadline - performance.now())),
  ]);
  await expectPaper(alicePage, '#FAF6EE');
  assert.equal(bobNavigated, false, 'Bob should render the room paper update without a navigation');
  await closePopover(alicePage, alicePaper);

  const bobPaper = await openPaper(bobPage);
  await bobPaper.getByRole('button', { name: '#262626', exact: true }).click();
  await expectPaper(bobPage, '#262626');
  await closePopover(bobPage, bobPaper);
  const reset = paperRow(bobPage).getByTestId('layer-paper-reset-local');
  await reset.waitFor();
  await expectPaper(alicePage, '#FAF6EE');
  await reset.click();
  await expectPaper(bobPage, '#FAF6EE');
  await reset.waitFor({ state: 'hidden' });

  for (const page of [alicePage, bobPage]) {
    const row = layerRows(page).and(page.locator(`[data-layer-id=${JSON.stringify(layerId)}]`));
    await row.click();
    await row.and(selectedLayer(page)).waitFor();
    await expectPressed(page.getByTestId('layer-display-color-btn'), false);
  }
  const bobTint = bobPage.getByTestId('layer-display-color-btn');
  await bobTint.click();
  await expectPressed(bobTint, true);
  await expectPressed(alicePage.getByTestId('layer-display-color-btn'), false);
  await expectPaper(alicePage, '#FAF6EE');
  assert.ok(!alicePackets.some(({ event, data }) =>
    event === 'canvas_updated' && data.canvasId === canvasId && data.byUser === bob.user.id),
  'Bob’s local preview must not publish a room paper update');
  console.log('Room paper Socket.IO sync, Bob’s local paper reset, and Bob’s local tint verified');
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
  if (failures.length) throw new AggregateError(failures, 'V15 PHASE 1 LAYER COLORS ELECTRON SMOKE FAILED');
  console.log('V15 PHASE 1 LAYER COLORS ELECTRON SMOKE PASSED (0 console errors, 0 page errors)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

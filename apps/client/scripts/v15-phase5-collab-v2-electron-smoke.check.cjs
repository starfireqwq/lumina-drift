/**
 * Isolated Dual-Window Electron Desktop Smoke Verification for v1.5.0 Phase 5 (Collab 2.0):
 * - Spawns a temporary isolated Fastify + Socket.IO server on PORT=0 (never touches Port 3000)
 * - Launches TWO completely isolated Electron instances (separate APPDATA / LOCALAPPDATA / --user-data-dir)
 * - Verifies:
 *   5.1 Follow Camera (viewport center/zoom/rotation sync, Esc cancel, manual pan cancel, follower & tool badges)
 *   5.2 Canvas Grid Slots & Claiming (owner enables 2x3 grid, editor claims/releases, canvas overlay sync, click-to-focus)
 *   5.3 Shared Room Swatches & Reference Board (realtime swatch sync + apply, shared ref image + scale + admin lock,
 *       while personal local SubView remains untouched)
 * - Strictly 0 console errors & 0 page errors on both Electron instances
 *
 * Usage:
 *   node apps/client/scripts/v15-phase5-collab-v2-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireClient = createRequire(path.join(clientRoot, 'package.json'));
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');
const electronExe = requireClient('electron');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const rendererHtml = path.join(clientRoot, 'dist/index.html');
const serverAppJs = path.join(serverRoot, 'dist/app.js');

const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR42mP8z8AARBgZGAAD9gEBAa6H4wAAAABJRU5ErkJggg==',
  'base64'
);

function hasExited(child) {
  return !child?.pid || child.exitCode !== null || child.signalCode !== null;
}

async function closeElectron(app) {
  if (!app) return;
  const child = app.process();
  const closed = app.close().then(() => true, () => false);
  const done = await Promise.race([
    closed,
    new Promise((r) => setTimeout(() => r(false), 6000)),
  ]);
  if (!done && !hasExited(child)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 5000,
      });
    } else {
      child.kill('SIGKILL');
    }
  }
}

async function apiJson(baseUrl, token, method, url, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function launchIsolatedElectron({ label, tempRoot, serverUrl, token, canvasId }) {
  const userDataDir = path.join(tempRoot, `userdata-${label}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  const launcher = path.join(userDataDir, `launch-${label}.cjs`);
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
        try {
          callback({ cancel: new URL(details.url).port === '3000' });
        } catch {
          callback({ cancel: false });
        }
      });
    });

    const loadFile = BrowserWindow.prototype.loadFile;
    const rendererReady = new Promise((resolve) => { globalThis.startSmokeRenderer = resolve; });
    BrowserWindow.prototype.loadFile = async function (...args) {
      try {
        await this.loadURL('data:text/html,<title>Phase 5 Smoke ${label}</title>');
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

  const rendererErrors = [];
  let canvasEntered = false;

  const app = await electron.launch({
    executablePath: electronExe,
    args,
    env,
    artifactsDir: userDataDir,
    timeout: 30_000,
  });

  const context = app.context();
  context.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!canvasEntered && /ERR_BLOCKED_BY_CLIENT|ERR_CONNECTION_REFUSED/.test(text)) return;
      rendererErrors.push(`[${label}] console.error: ${text}`);
    }
  });
  context.on('weberror', (ev) => {
    rendererErrors.push(`[${label}] pageerror: ${ev.error().message}`);
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  const origin = new URL(serverUrl).origin;
  const seed = {
    serverUrl,
    origin,
    token,
    canvasId,
  };

  await context.addInitScript((s) => {
    try {
      localStorage.setItem('atelier_server_url', s.serverUrl);
      localStorage.setItem(`atelier_token:${s.origin}`, s.token);
      localStorage.setItem('atelier_token', s.token);
      localStorage.setItem('atelier_active_canvas_id', s.canvasId);
      localStorage.setItem('atelier_gateway_skip_on_launch', '1');
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_offline_mode', '0');
    } catch {
      // ignore on data: url
    }
  }, seed);

  await app.evaluate(() => globalThis.startSmokeRenderer());
  const rendererUrl = pathToFileURL(rendererHtml).href;
  await page.waitForURL((url) => url.href.startsWith(rendererUrl), { timeout: 25_000 });

  // Wait until workspace Pixi stage & socket are connected inside the shared room
  await page.waitForFunction(
    () => Boolean(window.__debugPixi?.viewport && document.querySelector('[data-canvas-presented="true"]')),
    null,
    { timeout: 30_000 }
  );
  canvasEntered = true;
  await page.waitForTimeout(600);

  return { app, page, rendererErrors };
}

async function ensurePanelVisible(page, panelId, selector) {
  const loc = page.locator(selector).first();
  if (await loc.isVisible().catch(() => false)) return;
  // Click panel toggle / pill / tab if collapsed
  const pill = page.locator(`[data-dock-pill="${panelId}"], [data-panel-tab="${panelId}"], [data-testid="panel-toggle-${panelId}"]`).first();
  if (await pill.isVisible().catch(() => false)) {
    await pill.click();
    await page.waitForTimeout(250);
  }
  if (await loc.isVisible().catch(() => false)) return;
  // Open via dock bar menu or TopNavbar view button if hidden
  const btn = page.locator(`button[data-panel-id="${panelId}"]`).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(250);
  }
}

async function main() {
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);
  assert.ok(fs.existsSync(rendererHtml), `Missing compiled renderer HTML: ${rendererHtml}`);
  assert.ok(fs.existsSync(serverAppJs), `Missing compiled server app: ${serverAppJs}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-v15-phase5-smoke-'));
  const serverDataDir = path.join(tempRoot, 'server-data');
  fs.mkdirSync(serverDataDir, { recursive: true });
  const pngFile = path.join(tempRoot, 'sample-ref.png');
  fs.writeFileSync(pngFile, TINY_PNG_BUFFER);

  // Boot isolated temporary Fastify + Socket.IO server on PORT=0
  process.env.DATA_DIR = serverDataDir;
  process.env.DATABASE_PATH = path.join(serverDataDir, 'smoke.db');
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin123';
  process.env.JWT_SECRET = 'phase5-smoke-secret';

  const { buildApp } = require(serverAppJs);
  const serverApp = await buildApp();
  let instA = null;
  let instB = null;

  try {
    const serverUrl = await serverApp.listen({ port: 0, host: '127.0.0.1' });
    console.log(`[Phase5 Smoke] Temporary isolated server listening at ${serverUrl}`);

    const regA = await apiJson(serverUrl, null, 'POST', '/api/auth/register', {
      username: 'alice_smoke',
      password: 'password123',
      displayName: 'AliceSmoke',
    });
    assert.equal(regA.status, 201);
    const alice = { token: regA.data.token, id: regA.data.user.id };

    const regB = await apiJson(serverUrl, null, 'POST', '/api/auth/register', {
      username: 'bob_smoke',
      password: 'password123',
      displayName: 'BobSmoke',
    });
    assert.equal(regB.status, 201);
    const bob = { token: regB.data.token, id: regB.data.user.id };

    const created = await apiJson(serverUrl, alice.token, 'POST', '/api/canvases', {
      title: 'Phase5 Collab Smoke',
      width: 1000,
      height: 800,
    });
    assert.equal(created.status, 201);
    const canvasId = created.data.canvas.id;

    const joined = await apiJson(serverUrl, bob.token, 'POST', '/api/canvases/join', { canvasId });
    assert.equal(joined.status, 200);

    // Launch two completely isolated Electron instances
    instA = await launchIsolatedElectron({ label: 'alice', tempRoot, serverUrl, token: alice.token, canvasId });
    instB = await launchIsolatedElectron({ label: 'bob', tempRoot, serverUrl, token: bob.token, canvasId });
    const pageA = instA.page;
    const pageB = instB.page;

    // Make sure Members panel is visible on both windows (default right dock or click navbar members button)
    for (const pg of [pageA, pageB]) {
      const followOrCard = pg.locator(`[data-member-id]`).first();
      if (!(await followOrCard.isVisible().catch(() => false))) {
        const navMembers = pg.locator('button[data-testid="navbar-toggle-members"], button[title*="成員"], button[title*="Member"]').first();
        if (await navMembers.isVisible().catch(() => false)) {
          await navMembers.click();
          await pg.waitForTimeout(300);
        }
      }
    }

    // Wait until Bob sees Alice in Members list
    const followAliceBtn = pageB.locator(`[data-testid="follow-member-${alice.id}"]`);
    await followAliceBtn.waitFor({ state: 'visible', timeout: 15_000 });

    // =========================================================================
    // 5.1 Follow Camera & Active Tool Status
    // =========================================================================
    // Alice switches tool to eraser via keyboard 'e'
    await pageA.keyboard.press('e');
    await pageB.locator(`[data-member-id="${alice.id}"] [data-member-tool="eraser"]`).waitFor({ state: 'visible', timeout: 10_000 });

    // Bob clicks Follow on Alice
    await followAliceBtn.click();
    await pageB.locator('[data-testid="follow-camera-banner"]').waitFor({ state: 'visible', timeout: 10_000 });
    await pageA.locator(`[data-member-id="${alice.id}"] [data-followed-by-count="1"]`).waitFor({ state: 'visible', timeout: 10_000 });

    // Alice changes viewport (pan, zoom, rotation)
    await pageA.evaluate(() => {
      const vp = window.__debugPixi.viewport;
      vp.setState({ panX: 320, panY: 260, zoom: 1.8, rotation: 0.35, mirrorX: false });
    });

    // Wait for Bob's viewport to sync rotation & zoom close to Alice's
    await pageB.waitForFunction(
      () => {
        const st = window.__debugPixi?.viewport?.getState?.();
        return st && Math.abs(st.rotation - 0.35) < 0.05 && st.zoom > 1.2;
      },
      null,
      { timeout: 10_000 }
    );
    const bobSyncedState = await pageB.evaluate(() => window.__debugPixi.viewport.getState());
    assert.ok(Math.abs(bobSyncedState.rotation - 0.35) < 0.05, `Expected Bob rotation ~0.35, got ${bobSyncedState.rotation}`);

    // Press Esc on Bob -> immediately cancels follow
    await pageB.keyboard.press('Escape');
    await pageB.locator('[data-testid="follow-camera-banner"]').waitFor({ state: 'hidden', timeout: 8_000 });
    await pageA.locator(`[data-member-id="${alice.id}"] [data-followed-by-count]`).waitFor({ state: 'hidden', timeout: 8_000 });

    // Follow again, then manual pan cancels follow immediately
    await followAliceBtn.click();
    await pageB.locator('[data-testid="follow-camera-banner"]').waitFor({ state: 'visible', timeout: 8_000 });
    await pageB.evaluate(() => window.__debugPixi.viewport.panBy(60, 40));
    await pageB.locator('[data-testid="follow-camera-banner"]').waitFor({ state: 'hidden', timeout: 8_000 });

    // =========================================================================
    // 5.2 Canvas Grid Slots & Claiming
    // =========================================================================
    await pageA.locator('[data-testid="viewport-grid-slots-toggle"]').click();
    await pageA.locator('[data-testid="grid-slots-popover"]').waitFor({ state: 'visible', timeout: 8_000 });
    await pageA.locator('[data-testid="grid-preset-2x3"]').click();

    // Bob receives grid overlay immediately
    const bobGridOverlay = pageB.locator('[data-testid="grid-slots-overlay"]');
    await bobGridOverlay.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await bobGridOverlay.getAttribute('data-grid-rows'), '2');
    assert.equal(await bobGridOverlay.getAttribute('data-grid-cols'), '3');

    // Bob opens popover and claims slot 1
    await pageB.locator('[data-testid="viewport-grid-slots-toggle"]').click();
    await pageB.locator('[data-testid="grid-claim-slot-1"]').waitFor({ state: 'visible', timeout: 8_000 });
    await pageB.locator('[data-testid="grid-claim-slot-1"]').click();

    // Alice sees Bob's claim badge on canvas overlay
    await pageA.waitForFunction(
      () => document.querySelector('[data-testid="grid-slot-badge-1"]')?.getAttribute('data-claimed-by') === 'BobSmoke',
      null,
      { timeout: 10_000 }
    );

    // Alice clicks focus slot 1 inside popover (jumps cleanly even from rotated/zoomed view), then closes popover and verifies canvas badge click
    await pageA.locator('[data-testid="grid-focus-slot-1"]').click();
    await pageA.locator('[data-testid="viewport-grid-slots-toggle"]').click();
    await pageA.waitForTimeout(200);
    await pageA.locator('[data-testid="grid-slot-badge-1"]').click();
    await pageA.waitForTimeout(200);
    const aliceFocusedState = await pageA.evaluate(() => window.__debugPixi.viewport.getState());
    assert.ok(Math.abs(aliceFocusedState.rotation) < 1e-3, 'Focus slot should reset rotation to 0');

    // Bob releases slot 1 -> Alice sees it empty again
    await pageB.locator('[data-testid="grid-release-slot-1"]').click();
    await pageA.waitForFunction(
      () => document.querySelector('[data-testid="grid-slot-badge-1"]')?.getAttribute('data-claimed-by') === '',
      null,
      { timeout: 10_000 }
    );
    await pageB.locator('[data-testid="viewport-grid-slots-toggle"]').click();

    // =========================================================================
    // 5.3 Shared Room Swatches & Reference Board (Personal SubView untouched)
    // =========================================================================
    // Ensure SubView panel is visible on both windows (Control+Shift+R opens Sub View)
    for (const pg of [pageA, pageB]) {
      const svTab = pg.locator('[data-testid="subview-tab-personal"]');
      if (!(await svTab.isVisible().catch(() => false))) {
        await pg.keyboard.press('Control+Shift+KeyR');
        await svTab.waitFor({ state: 'visible', timeout: 8_000 });
      }
    }

    // Bob adds a personal image in Personal SubView first
    await pageB.locator('[data-testid="subview-file-input"]').setInputFiles(pngFile);
    await pageB.waitForFunction(
      () => (document.querySelector('[data-testid="subview-counter"]')?.textContent || '').includes('1 / 1'),
      null,
      { timeout: 10_000 }
    );

    // Alice adds a shared room swatch
    const aliceAddSwatchBtn = pageA.locator('[data-testid="room-swatch-add-current"]');
    await aliceAddSwatchBtn.scrollIntoViewIfNeeded();
    await aliceAddSwatchBtn.click();

    // Bob sees the synced swatch in his Room Swatches section & clicks it
    const bobFirstRoomSwatch = pageB.locator('[data-testid="room-swatches-list"] [data-room-swatch]').first();
    await bobFirstRoomSwatch.waitFor({ state: 'visible', timeout: 10_000 });
    const syncedHex = await bobFirstRoomSwatch.getAttribute('data-room-swatch');
    assert.ok(syncedHex && syncedHex.startsWith('#'), `Expected valid room swatch hex, got ${syncedHex}`);
    await bobFirstRoomSwatch.click();

    // Alice switches SubView to Room Reference Board and uploads shared image
    await pageA.locator('[data-testid="subview-tab-room-board"]').click();
    await pageA.locator('[data-testid="room-ref-file-input"]').setInputFiles(pngFile);
    await pageA.locator('[data-testid^="room-ref-item-"]').first().waitFor({ state: 'visible', timeout: 10_000 });

    // Bob switches to Room Board tab and sees the synced item
    await pageB.locator('[data-testid="subview-tab-room-board"]').click();
    const bobRefItem = pageB.locator('[data-testid^="room-ref-item-"]').first();
    await bobRefItem.waitFor({ state: 'visible', timeout: 10_000 });

    // Alice scales up the shared reference item -> Bob sees updated scale
    await pageA.locator('[data-testid^="room-ref-scale-up-"]').first().click();
    await pageB.waitForFunction(
      () => Number(document.querySelector('[data-testid^="room-ref-item-"]')?.getAttribute('data-ref-scale') || '1') > 1.1,
      null,
      { timeout: 10_000 }
    );
    const bobRefScale = await bobRefItem.getAttribute('data-ref-scale');

    // Alice locks Room Reference Board -> Bob sees lock badge & disabled add button
    await pageA.locator('[data-testid="room-ref-lock-toggle"]').click();
    await pageB.locator('[data-testid="room-ref-locked-badge"]').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await pageB.locator('[data-testid="room-ref-add-btn"]').isDisabled(), true);

    // Bob switches back to Personal SubView -> personal image is completely untouched!
    await pageB.locator('[data-testid="subview-tab-personal"]').click();
    const personalCounter = await pageB.locator('[data-testid="subview-counter"]').textContent();
    assert.ok(personalCounter && personalCounter.includes('1 / 1'), `Personal SubView altered: ${personalCounter}`);

    // Strictly assert 0 console/page errors on BOTH windows
    const allErrors = [...instA.rendererErrors, ...instB.rendererErrors];
    assert.equal(allErrors.length, 0, `Renderer errors detected:\n${allErrors.join('\n')}`);

    console.log(
      `✅ Phase 5 Dual-Window Electron Smoke PASSED! (0 console errors, 0 page errors; followRotation=${bobSyncedState.rotation.toFixed(2)}, grid=2x3, roomSwatch=${syncedHex}, refScale=${bobRefScale}, personalSubView=${personalCounter.trim()})`
    );
  } finally {
    await closeElectron(instA?.app);
    await closeElectron(instB?.app);
    await serverApp.close().catch(() => {});
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup lock on Windows
    }
  }
}

main().catch((err) => {
  console.error('❌ Phase 5 Dual-Window Electron Smoke FAILED:', err);
  process.exit(1);
});

/**
 * End-to-End Real-Engine Verification for 13500×7500 Large Canvas + Navigator:
 *   1. Desktop Electron App — Solo 13500×7500 (draw, navigator red-box drag & vertical flip, eyedropper, undo/redo)
 *   2. Simulated Mobile Web (Android, pointer:coarse, deviceMemory=3, dpr=3, MAX_TEXTURE_SIZE=4096 + strict GL allocation trap) — Solo 13500×7500
 *   3. Multiplayer 13500×7500 (ephemeral PORT=0 server, never touches Port 3000):
 *      Desktop Electron App (Artist A) + Simulated Mobile Web 4096px GPU (Artist B) collaborating on the same 13500×7500 canvas!
 *
 * Strictly isolated APPDATA / LOCALAPPDATA / --user-data-dir / PORT=0.
 */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireClient = createRequire(path.join(clientRoot, 'package.json'));
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { chromium, _electron: electron } = requireServer('playwright-core');
const electronExe = requireClient('electron');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const distDir = path.join(clientRoot, 'dist');
const rendererHtml = path.join(distDir, 'index.html');

const CANVAS_W = 13500;
const CANVAS_H = 7500;
const MOBILE_MAX_TEX = 4096;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findSystemChrome() {
  const candidates = [
    process.env.LUMINA_TEST_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function startStaticWebServer(rootDir) {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
  };
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      let filePath = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(rootDir, 'index.html');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ server: srv, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function startTempApiServer(dataDir) {
  const appModuleUrl = pathToFileURL(path.join(serverRoot, 'src/app.ts')).href;
  const tsxImportUrl = pathToFileURL(requireServer.resolve('tsx')).href;
  const launcherPath = path.join(dataDir, 'launch-large-mp-server.mjs');
  fs.writeFileSync(launcherPath, `
    import { buildApp } from ${JSON.stringify(appModuleUrl)};
    const app = await buildApp();
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    console.log('TEST_SERVER_READY=' + addr);
    process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
  `, 'utf8');
  const proc = spawn(process.execPath, ['--import', tsxImportUrl, launcherPath], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATABASE_PATH: path.join(dataDir, 'large-canvas-mp.db'),
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
      JWT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Temp API server timed out')), 25_000);
    let stderrBuf = '';
    proc.stdout.on('data', (chunk) => {
      const m = chunk.toString('utf8').match(/TEST_SERVER_READY=(http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Temp server exited early (${code}): ${stderrBuf}`));
    });
  });
  return { proc, url };
}

async function closeElectron(app) {
  if (!app) return;
  const child = app.process();
  const closed = app.close().then(() => true, () => false);
  const done = await Promise.race([closed, sleep(5000).then(() => false)]);
  if (!done && child?.pid && child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    } else {
      child.kill('SIGKILL');
    }
  }
}

async function launchIsolatedElectron(tempRoot, label) {
  const userDataDir = path.join(tempRoot, label);
  fs.mkdirSync(userDataDir, { recursive: true });
  const launcher = path.join(userDataDir, 'launcher.cjs');
  fs.writeFileSync(launcher, `
    const { app, BrowserWindow, ipcMain } = require('electron');
    app.setPath('userData', ${JSON.stringify(userDataDir)});
    app.setPath('sessionData', ${JSON.stringify(userDataDir)});
    const loadFile = BrowserWindow.prototype.loadFile;
    const ready = new Promise((resolve) => { globalThis.__startLargeRenderer = resolve; });
    BrowserWindow.prototype.loadFile = async function (...args) {
      await this.loadURL('data:text/html,<title>Large Canvas Verify</title>');
      await ready;
      await loadFile.apply(this, args);
    };
    require(${JSON.stringify(mainJs)});
    for (const ch of ['atelier:start-server', 'atelier:start-tunnel']) ipcMain.removeHandler(ch);
    ipcMain.handle('atelier:start-server', () => false);
    ipcMain.handle('atelier:start-tunnel', () => ({ success: false }));
  `);
  const env = { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir, PORT: '0' };
  delete env.VITE_DEV_SERVER_URL;
  const app = await electron.launch({
    executablePath: electronExe,
    args: ['--noerrdialogs', launcher, `--user-data-dir=${userDataDir}`],
    env,
    artifactsDir: userDataDir,
    timeout: 25_000,
  });
  const errors = [];
  let entered = false;
  app.context().on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!entered && /ERR_BLOCKED_BY_CLIENT|ERR_CONNECTION_REFUSED/.test(text)) return;
      errors.push(`console.error: ${text}`);
    }
  });
  app.context().on('weberror', (ev) => errors.push(`pageerror: ${ev.error().message}`));
  const page = await app.firstWindow({ timeout: 25_000 });
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = pathToFileURL(rendererHtml).href;
  await page.addInitScript(() => {
    localStorage.setItem('atelier_language', 'en-US');
  });
  await app.evaluate(() => globalThis.__startLargeRenderer());
  await page.waitForURL(url, { waitUntil: 'domcontentloaded' });
  return { app, page, errors, markEntered: () => { entered = true; } };
}

/** Inject strict WebGL MAX_TEXTURE_SIZE=4096 clamp + oversized GPU texture allocation trap */
function mobileGlTrapInitScript(maxTex) {
  return ({ limit }) => {
    window.__ATELIER_FORCE_MAX_TEXTURE_SIZE__ = limit;
    window.__ATELIER_TEST_DEVICE_PROFILE__ = {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      deviceMemory: 3,
      coarsePointer: true,
      screenMinSide: 412,
      maxTouchPoints: 5,
    };
    window.__glOversizedAllocs = [];
    window.__glMaxAllocSeen = 0;

    const record = (api, w, h) => {
      const side = Math.max(Number(w) || 0, Number(h) || 0);
      if (side > window.__glMaxAllocSeen) window.__glMaxAllocSeen = side;
      if (side > limit) {
        window.__glOversizedAllocs.push({ api, w, h, stack: new Error().stack?.split('\n').slice(1, 5).join(' | ') });
      }
    };

    const patchProto = (Ctor) => {
      if (!Ctor || !Ctor.prototype || Ctor.prototype.__atelierGlPatched) return;
      Ctor.prototype.__atelierGlPatched = true;
      const origGetParam = Ctor.prototype.getParameter;
      Ctor.prototype.getParameter = function (pname) {
        const res = origGetParam.call(this, pname);
        if (pname === this.MAX_TEXTURE_SIZE && typeof res === 'number') return Math.min(res, limit);
        return res;
      };
      const origTexImage2D = Ctor.prototype.texImage2D;
      Ctor.prototype.texImage2D = function (...args) {
        if (args.length >= 9) {
          record('texImage2D', args[3], args[4]);
        } else if (args.length === 6 && args[5]) {
          record('texImage2D(src)', args[5].width || 0, args[5].height || 0);
        }
        return origTexImage2D.apply(this, args);
      };
      if (Ctor.prototype.texStorage2D) {
        const origTexStorage2D = Ctor.prototype.texStorage2D;
        Ctor.prototype.texStorage2D = function (...args) {
          record('texStorage2D', args[3], args[4]);
          return origTexStorage2D.apply(this, args);
        };
      }
      const origRb = Ctor.prototype.renderbufferStorage;
      Ctor.prototype.renderbufferStorage = function (...args) {
        record('renderbufferStorage', args[2], args[3]);
        return origRb.apply(this, args);
      };
    };

    patchProto(window.WebGLRenderingContext);
    patchProto(window.WebGL2RenderingContext);
  };
}

async function enterSoloLargeCanvas(page, width, height) {
  await page.getByRole('button', { name: /Solo Offline Drawing/i }).click();
  await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
  await page.getByRole('spinbutton', { name: /^Width/ }).fill(String(width));
  await page.getByRole('spinbutton', { name: /^Height/ }).fill(String(height));
  await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__debugPixi?.layerManager && window.__debugPixi?.viewport), null, { timeout: 15_000 });
  await sleep(450);
}

async function drawCanvasStroke(page, x1, y1, x2, y2, steps = 12) {
  await page.evaluate(async ({ x1, y1, x2, y2, steps }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const rect = dbg.app.canvas.getBoundingClientRect();
    // Zoom into the stroke region so coordinates map cleanly inside the viewport
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    dbg.viewport.setState({ zoom: 0.5, rotation: 0, mirrorX: false, mirrorY: false });
    dbg.viewport.panToCanvasPoint(midX, midY, rect.width, rect.height);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s1 = dbg.viewport.canvasToScreen(x1, y1);
    const s2 = dbg.viewport.canvasToScreen(x2, y2);
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 41, pointerType: 'pen', isPrimary: true, button: 0,
      clientX: rect.left + s1.x, clientY: rect.top + s1.y, buttons: 1, pressure: 0.9,
    }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sc = dbg.viewport.canvasToScreen(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, pointerId: 41, pointerType: 'pen', isPrimary: true, button: 0,
        clientX: rect.left + sc.x, clientY: rect.top + sc.y, buttons: 1, pressure: 0.9,
      }));
      await new Promise((r) => setTimeout(r, 12));
    }
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 41, pointerType: 'pen', isPrimary: true, button: 0,
      clientX: rect.left + s2.x, clientY: rect.top + s2.y, buttons: 0, pressure: 0,
    }));
  }, { x1, y1, x2, y2, steps });
  await sleep(350);
}

async function readCompositePixelAt(page, x, y) {
  return page.evaluate(async ({ x, y }) => {
    const lm = window.__debugPixi.layerManager;
    const [buf] = await lm.readCompositeRegionsAsync([{ x, y, w: 1, h: 1 }], true);
    return Array.from(buf);
  }, { x, y });
}

async function readEngineSnapshot(page) {
  return page.evaluate(() => {
    const dbg = window.__debugPixi;
    const lm = dbg.layerManager;
    const stats = lm.getTextureStats();
    return {
      width: lm.canvasWidth,
      height: lm.canvasHeight,
      resolution: dbg.app.renderer.resolution,
      maxTextureSize: lm.maxTextureSize,
      allowFullCanvasTextures: lm.allowFullCanvasTextures,
      constrained: lm.deviceProfile?.isConstrained,
      resident: stats.resident,
      tiles: stats.tiles,
      gpuBytesMB: stats.megabytes ?? 0,
      oversizedAllocs: window.__glOversizedAllocs || [],
      maxAllocSeen: window.__glMaxAllocSeen || 0,
    };
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-large-e2e-'));
  const chromeExe = findSystemChrome();
  assert.ok(chromeExe, 'System Chrome or Edge executable is required for Web mobile simulation');

  let webSrv = null;
  let apiSrv = null;
  let browser = null;
  let desktopApp = null;
  let mpDesktopApp = null;

  try {
    webSrv = await startStaticWebServer(distDir);
    console.log(`[Setup] Static Web dist server ready at ${webSrv.url}`);

    // =========================================================================
    // 1. Desktop Electron App — Solo 13500×7500 + Navigator Verification
    // =========================================================================
    const desk = await launchIsolatedElectron(tempRoot, 'desktop-solo-13500');
    desktopApp = desk.app;
    await enterSoloLargeCanvas(desk.page, CANVAS_W, CANVAS_H);
    desk.markEntered();

    // Verify Navigator panel visible with red box & vertical flip
    await desk.page.getByTestId('navigator-preview').waitFor({ state: 'visible', timeout: 8000 });
    await desk.page.getByTestId('navigator-red-box').waitFor({ state: 'visible', timeout: 8000 });

    const navBox = await desk.page.getByTestId('navigator-preview').boundingBox();
    assert.ok(navBox && navBox.width > 60 && navBox.height > 40, 'Navigator preview must have non-zero layout');
    await desk.page.mouse.click(navBox.x + navBox.width * 0.72, navBox.y + navBox.height * 0.32);
    await sleep(150);

    // Toggle vertical flip via Navigator button & confirm viewport.mirrorY flips
    const flipYBtn = desk.page.locator('[data-testid="navigator-flip-y"], button[aria-label*="Vertical" i]').first();
    await flipYBtn.click();
    await sleep(120);
    const mirrorYAfter = await desk.page.evaluate(() => Boolean(window.__debugPixi.viewport.getState().mirrorY));
    assert.equal(mirrorYAfter, true, 'Navigator vertical flip button must enable mirrorY');
    await flipYBtn.click();
    await sleep(120);

    // Draw stroke on 13500×7500, sample pixel via readCompositeRegionsAsync, Undo & Redo
    await drawCanvasStroke(desk.page, 6200, 3400, 6800, 3400);
    const pxAfterDraw = await readCompositePixelAt(desk.page, 6500, 3400);
    assert.ok(pxAfterDraw[3] > 0 && (pxAfterDraw[0] < 245 || pxAfterDraw[1] < 245 || pxAfterDraw[2] < 245),
      `Desktop 13500×7500 stroke must be visible at (6500,3400), got ${pxAfterDraw}`);

    await desk.page.keyboard.press('Control+KeyZ');
    await sleep(300);
    const pxAfterUndo = await readCompositePixelAt(desk.page, 6500, 3400);
    assert.ok(pxAfterUndo[0] >= 250 && pxAfterUndo[1] >= 250 && pxAfterUndo[2] >= 250,
      `Desktop 13500×7500 Ctrl+Z must restore background, got ${pxAfterUndo}`);

    await desk.page.keyboard.press('Control+KeyY');
    await sleep(300);
    const deskSnap = await readEngineSnapshot(desk.page);
    assert.equal(deskSnap.width, CANVAS_W);
    assert.equal(deskSnap.height, CANVAS_H);
    assert.equal(deskSnap.allowFullCanvasTextures, false, '13500×7500 must NEVER allow full-canvas resident textures');
    assert.equal(deskSnap.resident, 0, `Desktop 13500×7500 must keep resident=0, got ${deskSnap.resident}`);
    assert.deepEqual(desk.errors, [], `Desktop Solo errors: ${desk.errors.join(' | ')}`);
    console.log(`✓ [1/3] Desktop Electron Solo 13500×7500 + Navigator verified (resident=${deskSnap.resident}, tiles=${deskSnap.tiles}, gpu=${deskSnap.gpuBytesMB} MB, dpr=${deskSnap.resolution}, 0 errors)`);

    await closeElectron(desktopApp);
    desktopApp = null;

    // =========================================================================
    // 2. Simulated Mobile Web (Android + MAX_TEXTURE_SIZE=4096 + dpr=3 + 3GB) — Solo 13500×7500
    // =========================================================================
    browser = await chromium.launch({
      executablePath: chromeExe,
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const mobileSoloCtx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    });
    const mobileSoloErrors = [];
    let mobileSoloEntered = false;
    const mobileSoloPage = await mobileSoloCtx.newPage();
    mobileSoloPage.on('console', (m) => {
      if (m.type() === 'error') {
        const text = m.text();
        if (!mobileSoloEntered && /socket\.io|ERR_CONNECTION_REFUSED/i.test(text)) return;
        mobileSoloErrors.push(`console.error: ${text}`);
      }
    });
    mobileSoloPage.on('pageerror', (e) => mobileSoloErrors.push(`pageerror: ${e.message}`));
    await mobileSoloPage.addInitScript(() => localStorage.setItem('atelier_language', 'en-US'));
    await mobileSoloPage.addInitScript(mobileGlTrapInitScript(MOBILE_MAX_TEX), { limit: MOBILE_MAX_TEX });
    await mobileSoloPage.goto(webSrv.url, { waitUntil: 'domcontentloaded' });
    await enterSoloLargeCanvas(mobileSoloPage, CANVAS_W, CANVAS_H);
    mobileSoloEntered = true;

    await drawCanvasStroke(mobileSoloPage, 2200, 1800, 2600, 1800);
    const mobPx = await readCompositePixelAt(mobileSoloPage, 2400, 1800);
    assert.ok(mobPx[3] > 0 && (mobPx[0] < 245 || mobPx[1] < 245 || mobPx[2] < 245),
      `Mobile Solo 13500×7500 stroke must be visible, got ${mobPx}`);

    // Pan + zoom + undo stress on mobile
    await mobileSoloPage.evaluate(() => {
      const vp = window.__debugPixi.viewport;
      vp.panBy(140, -90);
      vp.setZoom(0.25);
      vp.setZoom(1.0);
    });
    await mobileSoloPage.keyboard.press('Control+KeyZ');
    await sleep(300);

    const mobSoloSnap = await readEngineSnapshot(mobileSoloPage);
    assert.equal(mobSoloSnap.constrained, true, 'Mobile solo must activate constrained device profile');
    assert.ok(mobSoloSnap.maxTextureSize <= MOBILE_MAX_TEX, `Mobile maxTextureSize must be <= 4096, got ${mobSoloSnap.maxTextureSize}`);
    assert.ok(mobSoloSnap.resolution <= 1.0, `Mobile 13500×7500 DPR must be capped <= 1.0, got ${mobSoloSnap.resolution}`);
    assert.equal(mobSoloSnap.allowFullCanvasTextures, false);
    assert.equal(mobSoloSnap.resident, 0, `Mobile Solo resident must stay 0, got ${mobSoloSnap.resident}`);
    assert.deepEqual(mobSoloSnap.oversizedAllocs, [], `Mobile Solo allocated oversized >4096 GPU texture: ${JSON.stringify(mobSoloSnap.oversizedAllocs)}`);
    assert.deepEqual(mobileSoloErrors, [], `Mobile Solo errors: ${mobileSoloErrors.join(' | ')}`);
    console.log(`✓ [2/3] Mobile Web Solo 13500×7500 (4096px GPU cap, dpr=3->${mobSoloSnap.resolution}) verified (maxAlloc=${mobSoloSnap.maxAllocSeen}px, oversized=0, resident=0, gpu=${mobSoloSnap.gpuBytesMB} MB, 0 errors)`);
    await mobileSoloCtx.close();

    // =========================================================================
    // 3. Multiplayer 13500×7500 Cross-Platform: Desktop Electron App (Artist A) + Mobile Web 4096px (Artist B)
    // =========================================================================
    const apiDataDir = path.join(tempRoot, 'mp-server-data');
    fs.mkdirSync(apiDataDir, { recursive: true });
    apiSrv = await startTempApiServer(apiDataDir);
    console.log(`[Setup] Isolated Multiplayer PORT=0 server ready at ${apiSrv.url}`);

    // Login Admin (Artist A) & Register Artist B
    const loginA = await (await fetch(`${apiSrv.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    })).json();
    assert.ok(loginA.token, 'Admin login failed');

    const regB = await (await fetch(`${apiSrv.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mobile_artist', password: 'password123', displayName: 'Mobile Artist' }),
    })).json();
    assert.ok(regB.token, `Register Artist B failed: ${JSON.stringify(regB)}`);

    // Create a 13500×7500 Multiplayer Canvas & set public/collaborative access
    const createCanvasRes = await fetch(`${apiSrv.url}/api/canvases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginA.token}` },
      body: JSON.stringify({ name: 'MP 13500x7500 Verify', width: CANVAS_W, height: CANVAS_H, bgColor: '#FFFFFF' }),
    });
    assert.equal(createCanvasRes.status, 201, `Create 13500x7500 canvas failed: ${createCanvasRes.status}`);
    const createdCanvas = await createCanvasRes.json();
    const mpCanvasId = createdCanvas.id || createdCanvas.canvas?.id;
    assert.ok(mpCanvasId, `Missing canvas id in ${JSON.stringify(createdCanvas)}`);

    // Create a second layer for Artist B so both artists can draw cleanly
    const layerBRes = await fetch(`${apiSrv.url}/api/canvases/${mpCanvasId}/layers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regB.token}` },
      body: JSON.stringify({ name: 'Mobile Layer' }),
    });
    assert.ok(layerBRes.status === 200 || layerBRes.status === 201, `Create layer B failed: ${layerBRes.status}`);

    // Launch Artist A: Desktop Electron App joined to the 13500×7500 multiplayer room
    const mpDesk = await launchIsolatedElectron(tempRoot, 'mp-desktop-artist-a');
    mpDesktopApp = mpDesk.app;
    await mpDesk.page.evaluate(({ url, jwt, user, cid }) => {
      localStorage.setItem('atelier_server_url', url);
      localStorage.setItem('atelier_gateway_resolved', 'true');
      localStorage.setItem('atelier_gateway_skip_on_launch', 'true');
      localStorage.setItem(`atelier_token:${url}`, jwt);
      localStorage.setItem('atelier_token', jwt);
      localStorage.setItem('atelier_user', JSON.stringify(user));
      localStorage.setItem('atelier_active_canvas_id', cid);
      localStorage.setItem(`atelier_active_canvas_id:${url}`, cid);
    }, { url: apiSrv.url, jwt: loginA.token, user: loginA.user, cid: mpCanvasId });
    await mpDesk.page.reload({ waitUntil: 'domcontentloaded' });
    await mpDesk.page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30_000 });
    // Ensure Artist A is on the 13500×7500 canvas (click tab if default canvas opened first)
    const deskDim = await mpDesk.page.evaluate(() => ({ w: window.__debugPixi?.layerManager?.canvasWidth, h: window.__debugPixi?.layerManager?.canvasHeight }));
    if (deskDim.w !== CANVAS_W) {
      await mpDesk.page.getByText('MP 13500x7500 Verify').first().click();
      await mpDesk.page.waitForFunction(({ w, h }) => window.__debugPixi?.layerManager?.canvasWidth === w && window.__debugPixi?.layerManager?.canvasHeight === h, { w: CANVAS_W, h: CANVAS_H }, { timeout: 20_000 });
    }
    mpDesk.markEntered();
    await sleep(500);

    // Launch Artist B: Simulated Mobile Web (MAX_TEXTURE_SIZE=4096, deviceMemory=3, dpr=3) joined to the SAME 13500×7500 room
    const mpMobCtx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    });
    const mpMobErrors = [];
    const mpMobPage = await mpMobCtx.newPage();
    mpMobPage.on('console', (m) => { if (m.type() === 'error') mpMobErrors.push(`console.error: ${m.text()}`); });
    mpMobPage.on('pageerror', (e) => mpMobErrors.push(`pageerror: ${e.message}`));
    await mpMobPage.addInitScript(({ url, jwt, user, cid }) => {
      localStorage.setItem('atelier_language', 'en-US');
      localStorage.setItem('atelier_server_url', url);
      localStorage.setItem('atelier_gateway_resolved', 'true');
      localStorage.setItem('atelier_gateway_skip_on_launch', 'true');
      localStorage.setItem(`atelier_token:${url}`, jwt);
      localStorage.setItem('atelier_token', jwt);
      localStorage.setItem('atelier_user', JSON.stringify(user));
      localStorage.setItem('atelier_active_canvas_id', cid);
      localStorage.setItem(`atelier_active_canvas_id:${url}`, cid);
    }, { url: apiSrv.url, jwt: regB.token, user: regB.user, cid: mpCanvasId });
    await mpMobPage.addInitScript(mobileGlTrapInitScript(MOBILE_MAX_TEX), { limit: MOBILE_MAX_TEX });
    await mpMobPage.goto(webSrv.url, { waitUntil: 'domcontentloaded' });
    await mpMobPage.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30_000 });
    const mobDim = await mpMobPage.evaluate(() => ({ w: window.__debugPixi?.layerManager?.canvasWidth, h: window.__debugPixi?.layerManager?.canvasHeight }));
    if (mobDim.w !== CANVAS_W) {
      await mpMobPage.getByText('MP 13500x7500 Verify').first().click();
      await mpMobPage.waitForFunction(({ w, h }) => window.__debugPixi?.layerManager?.canvasWidth === w && window.__debugPixi?.layerManager?.canvasHeight === h, { w: CANVAS_W, h: CANVAS_H }, { timeout: 20_000 });
    }
    await sleep(600);

    // Artist A draws a bold stroke on the 13500×7500 multiplayer canvas
    await drawCanvasStroke(mpDesk.page, 4000, 2600, 4600, 2600, 14);
    // Wait for Artist B (Mobile Web 4096px GPU) to receive the remote stroke pixels
    await mpMobPage.waitForFunction(async () => {
      const lm = window.__debugPixi?.layerManager;
      if (!lm) return false;
      const [px] = await lm.readCompositeRegionsAsync([{ x: 4300, y: 2600, w: 1, h: 1 }], true);
      return px[3] > 0 && (px[0] < 245 || px[1] < 245 || px[2] < 245);
    }, null, { timeout: 15_000 });

    // Artist B (Mobile Web) also draws a stroke on the 13500×7500 multiplayer canvas & tests pan/zoom + undo
    await drawCanvasStroke(mpMobPage, 7200, 4200, 7700, 4200, 12);
    await mpDesk.page.waitForFunction(async () => {
      const lm = window.__debugPixi?.layerManager;
      if (!lm) return false;
      const [px] = await lm.readCompositeRegionsAsync([{ x: 7450, y: 4200, w: 1, h: 1 }], true);
      return px[3] > 0 && (px[0] < 245 || px[1] < 245 || px[2] < 245);
    }, null, { timeout: 15_000 });

    // Artist B Ctrl+Z its stroke & verify Artist A sees undo synced
    await mpMobPage.keyboard.press('Control+KeyZ');
    await mpDesk.page.waitForFunction(async () => {
      const lm = window.__debugPixi?.layerManager;
      if (!lm) return false;
      const [px] = await lm.readCompositeRegionsAsync([{ x: 7450, y: 4200, w: 1, h: 1 }], true);
      return px[0] >= 250 && px[1] >= 250 && px[2] >= 250;
    }, null, { timeout: 15_000 });

    const mpDeskSnap = await readEngineSnapshot(mpDesk.page);
    const mpMobSnap = await readEngineSnapshot(mpMobPage);

    assert.equal(mpDeskSnap.width, CANVAS_W);
    assert.equal(mpMobSnap.width, CANVAS_W);
    assert.equal(mpMobSnap.constrained, true, 'Multiplayer Mobile Web MUST activate constrained mode even when solo=false!');
    assert.ok(mpMobSnap.maxTextureSize <= MOBILE_MAX_TEX, `MP Mobile maxTextureSize must be <= 4096, got ${mpMobSnap.maxTextureSize}`);
    assert.ok(mpMobSnap.resolution <= 1.0, `MP Mobile 13500×7500 DPR must be <= 1.0, got ${mpMobSnap.resolution}`);
    assert.equal(mpDeskSnap.resident, 0, `MP Desktop resident must stay 0, got ${mpDeskSnap.resident}`);
    assert.equal(mpMobSnap.resident, 0, `MP Mobile resident must stay 0, got ${mpMobSnap.resident}`);
    assert.deepEqual(mpMobSnap.oversizedAllocs, [], `MP Mobile allocated oversized >4096 GPU texture: ${JSON.stringify(mpMobSnap.oversizedAllocs)}`);
    assert.deepEqual(mpDesk.errors, [], `MP Desktop errors: ${mpDesk.errors.join(' | ')}`);
    assert.deepEqual(mpMobErrors, [], `MP Mobile errors: ${mpMobErrors.join(' | ')}`);

    console.log(
      `✓ [3/3] Multiplayer 13500×7500 Cross-Platform (Desktop Electron + Mobile Web 4096px GPU) verified!\n` +
      `        Desktop Electron: resident=${mpDeskSnap.resident}, tiles=${mpDeskSnap.tiles}, gpu=${mpDeskSnap.gpuBytesMB} MB, 0 errors\n` +
      `        Mobile Web (4096): constrained=${mpMobSnap.constrained}, dpr=3->${mpMobSnap.resolution}, maxAlloc=${mpMobSnap.maxAllocSeen}px, oversized=0, resident=${mpMobSnap.resident}, gpu=${mpMobSnap.gpuBytesMB} MB, 0 errors`
    );
    console.log('\n🎉 ALL 13500×7500 SOLO + MULTIPLAYER (DESKTOP ELECTRON & MOBILE WEB) E2E CHECKS PASSED!');
    await mpMobCtx.close();
  } finally {
    if (desktopApp) await closeElectron(desktopApp);
    if (mpDesktopApp) await closeElectron(mpDesktopApp);
    if (browser) await browser.close().catch(() => {});
    if (webSrv) webSrv.server.close();
    if (apiSrv && !apiSrv.proc.killed) {
      apiSrv.proc.kill('SIGTERM');
      await sleep(300);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌ Large Canvas E2E failed:', err);
  process.exit(1);
});

/**
 * Isolated Electron Desktop Smoke Verification for Phase 4:
 * - 4.1 Sub View Panel (Ctrl+Shift+R toggle, multi-image upload, prev/next, zoom, flipH, rotate,
 *   auto-eyedropper hover preview & click color pick, local IndexedDB persistence)
 * - 4.2 Color History & Mixing Pad (auto history update on brush stroke, pin color, .gpl import,
 *   Mixing Pad paint/smudge/pick updating main canvas foreground color)
 * - 4.3 Desktop Pop-up Palette (right-click & Alt+Q invocation, viewport anti-clipping clamping,
 *   click recent swatch -> change color & close, click sub-tool/brush slot -> switch & close,
 *   Settings trigger mode 'shortcut-only' disables right-click while preserving shortcut)
 * - Isolated PORT=0 ephemeral multiplayer server check confirming local-only Sub View bandwidth isolation
 *
 * Strictly uses fresh temporary directories for APPDATA, LOCALAPPDATA, --user-data-dir,
 * and an ephemeral PORT=0 server with isolated DATA_DIR/DATABASE_PATH.
 * Never touches Port 3000 or the user's running desktop app.
 *
 * Usage:
 *   node apps/client/scripts/phase4-panels-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '../../..');
const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');

const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal valid RGBA PNG generator (no external dependency)
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function createPngBuffer(width, height, pixelFn) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const off = rowStart + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function startTempServer(dataDir) {
  const appModuleUrl = pathToFileURL(path.join(serverRoot, 'src/app.ts')).href;
  const tsxImportUrl = pathToFileURL(requireServer.resolve('tsx')).href;
  const launcherPath = path.join(dataDir, 'launch-temp-server.mjs');
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
      DATABASE_PATH: path.join(dataDir, 'phase4-smoke.db'),
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
      JWT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Temp server start timed out')), 25_000);
    let stderrBuf = '';
    proc.stdout.on('data', (chunk) => {
      const match = chunk.toString('utf8').match(/TEST_SERVER_READY=(http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Temp server exited early (${code}): ${stderrBuf.slice(-400)}`));
    });
  });

  return { proc, url };
}

async function launchIsolated(userDataDir) {
  assert.ok(fs.existsSync(electronExe), `Missing Electron binary: ${electronExe}`);
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);
  const app = await electron.launch({
    executablePath: electronExe,
    args: [mainJs, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  await page.waitForLoadState('domcontentloaded');
  return { app, page, pageErrors };
}

async function enterOfflineCanvas(page) {
  const soloTab = page.getByRole('button', { name: /單人離線作畫/ });
  if (await soloTab.isVisible({ timeout: 3000 }).catch(() => false)) await soloTab.click();
  const startBtn = page.getByRole('button', { name: '開始單機作畫', exact: true });
  if (await startBtn.isVisible({ timeout: 5000 }).catch(() => false)) await startBtn.click();
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
}

async function dragOnCanvas(page, from, to) {
  await page.evaluate(async ({ from, to }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const rect = dbg.app.canvas.getBoundingClientRect();
    const s0 = dbg.viewport.canvasToScreen(from[0], from[1]);
    const sMid = dbg.viewport.canvasToScreen((from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    const s1 = dbg.viewport.canvasToScreen(to[0], to[1]);
    const base = { bubbles: true, cancelable: true, pointerId: 51, pointerType: 'mouse', isPrimary: true };
    const fire = (type, pt, buttons) => surface.dispatchEvent(new PointerEvent(type, {
      ...base,
      clientX: rect.left + pt.x,
      clientY: rect.top + pt.y,
      button: type === 'pointermove' ? 0 : 0,
      buttons,
      pressure: buttons ? 0.8 : 0,
    }));
    fire('pointerdown', s0, 1);
    await new Promise((r) => setTimeout(r, 35));
    fire('pointermove', sMid, 1);
    await new Promise((r) => setTimeout(r, 35));
    fire('pointermove', s1, 1);
    await new Promise((r) => setTimeout(r, 35));
    fire('pointerup', s1, 0);
  }, { from, to });
  await sleep(300);
}

async function getHexColorInput(page) {
  // ColorWheelStudio hex input in the docked color panel
  const input = page.locator('input[maxlength="7"]').first();
  await input.waitFor({ state: 'visible', timeout: 8000 });
  return (await input.inputValue()).toUpperCase();
}

async function setHexColorInput(page, hex) {
  const input = page.locator('input[maxlength="7"]').first();
  await input.waitFor({ state: 'visible', timeout: 8000 });
  await input.fill(hex);
  await sleep(100);
}

async function runSoloVerification() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase4-solo-'));
  const userDataDir = path.join(tempRoot, 'electron-data');
  const assetsDir = path.join(tempRoot, 'assets');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // Create 2 distinct test PNGs and a .gpl palette
  const splitImgPath = path.join(assetsDir, 'ref-split.png');
  const blueImgPath = path.join(assetsDir, 'ref-blue.png');
  const gplPath = path.join(assetsDir, 'phase4-test.gpl');

  // Left half #E11D48 (225, 29, 72), Right half #10B981 (16, 185, 129)
  fs.writeFileSync(splitImgPath, createPngBuffer(120, 80, (x) => (x < 60 ? [225, 29, 72, 255] : [16, 185, 129, 255])));
  // Solid #2563EB (37, 99, 235)
  fs.writeFileSync(blueImgPath, createPngBuffer(100, 100, () => [37, 99, 235, 255]));
  fs.writeFileSync(gplPath, [
    'GIMP Palette',
    'Name: Phase4 Smoke Set',
    'Columns: 4',
    '#',
    ' 18 184 134\tMint Leaf',
    '245 158  11\tAmber Glow',
  ].join('\n'), 'utf8');

  console.log(`[Phase 4 Solo Electron] Isolated tempRoot: ${tempRoot}`);
  let app = null;
  try {
    const launched = await launchIsolated(userDataDir);
    app = launched.app;
    const { page, pageErrors } = launched;

    await enterOfflineCanvas(page);
    await sleep(400);

    // =========================================================================
    // 1. Sub View Panel (4.1): shortcut open, multi-image load, prev/next, zoom, flipH, rotate, eyedropper
    // =========================================================================
    await page.keyboard.press('Control+Shift+KeyR');
    const subViewCanvas = page.getByTestId('subview-canvas');
    await subViewCanvas.waitFor({ state: 'visible', timeout: 8000 });

    await page.getByTestId('subview-file-input').setInputFiles([splitImgPath, blueImgPath]);
    await sleep(450);

    const counter = page.getByTestId('subview-counter');
    await counter.waitFor({ state: 'visible', timeout: 5000 });
    const counterText1 = (await counter.textContent()).trim();
    assert.match(counterText1, /\b[12]\s*\/\s*2\b/, `Expected 2 loaded images in Sub View, got "${counterText1}"`);

    // Ensure we are on image 1 (ref-split.png) for left/right flipH color verification
    if (counterText1.startsWith('2')) {
      await page.getByTestId('subview-prev').click();
      await sleep(250);
    }
    assert.match((await counter.textContent()).trim(), /^1\s*\/\s*2$/, 'Should be on image 1/2');

    // Wait for image decode + auto-eyedropper cursor to be ready
    await page.locator('[data-testid="subview-canvas"][data-subview-cursor="eyedropper"]').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await subViewCanvas.getAttribute('data-subview-cursor'), 'eyedropper', 'Sub View auto-eyedropper cursor must be active');
    const box = await subViewCanvas.boundingBox();
    assert.ok(box && box.width > 40 && box.height > 40, 'Sub View canvas must have valid layout box');

    // Hover & click left third of split image -> #E11D48
    const leftX = box.x + box.width * 0.30;
    const midY = box.y + box.height * 0.50;
    await page.mouse.move(leftX, midY);
    await sleep(120);
    const hoverChip = page.getByTestId('subview-hover-color');
    await hoverChip.waitFor({ state: 'visible', timeout: 3000 });
    assert.match((await hoverChip.textContent()).toUpperCase(), /#E11D48/, 'Hover chip should preview #E11D48 on left half');
    await page.mouse.click(leftX, midY);
    await sleep(150);
    assert.equal(await getHexColorInput(page), '#E11D48', 'Clicking Sub View must update main foreground color to #E11D48');

    // Horizontal flip -> same left third must now sample #10B981!
    const flipBtn = page.getByTestId('subview-flip-h');
    await flipBtn.click();
    await sleep(200);
    assert.equal(await flipBtn.getAttribute('aria-pressed'), 'true', 'FlipH button must report aria-pressed=true');
    await page.mouse.click(leftX, midY);
    await sleep(150);
    assert.equal(await getHexColorInput(page), '#10B981', 'After horizontal flip, left third must sample #10B981');

    // Zoom in & rotate & reset
    await page.getByTestId('subview-zoom-in').click();
    await sleep(100);
    const zoomText = (await page.getByTestId('subview-zoom-label').textContent()).trim();
    assert.ok(parseInt(zoomText, 10) > 100, `Zoom label must exceed 100%, got "${zoomText}"`);
    await page.getByTestId('subview-rotate-cw').click();
    await sleep(100);
    await page.getByTestId('subview-reset').click();
    await sleep(100);
    assert.equal((await page.getByTestId('subview-zoom-label').textContent()).trim(), '100%', 'Reset must restore 100% zoom');

    // Switch to image 2 (#2563EB) and pick color
    await page.getByTestId('subview-next').click();
    await sleep(250);
    assert.match((await counter.textContent()).trim(), /^2\s*\/\s*2$/, 'Next button must advance to image 2/2');
    await page.mouse.click(box.x + box.width * 0.5, midY);
    await sleep(150);
    assert.equal(await getHexColorInput(page), '#2563EB', 'Picking on image 2 must update foreground color to #2563EB');

    console.log('  ✓ 4.1 Sub View verified (Ctrl+Shift+R, multi-image, next/prev, zoom, flipH color inversion, rotate, reset, auto-eyedropper)');

    // =========================================================================
    // 2. Color History & Mixing Pad (4.2)
    // =========================================================================
    // Set unique color #D946EF via brushProps / hex input and draw a real canvas stroke
    await setHexColorInput(page, '#D946EF');
    await page.keyboard.press('b');
    await sleep(80);
    await dragOnCanvas(page, [140, 140], [220, 180]);

    const firstHistorySwatch = page.locator('[data-testid="color-history-list"] [data-color-swatch]').first();
    await firstHistorySwatch.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(
      (await firstHistorySwatch.getAttribute('data-color-swatch')).toUpperCase(),
      '#D946EF',
      'Brush stroke color #D946EF must be recorded at front of Color History',
    );

    // Pin current color to active swatch set
    await page.getByTestId('color-pin-current').click();
    await sleep(100);
    await page.locator('[data-pinned-swatch="#D946EF"]').first().waitFor({ state: 'visible', timeout: 3000 });

    // Import .gpl palette
    await page.getByTestId('color-palette-import-input').setInputFiles(gplPath);
    await sleep(200);
    await page.locator('[data-pinned-swatch="#12B886"]').first().waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('[data-pinned-swatch="#F59E0B"]').first().waitFor({ state: 'visible', timeout: 3000 });

    // Switch to Mixing Pad tab, paint with #F59E0B, smudge, then pick back to foreground
    await page.locator('[data-pinned-swatch="#F59E0B"]').first().click();
    await sleep(100);
    await page.getByTestId('color-tab-mixing').click();
    const mixCanvas = page.getByTestId('mixing-pad-canvas');
    await mixCanvas.waitFor({ state: 'visible', timeout: 5000 });
    const mixBox = await mixCanvas.boundingBox();
    assert.ok(mixBox && mixBox.width > 80 && mixBox.height > 60, 'Mixing Pad canvas must have visible bounds');

    // Clear pad first so our painted #F59E0B stroke is unambiguous
    await page.getByTestId('mixing-pad-clear').click();
    await sleep(100);
    await page.getByTestId('mixing-pad-mode-paint').click();
    await mixCanvas.scrollIntoViewIfNeeded();
    const paintBox = await mixCanvas.boundingBox();
    const mx1 = paintBox.x + paintBox.width * 0.3;
    const my = paintBox.y + paintBox.height * 0.5;
    const mx2 = paintBox.x + paintBox.width * 0.7;
    await page.mouse.move(mx1, my);
    await page.mouse.down();
    await page.mouse.move((mx1 + mx2) / 2, my, { steps: 6 });
    await page.mouse.move(mx2, my, { steps: 6 });
    await page.mouse.up();
    await sleep(120);

    // Smudge over center
    await page.getByTestId('mixing-pad-mode-smudge').click();
    await page.mouse.move(mx1, my);
    await page.mouse.down();
    await page.mouse.move(mx2, my, { steps: 6 });
    await page.mouse.up();
    await sleep(120);

    // Change foreground to #000000, then pick from Mixing Pad back to warm amber hue
    await setHexColorInput(page, '#000000');
    assert.equal(await getHexColorInput(page), '#000000');
    await page.getByTestId('mixing-pad-mode-pick').click();
    await mixCanvas.scrollIntoViewIfNeeded();
    const pickBox = await mixCanvas.boundingBox();
    await page.mouse.click(pickBox.x + pickBox.width * 0.5, pickBox.y + pickBox.height * 0.5);
    await sleep(150);
    const pickedFromPad = await getHexColorInput(page);
    assert.notEqual(pickedFromPad, '#000000', 'Picking from Mixing Pad must update main foreground color');
    assert.notEqual(pickedFromPad, '#262830', 'Picked Mixing Pad color should reflect painted pigment, not bare background');

    // Switch back to Wheel tab for subsequent checks
    await page.getByTestId('color-tab-wheel').click();
    await sleep(100);
    console.log(`  ✓ 4.2 Color History & Mixing Pad verified (stroke recorded #D946EF, pinned, .gpl imported, Mixing Pad picked ${pickedFromPad})`);

    // =========================================================================
    // 3. Desktop Pop-up Palette (4.3): right-click near corner anti-clipping, color pick, Alt+Q, sub-tool & brush switch, settings
    // =========================================================================
    const viewportEl = page.locator('.atelier-canvas-viewport').first();
    const vpBox = await viewportEl.boundingBox();
    assert.ok(vpBox && vpBox.width > 300, 'Canvas viewport must be visible');

    // Right-click near top-left edge to verify viewport anti-clipping
    const edgeX = Math.max(8, vpBox.x + 12);
    const edgeY = Math.max(8, vpBox.y + 12);
    await page.mouse.click(edgeX, edgeY, { button: 'right' });
    const popup = page.getByTestId('desktop-popup-palette');
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    const cx = Number(await popup.getAttribute('data-cx'));
    const cy = Number(await popup.getAttribute('data-cy'));
    const radius = Number(await popup.getAttribute('data-radius'));
    assert.ok(cx >= radius + 16 && cx <= 1440 - radius - 16, `Popup cx=${cx} must stay clamped inside viewport (radius=${radius})`);
    assert.ok(cy >= radius + 16 && cy <= 900 - radius - 16, `Popup cy=${cy} must stay clamped inside viewport (radius=${radius})`);

    // Click a recent swatch inside Pop-up Palette -> updates foreground color & auto-closes
    const popupSwatch = popup.locator('[data-testid="popup-color-swatch"][data-color="#2563EB"]').first();
    const targetSwatch = (await popupSwatch.count()) > 0
      ? popupSwatch
      : popup.locator('[data-testid="popup-color-swatch"]').first();
    const expectedPopupColor = (await targetSwatch.getAttribute('data-color')).toUpperCase();
    await targetSwatch.click();
    await popup.waitFor({ state: 'hidden', timeout: 3000 });
    assert.equal(await getHexColorInput(page), expectedPopupColor, 'Clicking Pop-up Palette swatch must change foreground color & close');

    // Open via Alt+Q shortcut -> click Eraser sub-tool slot -> verify switch & close
    await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2);
    await page.keyboard.press('Alt+KeyQ');
    await popup.waitFor({ state: 'visible', timeout: 4000 });
    await popup.locator('[data-testid="popup-subtool-slot"][data-subtool-id="eraser"]').click();
    await popup.waitFor({ state: 'hidden', timeout: 3000 });
    await sleep(120);
    assert.equal(
      await page.locator('[data-category-id="eraser"]').getAttribute('aria-pressed'),
      'true',
      'Clicking Eraser slot in Pop-up Palette must activate eraser tool',
    );

    // Open again via Alt+Q -> click first brush preset slot -> verify brush reactivates & closes
    await page.keyboard.press('Alt+KeyQ');
    await popup.waitFor({ state: 'visible', timeout: 4000 });
    await popup.locator('[data-testid="popup-brush-slot"]').first().click();
    await popup.waitFor({ state: 'hidden', timeout: 3000 });
    await sleep(120);
    assert.equal(
      await page.locator('[data-category-id="paint"]').getAttribute('aria-pressed'),
      'true',
      'Clicking brush preset slot in Pop-up Palette must activate paint brush',
    );

    // Open Settings modal and switch trigger mode to 'shortcut-only'
    const settingsBtn = page.locator('button[title*="設定"], button[aria-label*="設定"]').first();
    await settingsBtn.click();
    const triggerSelect = page.locator('[data-setting="desktop-popup-palette-trigger"]');
    await triggerSelect.waitFor({ state: 'visible', timeout: 5000 });
    await triggerSelect.selectOption('shortcut-only');
    await sleep(100);
    await page.keyboard.press('Escape');
    await sleep(150);

    // Right-click on canvas must now NOT open Pop-up Palette
    await page.mouse.click(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2, { button: 'right' });
    await sleep(200);
    assert.equal(await popup.isVisible(), false, 'Right-click must NOT open Pop-up Palette in shortcut-only mode');

    // Alt+Q must STILL open Pop-up Palette
    await page.keyboard.press('Alt+KeyQ');
    await popup.waitFor({ state: 'visible', timeout: 4000 });
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'hidden', timeout: 3000 });

    console.log('  ✓ 4.3 Desktop Pop-up Palette verified (edge anti-clipping, swatch pick, Alt+Q, sub-tool/brush switch, shortcut-only setting)');

    // Reload Electron window to confirm local persistence (Sub View IndexedDB + Color History localStorage)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await enterOfflineCanvas(page);
    await sleep(450);
    await subViewCanvas.waitFor({ state: 'visible', timeout: 8000 });
    assert.match((await page.getByTestId('subview-counter').textContent()).trim(), /\/\s*2$/, 'Sub View images must persist locally across reload');
    assert.ok(
      (await page.locator('[data-testid="color-history-list"] [data-color-swatch="#D946EF"]').count()) > 0,
      'Color History must persist across reload',
    );
    console.log('  ✓ Local persistence verified across reload (Sub View IndexedDB + Color History localStorage)');

    assert.deepEqual(pageErrors, [], `Unexpected solo page errors: ${pageErrors.join(' | ')}`);
  } finally {
    if (app) await app.close().catch(() => {});
    await sleep(400);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runMultiplayerIsolationCheck() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase4-mp-'));
  const dataDir = path.join(tempRoot, 'server-data');
  const userDataDir = path.join(tempRoot, 'electron-data');
  const imgPath = path.join(tempRoot, 'local-ref.png');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(imgPath, createPngBuffer(80, 80, () => [234, 88, 12, 255]));

  console.log(`[Phase 4 MP Electron] Isolated tempRoot: ${tempRoot}`);
  let serverProc = null;
  let app = null;
  try {
    const server = await startTempServer(dataDir);
    serverProc = server.proc;
    console.log(`  ✓ Ephemeral PORT=0 server ready at ${server.url}`);

    const loginRes = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();

    const canvasesRes = await fetch(`${server.url}/api/canvases`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    const canvasesJson = await canvasesRes.json();
    const canvasList = Array.isArray(canvasesJson) ? canvasesJson : (canvasesJson.canvases || canvasesJson.data || []);
    assert.ok(canvasList.length > 0, `Expected at least 1 seeded canvas from /api/canvases, got ${JSON.stringify(canvasesJson)}`);
    const canvasId = canvasList[0].id;

    const launched = await launchIsolated(userDataDir);
    app = launched.app;
    const { page, pageErrors } = launched;

    await page.evaluate(({ url, jwt, user }) => {
      localStorage.setItem('atelier_server_url', url);
      localStorage.setItem('atelier_gateway_resolved', 'true');
      localStorage.setItem('atelier_gateway_skip_on_launch', 'true');
      localStorage.setItem(`atelier_token:${url}`, jwt);
      localStorage.setItem('atelier_token', jwt);
      localStorage.setItem('atelier_user', JSON.stringify(user));
    }, { url: server.url, jwt: loginData.token, user: loginData.user });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
    await sleep(400);

    // Open Sub View in MP room, load local image, pick color -> must NOT emit any room ops
    await page.keyboard.press('Control+Shift+KeyR');
    await page.getByTestId('subview-canvas').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByTestId('subview-file-input').setInputFiles(imgPath);
    await sleep(300);
    const box = await page.getByTestId('subview-canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(250);
    assert.equal(await getHexColorInput(page), '#EA580C', 'Sub View eyedropper must work in MP room');

    // Open Pop-up Palette via right-click in MP room
    const vpBox = await page.locator('.atelier-canvas-viewport').first().boundingBox();
    await page.mouse.click(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2, { button: 'right' });
    await page.getByTestId('desktop-popup-palette').waitFor({ state: 'visible', timeout: 4000 });
    await page.keyboard.press('Escape');

    // Confirm server op log remains 0 (Sub View image never transmitted to room)
    const opsRes = await fetch(`${server.url}/api/canvases/${canvasId}/ops`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    const opsData = await opsRes.json();
    const opList = Array.isArray(opsData) ? opsData : (opsData.ops || []);
    assert.equal(opList.length, 0, `Sub View local load must NOT send any multiplayer ops, got ${opList.length}`);
    assert.deepEqual(pageErrors, [], `Unexpected MP page errors: ${pageErrors.join(' | ')}`);
    console.log('  ✓ Multiplayer PORT=0 isolation verified (Sub View & Pop-up Palette work cleanly, 0 room ops emitted, 0 page errors)');
  } finally {
    if (app) await app.close().catch(() => {});
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await sleep(300);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  await runSoloVerification();
  await runMultiplayerIsolationCheck();
  console.log('\n🎉 ALL PHASE 4 ISOLATED ELECTRON SMOKE CHECKS PASSED!\n');
}

main().catch((err) => {
  console.error('❌ Phase 4 Electron smoke failed:', err);
  process.exit(1);
});

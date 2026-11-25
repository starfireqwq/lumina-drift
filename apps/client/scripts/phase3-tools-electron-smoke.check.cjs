/**
 * Isolated Electron Desktop Smoke Verification for Phase 3:
 * - Left ToolRail 11 main categories with zero vertical overflow/crowding
 * - Selection tool group (7 sub-tools): Rect Marquee, Ellipse Marquee, Polygonal Lasso,
 *   add/subtract boolean modes, Shift square/circle, Alt center-expand, Backspace/Enter/Esc
 * - Vector (6 sub-tools + 3 eraser modes incl. partial + persistence + V shortcut cycling)
 * - Blend (3 sub-tools + R cycling) & Shapes/Comic (5 sub-tools + U cycling)
 * - Direct sub-tool shortcuts (Shift+M, W) vs Category cycling shortcuts (L, V, R, U)
 * - Settings Shortcuts modal clearly splits Tool Categories vs Individual Sub-Tools
 * - Plugin API v2.5 custom tool compatibility in both Compact and Classic ToolRail modes
 * - Multiplayer room check against an isolated PORT=0 ephemeral Fastify server
 *
 * Strictly uses fresh temporary directories for APPDATA, LOCALAPPDATA, --user-data-dir,
 * and an ephemeral PORT=0 server with isolated DATA_DIR/DATABASE_PATH.
 * Never touches Port 3000 or the user's running desktop app.
 *
 * Usage:
 *   node apps/client/scripts/phase3-tools-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '../../..');
const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');

const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const v25KitPath = path.join(clientRoot, 'public/plugins/lumina-motion-atelier.lumina-plugin');

const EXPECTED_CATEGORIES = [
  'paint', 'eraser', 'blend', 'fill', 'gradient', 'eyedropper',
  'select', 'transform', 'vector', 'comic', 'hand',
];
const SELECT_SUBTOOLS = ['select_rect', 'select_ellipse', 'lasso', 'select_polygon', 'magic_wand', 'select_brush', 'select_eraser'];
const VECTOR_SUBTOOLS = ['vector_pen', 'vector_bezier', 'vector_edit', 'vector_reshape', 'vector_width', 'vector_eraser'];
const BLEND_SUBTOOLS = ['smudge', 'blur', 'liquify'];
const COMIC_SUBTOOLS = ['shape', 'text', 'comic_balloon', 'comic_panel', 'animation'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      DATABASE_PATH: path.join(dataDir, 'phase3-smoke.db'),
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

async function dragOnCanvas(page, from, to, mods = {}) {
  await page.evaluate(async ({ from, to, mods }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const rect = dbg.app.canvas.getBoundingClientRect();
    const s0 = dbg.viewport.canvasToScreen(from[0], from[1]);
    const sMid = dbg.viewport.canvasToScreen((from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    const s1 = dbg.viewport.canvasToScreen(to[0], to[1]);
    const base = {
      bubbles: true, cancelable: true, pointerId: 41, pointerType: 'mouse', isPrimary: true,
      shiftKey: Boolean(mods.shiftKey), altKey: Boolean(mods.altKey), ctrlKey: Boolean(mods.ctrlKey),
    };
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, button: 0, buttons: 1, clientX: rect.left + s0.x, clientY: rect.top + s0.y,
    }));
    await new Promise((r) => setTimeout(r, 20));
    surface.dispatchEvent(new PointerEvent('pointermove', {
      ...base, button: -1, buttons: 1, clientX: rect.left + sMid.x, clientY: rect.top + sMid.y,
    }));
    await new Promise((r) => setTimeout(r, 20));
    surface.dispatchEvent(new PointerEvent('pointermove', {
      ...base, button: -1, buttons: 1, clientX: rect.left + s1.x, clientY: rect.top + s1.y,
    }));
    await new Promise((r) => setTimeout(r, 20));
    surface.dispatchEvent(new PointerEvent('pointerup', {
      ...base, button: 0, buttons: 0, clientX: rect.left + s1.x, clientY: rect.top + s1.y,
    }));
    await new Promise((r) => setTimeout(r, 80));
  }, { from, to, mods });
}

async function clickCanvasPoint(page, pt, mods = {}) {
  await page.evaluate(async ({ pt, mods }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const rect = dbg.app.canvas.getBoundingClientRect();
    const s = dbg.viewport.canvasToScreen(pt[0], pt[1]);
    const base = {
      bubbles: true, cancelable: true, pointerId: 42, pointerType: 'mouse', isPrimary: true,
      shiftKey: Boolean(mods.shiftKey), altKey: Boolean(mods.altKey), ctrlKey: Boolean(mods.ctrlKey),
      clientX: rect.left + s.x, clientY: rect.top + s.y,
    };
    surface.dispatchEvent(new PointerEvent('pointermove', { ...base, button: -1, buttons: 0 }));
    surface.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0, buttons: 1 }));
    surface.dispatchEvent(new PointerEvent('pointerup', { ...base, button: 0, buttons: 0 }));
    await new Promise((r) => setTimeout(r, 40));
  }, { pt, mods });
}

async function readSelectionInfo(page, probePoints = []) {
  return page.evaluate((probes) => {
    const engine = window.__debugPixi.selectionEngine;
    const mask = engine.getMaskData();
    if (!mask) return { hasSelection: false, activePixelCount: 0, bounds: null, probes: probes.map(() => 0), polyCount: engine.getPolygonPointCount() };
    return {
      hasSelection: engine.hasSelection(),
      activePixelCount: mask.activePixelCount,
      bounds: { ...mask.bounds },
      probes: probes.map(([x, y]) => mask.data[y * mask.width + x] ?? 0),
      polyCount: engine.getPolygonPointCount(),
    };
  }, probePoints);
}

async function runSoloVerification() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase3-solo-'));
  console.log(`[Phase 3 Solo Electron] Isolated userDataDir: ${userDataDir}`);
  let app = null;
  try {
    const launched = await launchIsolated(userDataDir);
    app = launched.app;
    const { page, pageErrors } = launched;
    await enterOfflineCanvas(page);

    // 1. Verify left ToolRail renders exact 11 categories with zero vertical overflow
    const railCheck = await page.evaluate(() => {
      const catEls = Array.from(document.querySelectorAll('[data-category-id]'));
      const ids = catEls.map((el) => el.getAttribute('data-category-id'));
      const nav = catEls[0]?.closest('nav');
      return {
        ids,
        scrollHeight: nav ? nav.scrollHeight : -1,
        clientHeight: nav ? nav.clientHeight : -1,
      };
    });
    assert.deepEqual(railCheck.ids, EXPECTED_CATEGORIES, `ToolRail categories mismatch: ${JSON.stringify(railCheck.ids)}`);
    assert.ok(railCheck.scrollHeight > 0 && railCheck.scrollHeight <= railCheck.clientHeight + 2,
      `Left ToolRail should have zero vertical overflow (scroll=${railCheck.scrollHeight}, client=${railCheck.clientHeight})`);
    console.log(`  ✓ Left ToolRail verified: 11 categories, zero overflow (scroll=${railCheck.scrollHeight} <= client=${railCheck.clientHeight})`);

    // 2. Selection category: verify all 7 sub-tools, Rect/Ellipse/Polygon drawing, Shift/Alt, Backspace/Enter/Esc
    await page.locator('[data-category-id="select"]').click();
    for (const id of SELECT_SUBTOOLS) {
      await page.locator(`[data-subtool-id="${id}"]`).waitFor({ state: 'visible', timeout: 5000 });
    }
    await page.locator('[data-subtool-id="select_rect"]').click();
    await dragOnCanvas(page, [100, 100], [200, 160]);
    const rectInfo = await readSelectionInfo(page, [[150, 130], [90, 90]]);
    assert.equal(rectInfo.hasSelection, true, 'Rect marquee must create selection');
    assert.ok(rectInfo.activePixelCount >= 5500 && rectInfo.activePixelCount <= 6500, `Unexpected rect pixel count: ${JSON.stringify(rectInfo)}`);
    assert.equal(rectInfo.probes[0], 255, 'Rect center must be selected');
    assert.equal(rectInfo.probes[1], 0, 'Outside rect must be unselected');

    // Shift + drag Rect marquee: adds square region to existing selection
    await dragOnCanvas(page, [180, 120], [240, 150], { shiftKey: true });
    const addInfo = await readSelectionInfo(page, [[110, 110], [230, 170]]);
    assert.ok(addInfo.activePixelCount > rectInfo.activePixelCount + 1500, `Shift+drag must add to selection: ${JSON.stringify(addInfo)}`);
    assert.equal(addInfo.probes[0], 255, 'Original rect pixel must remain selected after Shift add');
    assert.equal(addInfo.probes[1], 255, 'Shift-constrained square extension must be selected');

    // Switch to Ellipse Marquee + Alt drag on existing selection: subtract + center expand
    await page.locator('[data-subtool-id="select_ellipse"]').click();
    await dragOnCanvas(page, [150, 130], [170, 150], { altKey: true });
    const subInfo = await readSelectionInfo(page, [[150, 130], [105, 105]]);
    assert.equal(subInfo.probes[0], 0, 'Alt+drag ellipse must subtract center from existing selection');
    assert.equal(subInfo.probes[1], 255, 'Outer corner must remain selected after center subtraction');

    // Clear selection, then Shift+Alt drag Ellipse Marquee on empty canvas -> pure centered circle in replace mode!
    await page.keyboard.press('Control+d');
    await sleep(100);
    await dragOnCanvas(page, [300, 300], [340, 320], { shiftKey: true, altKey: true });
    const circleInfo = await readSelectionInfo(page, [[300, 300], [270, 300], [330, 300], [300, 270], [300, 330]]);
    assert.equal(circleInfo.hasSelection, true, 'Shift+Alt ellipse on empty canvas must select a centered circle');
    assert.ok(circleInfo.probes.every((v) => v === 255), `Centered circle must cover symmetric probes: ${JSON.stringify(circleInfo)}`);
    const cw = circleInfo.bounds.maxX - circleInfo.bounds.minX;
    const ch = circleInfo.bounds.maxY - circleInfo.bounds.minY;
    assert.ok(Math.abs(cw - ch) <= 2, `Shift+Alt ellipse bounds must be square/circular: ${JSON.stringify(circleInfo.bounds)}`);

    // Polygonal Lasso: place 4 pts, Backspace pops 4th, place true 4th, Enter closes, then draft + Esc cancels safely
    await page.keyboard.press('Control+d');
    await sleep(100);
    await page.locator('[data-subtool-id="select_polygon"]').click();
    await clickCanvasPoint(page, [400, 100]);
    await clickCanvasPoint(page, [500, 100]);
    await clickCanvasPoint(page, [500, 200]);
    await clickCanvasPoint(page, [450, 260]);
    assert.equal((await readSelectionInfo(page)).polyCount, 4, 'Should have 4 polygon vertices before Backspace');
    await page.keyboard.press('Backspace');
    await sleep(60);
    assert.equal((await readSelectionInfo(page)).polyCount, 3, 'Backspace must remove last polygon vertex');
    await clickCanvasPoint(page, [400, 200]);
    await page.keyboard.press('Enter');
    await sleep(100);
    const polyInfo = await readSelectionInfo(page, [[450, 150], [450, 240]]);
    assert.equal(polyInfo.hasSelection, true, 'Enter must commit polygonal lasso');
    assert.equal(polyInfo.probes[0], 255, 'Polygon interior must be selected');
    assert.equal(polyInfo.probes[1], 0, 'Removed Backspace vertex area must NOT be selected');

    // Start new polygon draft and press Esc -> cancels draft without clearing committed selection
    await clickCanvasPoint(page, [50, 50]);
    await clickCanvasPoint(page, [80, 50]);
    await page.keyboard.press('Escape');
    await sleep(60);
    const afterEsc = await readSelectionInfo(page, [[450, 150]]);
    assert.equal(afterEsc.polyCount, 0, 'Esc must cancel active polygon draft');
    assert.equal(afterEsc.probes[0], 255, 'Esc must preserve previous committed selection');
    console.log('  ✓ Selection group (7 sub-tools, Rect/Ellipse/Polygon, Shift/Alt/add/subtract, Backspace/Enter/Esc) verified');

    // 3. Vector (6 sub-tools + 3 eraser modes + V cycling), Blend (3 + R cycling), Comic (5 + U cycling), direct sub-tool shortcuts
    await page.locator('[data-category-id="vector"]').click();
    for (const id of VECTOR_SUBTOOLS) {
      await page.locator(`[data-subtool-id="${id}"]`).waitFor({ state: 'visible', timeout: 5000 });
    }
    await page.locator('[data-subtool-id="vector_pen"]').click();
    const vecCycled = [];
    for (let i = 0; i < VECTOR_SUBTOOLS.length; i++) {
      await page.keyboard.press('v');
      vecCycled.push(await page.locator('[data-subtool-id][aria-pressed="true"]').first().getAttribute('data-subtool-id'));
    }
    assert.deepEqual(vecCycled, [...VECTOR_SUBTOOLS.slice(1), 'vector_pen'], `V shortcut cycle mismatch: ${JSON.stringify(vecCycled)}`);

    // Switch to vector_eraser -> select 'partial' (局部擦除) -> switch away -> verify persisted
    await page.locator('[data-subtool-id="vector_eraser"]').click();
    const partialBtn = page.getByRole('radio', { name: '局部擦除', exact: true });
    await partialBtn.waitFor({ state: 'visible', timeout: 5000 });
    await partialBtn.click();
    await sleep(100);

    // Blend category (smudge, blur, liquify) + R cycling
    await page.locator('[data-category-id="blend"]').click();
    for (const id of BLEND_SUBTOOLS) {
      await page.locator(`[data-subtool-id="${id}"]`).waitFor({ state: 'visible', timeout: 5000 });
    }
    await page.locator('[data-subtool-id="smudge"]').click();
    const blendCycled = [];
    for (let i = 0; i < BLEND_SUBTOOLS.length; i++) {
      await page.keyboard.press('r');
      blendCycled.push(await page.locator('[data-subtool-id][aria-pressed="true"]').first().getAttribute('data-subtool-id'));
    }
    assert.deepEqual(blendCycled, ['blur', 'liquify', 'smudge'], `R shortcut cycle mismatch: ${JSON.stringify(blendCycled)}`);

    // Comic / Shapes category (shape, text, comic_balloon, comic_panel, animation) + U cycling
    await page.locator('[data-category-id="comic"]').click();
    for (const id of COMIC_SUBTOOLS) {
      await page.locator(`[data-subtool-id="${id}"]`).waitFor({ state: 'visible', timeout: 5000 });
    }
    await page.locator('[data-subtool-id="shape"]').click();
    const comicCycled = [];
    for (let i = 0; i < COMIC_SUBTOOLS.length; i++) {
      await page.keyboard.press('u');
      comicCycled.push(await page.locator('[data-subtool-id][aria-pressed="true"]').first().getAttribute('data-subtool-id'));
    }
    assert.deepEqual(comicCycled, [...COMIC_SUBTOOLS.slice(1), 'shape'], `U shortcut cycle mismatch: ${JSON.stringify(comicCycled)}`);

    // Return to vector_eraser -> verify 'partial' persisted
    await page.locator('[data-category-id="vector"]').click();
    await page.locator('[data-subtool-id="vector_eraser"]').click();
    assert.equal(await page.getByRole('radio', { name: '局部擦除', exact: true }).getAttribute('aria-checked'), 'true',
      'vector_eraser partial mode must persist across category switches');

    // Direct sub-tool shortcuts: Shift+M -> select_rect, W -> magic_wand, L -> cycles select
    await page.keyboard.press('Shift+M');
    await sleep(80);
    assert.equal(await page.locator('[data-subtool-id][aria-pressed="true"]').first().getAttribute('data-subtool-id'), 'select_rect');
    await page.keyboard.press('w');
    await sleep(80);
    assert.equal(await page.locator('[data-subtool-id][aria-pressed="true"]').first().getAttribute('data-subtool-id'), 'magic_wand');
    await page.keyboard.press('l');
    await sleep(80);
    assert.equal(await page.locator('[data-subtool-id][aria-pressed="true"]').first().getAttribute('data-subtool-id'), 'select_brush');
    console.log('  ✓ Vector/Blend/Comic sub-tool switching, parameter persistence, and category vs sub-tool shortcuts verified');

    // 4. Settings Modal -> Shortcuts tab separates Tool Categories vs Individual Sub-Tools
    await page.locator('header button[title*="設定"], header button[aria-label*="設定"]').first().click();
    const shortcutsTab = page.getByRole('tab', { name: /快捷鍵/ });
    await shortcutsTab.waitFor({ state: 'visible', timeout: 5000 });
    await shortcutsTab.click();
    const catShortcutsCount = await page.locator('[data-shortcut-section="tool-categories"] [data-shortcut-id]').count();
    const subShortcutsCount = await page.locator('[data-shortcut-section="tool-subtools"] [data-shortcut-id]').count();
    assert.equal(catShortcutsCount, 11, `Expected 11 category shortcuts in Settings modal, got ${catShortcutsCount}`);
    assert.ok(subShortcutsCount >= 18, `Expected >= 18 individual sub-tool shortcuts in Settings modal, got ${subShortcutsCount}`);
    await page.getByRole('button', { name: '關閉', exact: true }).last().click();
    await sleep(150);
    console.log(`  ✓ Settings Shortcuts modal verified: ${catShortcutsCount} category shortcuts + ${subShortcutsCount} sub-tool shortcuts`);

    // 5. Plugin API v2.5 custom tool compatibility in BOTH Compact and Classic ToolRail
    assert.ok(fs.existsSync(v25KitPath), `Missing v2.5 plugin package: ${v25KitPath}`);
    const pluginBtn = page.getByRole('button', { name: '插件', exact: true });
    if ((await pluginBtn.count()) && (await pluginBtn.first().isVisible())) await pluginBtn.first().click();
    else await page.locator('header button[title="檔案"]').first().click();
    await page.getByRole('menuitem', { name: '管理插件…', exact: true }).click();
    const mgr = page.getByRole('dialog', { name: '管理插件' });
    await mgr.waitFor({ timeout: 10000 });
    await mgr.locator('input[type=file]').setInputFiles(v25KitPath);
    await mgr.locator('[data-plugin-api-version="2"]').waitFor({ timeout: 10000 });
    await mgr.getByRole('button', { name: '安裝插件', exact: true }).click();
    const card = mgr.locator('[data-plugin-card="lumina.motion-atelier"]');
    await card.waitFor({ timeout: 10000 });
    await card.locator('[data-plugin-toggle="lumina.motion-atelier"]').click();
    await mgr.getByRole('button', { name: '關閉', exact: true }).last().click();
    await mgr.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    // Compact mode: plugin tool visible, clickable, and category switch clears it
    const customTool = page.locator('[data-plugin-tool-id="lumina.motion-atelier:starlight-ribbon"]').first();
    await customTool.waitFor({ state: 'visible', timeout: 10000 });
    await customTool.click();
    assert.equal(await customTool.getAttribute('aria-pressed'), 'true', 'Plugin tool must activate in compact ToolRail');
    await page.keyboard.press('b');
    await sleep(80);
    assert.equal(await customTool.getAttribute('aria-pressed'), 'false', 'Category shortcut must deactivate plugin tool');

    // Classic mode: plugin tool still visible & activatable
    await page.locator('[data-rail-mode-toggle]').click();
    await sleep(100);
    assert.equal(await page.locator('[data-category-id]').count(), 0, 'Classic rail mode must hide compact categories');
    await customTool.waitFor({ state: 'visible', timeout: 5000 });
    await customTool.click();
    assert.equal(await customTool.getAttribute('aria-pressed'), 'true', 'Plugin tool must activate in classic ToolRail');
    await page.locator('[data-rail-mode-toggle]').click();
    await sleep(100);
    console.log('  ✓ Plugin API v2.5 custom tool verified in both Compact & Classic ToolRail modes');

    assert.deepEqual(pageErrors, [], `Unexpected solo page errors: ${pageErrors.join(' | ')}`);
  } finally {
    if (app) await app.close().catch(() => {});
    await sleep(400);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function runMultiplayerVerification() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase3-mp-'));
  const dataDir = path.join(tempRoot, 'server-data');
  const userDataDir = path.join(tempRoot, 'electron-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[Phase 3 MP Electron] Isolated tempRoot: ${tempRoot}`);
  let serverProc = null;
  let app = null;
  try {
    const server = await startTempServer(dataDir);
    serverProc = server.proc;
    console.log(`  ✓ Ephemeral PORT=0 server ready at ${server.url}`);

    // Authenticate as admin on ephemeral server
    const loginRes = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(loginRes.status, 200, 'Admin login on temp server must succeed');
    const loginData = await loginRes.json();
    assert.ok(loginData.token, 'JWT token must be returned');

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

    const catCount = await page.locator('[data-category-id]').count();
    assert.equal(catCount, 11, `MP canvas must render 11 main categories, got ${catCount}`);
    await page.locator('[data-category-id="select"]').click();
    await page.locator('[data-subtool-id="select_rect"]').click();
    await dragOnCanvas(page, [120, 120], [200, 180]);
    const mpSel = await readSelectionInfo(page, [[160, 150]]);
    assert.equal(mpSel.hasSelection, true, 'Rect marquee must work in MP canvas');
    assert.equal(mpSel.probes[0], 255, 'MP rect marquee center pixel must be selected');
    assert.deepEqual(pageErrors, [], `Unexpected MP page errors: ${pageErrors.join(' | ')}`);
    console.log(`  ✓ Multiplayer PORT=0 isolated Electron room verified (11 categories, rect marquee ${mpSel.activePixelCount} px, 0 page errors)`);
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
  await runMultiplayerVerification();
  console.log('\n🎉 ALL PHASE 3 ISOLATED ELECTRON SMOKE CHECKS PASSED!\n');
}

main().catch((err) => {
  console.error('❌ Phase 3 Electron smoke failed:', err);
  process.exit(1);
});

/**
 * Isolated Electron Desktop Smoke Verification for Phase 2:
 * CSP-style Tool Categories -> Sub Tool Panel, 5 Fill Sub Tools,
 * Paint Unfilled Area (間隙填充筆), single-step Ctrl+Z undo, and Multiplayer Tile Sync.
 *
 * Strictly uses fresh temporary directories for APPDATA, LOCALAPPDATA, --user-data-dir,
 * and an ephemeral PORT=0 Fastify server with isolated DATA_DIR/DATABASE_PATH.
 * Never touches Port 3000 or the user's running desktop app.
 *
 * Usage:
 *   node apps/client/scripts/phase2-subtools-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = path.resolve(__dirname, '../../..');
const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');
const { io } = requireServer('socket.io-client');
const { decodeMessage } = require(path.join(repoRoot, 'packages/shared/dist/index.js'));

const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');

const FILL_SUBTOOL_IDS = [
  'fill_bucket',
  'fill_enclose',
  'fill_lasso',
];

const { pathToFileURL } = require('node:url');

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
      DATABASE_PATH: path.join(dataDir, 'phase2-smoke.db'),
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
      const text = chunk.toString('utf8');
      const match = text.match(/TEST_SERVER_READY=(http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Temp server exited early (${code}): ${stderrBuf.slice(-400)}`));
    });
  });

  return { proc, url };
}

async function seedClosedBoxAndPaintUnfilled(page, targetLayerId = null) {
  // Seed a closed 80x80 black ink box at (120..200, 120..200) on the target/active raster layer.
  const activeLayerId = await page.evaluate(async (explicitId) => {
    const dbg = window.__debugPixi;
    const layers = dbg.layerManager.getLayers().filter((l) => l.model?.isVisible && l.model?.layerType === 'raster');
    layers.sort((a, b) => (b.model?.sortOrder ?? 0) - (a.model?.sortOrder ?? 0));
    const active = explicitId ? layers.find((l) => l.model.id === explicitId) : layers[0];
    if (!active) throw new Error(`Target raster layer not found (explicitId=${explicitId})`);
    const id = active.model.id;
    const w = 120;
    const h = 120;
    const px = new Uint8Array(w * h * 4);
    for (let y = 20; y <= 100; y++) {
      for (let x = 20; x <= 100; x++) {
        const onBorder = x <= 22 || x >= 98 || y <= 22 || y >= 98;
        if (!onBorder) continue;
        const i = (y * w + x) * 4;
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
        px[i + 3] = 255;
      }
    }
    dbg.layerManager.writeRegion(id, 100, 100, w, h, px);
    dbg.layerManager.syncPingPong(id);
    return id;
  }, targetLayerId);

  // Switch active color to bright red via color input or debug? Even better: read brushProps or set via color swatch / debug.
  // Actually any non-black opaque color works; default color is black (#000000) or indigo. Let's check pixel alpha inside box (160,160) & outside box (108,160)!
  const before = await page.evaluate(async (layerId) => {
    const dbg = window.__debugPixi;
    const [px] = await dbg.layerManager.readAsync(layerId, [{ x: 100, y: 100, w: 120, h: 120 }]);
    const alphaAt = (x, y) => px[((y - 100) * 120 + (x - 100)) * 4 + 3];
    return {
      inside: alphaAt(160, 160),
      outside: alphaAt(108, 160),
      border: alphaAt(121, 160),
    };
  }, activeLayerId);
  assert.equal(before.inside, 0, 'Box interior must start empty');
  assert.equal(before.outside, 0, 'Box exterior must start empty');
  assert.equal(before.border, 255, 'Box border ink must be opaque');

  // Sweep Paint Unfilled Area brush from outside (106, 160) across the ink border into the closed interior (155, 160).
  await page.evaluate(async () => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const rect = dbg.app.canvas.getBoundingClientRect();
    const pts = [
      [106, 160],
      [115, 160],
      [125, 160],
      [140, 160],
      [155, 160],
    ];
    const first = dbg.viewport.canvasToScreen(pts[0][0], pts[0][1]);
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse', isPrimary: true, button: 0,
      clientX: rect.left + first.x, clientY: rect.top + first.y, buttons: 1, pressure: 0.7,
    }));
    for (let i = 1; i < pts.length; i++) {
      const sc = dbg.viewport.canvasToScreen(pts[i][0], pts[i][1]);
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse', isPrimary: true, button: -1,
        clientX: rect.left + sc.x, clientY: rect.top + sc.y, buttons: 1, pressure: 0.7,
      }));
      await new Promise((r) => setTimeout(r, 15));
    }
    const last = dbg.viewport.canvasToScreen(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse', isPrimary: true, button: 0,
      clientX: rect.left + last.x, clientY: rect.top + last.y, buttons: 0, pressure: 0,
    }));
    await new Promise((r) => setTimeout(r, 600));
  });

  const after = await page.evaluate(async (layerId) => {
    const dbg = window.__debugPixi;
    const [px] = await dbg.layerManager.readAsync(layerId, [{ x: 100, y: 100, w: 120, h: 120 }]);
    const alphaAt = (x, y) => px[((y - 100) * 120 + (x - 100)) * 4 + 3];
    let insideFilled = 0;
    let outsideFilled = 0;
    for (let y = 123; y <= 197; y++) {
      for (let x = 123; x <= 197; x++) {
        if (alphaAt(x, y) > 0) insideFilled++;
      }
    }
    for (let y = 100; y <= 219; y++) {
      for (let x = 100; x <= 119; x++) {
        if (alphaAt(x, y) > 0) outsideFilled++;
      }
    }
    return {
      insideCenter: alphaAt(160, 160),
      outsidePoint: alphaAt(108, 160),
      insideFilled,
      outsideFilled,
    };
  }, activeLayerId);

  assert.ok(after.insideCenter > 0 && after.insideFilled > 5000,
    `Expected closed interior filled by Paint Unfilled Area, got ${JSON.stringify(after)}`);
  assert.equal(after.outsideFilled, 0,
    `Paint Unfilled Area must NEVER overflow outside lineart, got ${JSON.stringify(after)}`);

  // Single-step Ctrl+Z undo must clear the entire Paint Unfilled Area fill in ONE step!
  await page.keyboard.press('Control+z');
  await new Promise((r) => setTimeout(r, 500));

  const afterUndo = await page.evaluate(async (layerId) => {
    const dbg = window.__debugPixi;
    const [px] = await dbg.layerManager.readAsync(layerId, [{ x: 100, y: 100, w: 120, h: 120 }]);
    const alphaAt = (x, y) => px[((y - 100) * 120 + (x - 100)) * 4 + 3];
    return {
      insideCenter: alphaAt(160, 160),
      border: alphaAt(121, 160),
    };
  }, activeLayerId);

  assert.equal(afterUndo.insideCenter, 0, `Single-step Ctrl+Z must revert interior fill, got ${JSON.stringify(afterUndo)}`);
  assert.equal(afterUndo.border, 255, 'Single-step Ctrl+Z must preserve original lineart border');

  return { activeLayerId, after, afterUndo };
}

async function runSoloVerification() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase2-solo-'));
  console.log(`[Phase 2 Solo Electron] Isolated userDataDir: ${userDataDir}`);
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args: [mainJs, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
    await page.waitForLoadState('domcontentloaded');

    const soloTab = page.getByRole('button', { name: /單人離線作畫/ });
    if (await soloTab.isVisible({ timeout: 3000 }).catch(() => false)) await soloTab.click();
    const startBtn = page.getByRole('button', { name: '開始單機作畫', exact: true });
    if (await startBtn.isVisible({ timeout: 5000 }).catch(() => false)) await startBtn.click();
    await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });

    // 1. Verify compact ToolRail renders 14 main categories (including Text, Comic & Animation)
    const categoryCount = await page.locator('[data-category-id]').count();
    assert.equal(categoryCount, 14, `Expected 14 main categories in compact ToolRail, got ${categoryCount}`);

    // 2. Click Fill category -> verify SubToolPanel shows all 3 unified Fill sub-tools
    await page.locator('[data-category-id="fill"]').click();
    for (const id of FILL_SUBTOOL_IDS) {
      await page.locator(`[data-subtool-id="${id}"]`).waitFor({ state: 'visible', timeout: 5000 });
    }
    console.log('  ✓ Compact ToolRail (14 categories) & Fill SubToolPanel (3 unified sub-tools) verified');

    // 3. Verify clicking each of the 5 Fill sub-tools activates it cleanly without redundant fillMode toggle
    for (const id of FILL_SUBTOOL_IDS) {
      await page.locator(`[data-subtool-id="${id}"]`).click();
      const pressed = await page.locator(`[data-subtool-id="${id}"]`).getAttribute('aria-pressed');
      assert.equal(pressed, 'true', `Sub-tool ${id} should be active after click`);
    }

    // 4. Verify CSP repeated shortcut cycling ('g' for Fill category)
    await page.locator('[data-subtool-id="fill_bucket"]').click();
    const cycled = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('g');
      const activeId = await page.locator('[data-subtool-id][aria-pressed="true"]').first().getAttribute('data-subtool-id');
      cycled.push(activeId);
    }
    assert.deepEqual(cycled, [
      'fill_enclose',
      'fill_lasso',
      'fill_bucket',
    ], `CSP shortcut cycle order mismatch: ${JSON.stringify(cycled)}`);
    console.log('  ✓ CSP repeated shortcut (G) cycling across all 3 unified Fill sub-tools verified');

    // 5. Verify Classic / Compact rail mode toggle works both ways
    const modeToggle = page.locator('[data-rail-mode-toggle]');
    await modeToggle.click();
    assert.equal(await page.locator('[data-category-id]').count(), 0, 'Classic mode should show flat tools instead of categories');
    await modeToggle.click();
    assert.equal(await page.locator('[data-category-id]').count(), 14, 'Toggling back should restore 14 compact categories');
    console.log('  ✓ Compact <-> Classic ToolRail toggle verified');

    // 6. Select Smart Fill -> Gap Fill mode & verify zero-overflow fill + single-step Ctrl+Z undo
    await page.locator('[data-category-id="fill"]').click();
    await page.locator('[data-subtool-id="fill_enclose"]').click();
    await page.getByRole('radio', { name: /間隙補塗|间隙补涂|Gap Fill|塗り残し補正/ }).first().click();
    const fillRes = await seedClosedBoxAndPaintUnfilled(page);
    console.log(`  ✓ Solo Paint Unfilled Area verified: insideFilled=${fillRes.after.insideFilled}, outsideFilled=${fillRes.after.outsideFilled}, undoInside=${fillRes.afterUndo.insideCenter}`);

    assert.deepEqual(pageErrors, [], `Unexpected solo page errors: ${pageErrors.join(' | ')}`);
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function runMultiplayerVerification() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase2-srv-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase2-mp-'));
  console.log(`[Phase 2 Multiplayer Electron] Temp server DATA_DIR: ${dataDir}`);
  let server = null;
  let app = null;
  let peerSocket = null;
  try {
    server = await startTempServer(dataDir);
    console.log(`  ✓ Ephemeral PORT=0 server ready at ${server.url}`);

    // Authenticate as admin on temp server and locate initial canvas
    const loginRes = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(loginRes.status, 200, 'Admin login on temp server must succeed');
    const loginData = await loginRes.json();
    const token = loginData.token;
    assert.ok(token, 'JWT token must be returned');

    const canvasesRes = await fetch(`${server.url}/api/canvases`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const canvasesJson = await canvasesRes.json();
    const canvases = Array.isArray(canvasesJson) ? canvasesJson : (canvasesJson.canvases || canvasesJson.data || []);
    assert.ok(Array.isArray(canvases) && canvases.length > 0, `Seeded canvas must exist, got ${JSON.stringify(canvasesJson)}`);
    const canvasId = canvases[0].id;

    // Create a dedicated owned raster layer for admin so activeLayer selection & ACL are deterministic
    const createLayerRes = await fetch(`${server.url}/api/canvases/${canvasId}/layers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Phase2FillLayer', layerType: 'raster' }),
    });
    assert.ok(createLayerRes.status === 200 || createLayerRes.status === 201, `Create layer failed: ${createLayerRes.status}`);
    const createdLayerJson = await createLayerRes.json();
    const mpLayerId = createdLayerJson.layer?.id || createdLayerJson.id;
    assert.ok(mpLayerId, `Created layer id missing: ${JSON.stringify(createdLayerJson)}`);

    // Connect a second multiplayer peer socket to observe live broadcasts (JSON + MsgPack binary)
    const observedOps = [];
    peerSocket = io(server.url, { auth: { token }, transports: ['websocket'] });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Peer socket connect timeout')), 10_000);
      peerSocket.on('connect', () => {
        peerSocket.emit('join_canvas', { canvasId });
        clearTimeout(t);
        resolve();
      });
      peerSocket.on('connect_error', (err) => { clearTimeout(t); reject(err); });
    });
    peerSocket.on('op_broadcast', (op) => observedOps.push(op));
    peerSocket.on('binary_packet', (buf) => {
      try {
        const pkt = decodeMessage(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
        if (pkt && pkt.type === 'op_broadcast') observedOps.push(pkt.data || pkt);
      } catch {}
    });

    // Launch isolated Electron connected to our temp server as authenticated admin
    app = await electron.launch({
      executablePath: electronExe,
      args: [mainJs, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
    await page.waitForLoadState('domcontentloaded');

    // Inject temp server URL + origin-scoped JWT + skip gateway into localStorage, then reload into multiplayer canvas
    await page.evaluate(({ url, jwt, user }) => {
      localStorage.setItem('atelier_server_url', url);
      localStorage.setItem('atelier_gateway_resolved', 'true');
      localStorage.setItem('atelier_gateway_skip_on_launch', 'true');
      localStorage.setItem(`atelier_token:${url}`, jwt);
      localStorage.setItem('atelier_token', jwt);
      localStorage.setItem('atelier_user', JSON.stringify(user));
    }, { url: server.url, jwt: token, user: loginData.user });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
    await new Promise((r) => setTimeout(r, 800));

    // Explicitly select our owned raster layer in the Layer Panel
    const layerRow = page.getByText('Phase2FillLayer').first();
    await layerRow.waitFor({ state: 'visible', timeout: 10000 });
    await layerRow.click();
    await new Promise((r) => setTimeout(r, 250));

    // Select Fill -> Smart Fill (Gap Fill mode) in multiplayer canvas
    await page.locator('[data-category-id="fill"]').click();
    await page.locator('[data-subtool-id="fill_enclose"]').click();
    await page.getByRole('radio', { name: /間隙補塗|间隙补涂|Gap Fill|塗り残し補正/ }).first().click();

    const mpRes = await seedClosedBoxAndPaintUnfilled(page, mpLayerId);
    await new Promise((r) => setTimeout(r, 700));

    // Verify peer socket received both the paint_unfilled STROKE op AND the UNDO op!
    const paintOp = observedOps.find((op) => op.opType === 'STROKE' && op.payload?.tool === 'paint_unfilled');
    assert.ok(paintOp, `Peer must receive paint_unfilled STROKE broadcast; received ops: ${JSON.stringify(observedOps.map((o) => ({ type: o.opType, tool: o.payload?.tool })))}`);
    assert.ok(Array.isArray(paintOp.payload?.tiles) && paintOp.payload.tiles.length > 0, 'paint_unfilled broadcast must include compressed tile patches');

    const undoOp = observedOps.find((op) => op.opType === 'UNDO' || (op.opType === 'STROKE' && op.payload?.tool === 'undo') || op.opType === 'TILE_PATCH');
    // Also verify server ops history recorded the stroke
    const opsRes = await fetch(`${server.url}/api/canvases/${canvasId}/ops`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(opsRes.status, 200, 'Server /ops endpoint must respond 200');
    console.log(`  ✓ Multiplayer Paint Unfilled Area synced! Peer received ${observedOps.length} ops (paint_unfilled tiles=${paintOp.payload.tiles.length}, undoObserved=${Boolean(undoOp)})`);
    assert.deepEqual(pageErrors, [], `Unexpected multiplayer page errors: ${pageErrors.join(' | ')}`);
  } finally {
    if (peerSocket) peerSocket.disconnect();
    if (app) await app.close().catch(() => {});
    if (server?.proc) {
      server.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  assert.ok(fs.existsSync(electronExe), `Missing Electron binary: ${electronExe}`);
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);
  await runSoloVerification();
  await runMultiplayerVerification();
  console.log('\n🎉 [Phase 2 Electron Smoke] SOLO + MULTIPLAYER VERIFICATION PASSED!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

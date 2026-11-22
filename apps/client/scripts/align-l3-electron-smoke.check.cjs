/**
 * Isolated Electron Desktop Smoke Verification for Align L3.
 *
 * Strictly uses a fresh temporary directory for APPDATA, LOCALAPPDATA, and --user-data-dir
 * so the user's running desktop app and Port 3000 Fastify server are never touched.
 *
 * Usage:
 *   node apps/client/scripts/align-l3-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireServer = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { _electron: electron } = requireServer('playwright-core');

const clientRoot = path.resolve(__dirname, '..');
const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchIsolated(userDataDir) {
  assert.ok(fs.existsSync(electronExe), `Missing Electron binary: ${electronExe}`);
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);

  const app = await electron.launch({
    executablePath: electronExe,
    args: [mainJs, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      APPDATA: userDataDir,
      LOCALAPPDATA: userDataDir,
    },
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
  if (await soloTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await soloTab.click();
  }
  const startBtn = page.getByRole('button', { name: '開始單機作畫', exact: true });
  if (await startBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await startBtn.click();
  }
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
  await page.waitForFunction(() => window.__debugPixi?.layerManager?.getLayers().length >= 1, null, { timeout: 20000 });
  await sleep(300);
}

async function readBounds(page, layerId, cw, ch) {
  return page.evaluate(async ({ id, w, h }) => {
    const dbg = window.__debugPixi;
    const [px] = await dbg.layerManager.readAsync(id, [{ x: 0, y: 0, w, h }]);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < minX ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }, { id: layerId, w: cw, h: ch });
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-align-l3-electron-'));
  console.log(`[Electron Align L3 Smoke] Isolated userDataDir: ${userDataDir}`);

  let app = null;
  try {
    const session = await launchIsolated(userDataDir);
    app = session.app;
    const { page, pageErrors } = session;

    await enterOfflineCanvas(page);
    console.log('✓ Step 1: Isolated Electron launched and entered solo offline canvas');

    // Open Align window
    await page.getByRole('button', { name: '對齊・均分', exact: true }).first().click();
    await page.locator('[data-testid="align-basis-select"]').waitFor({ state: 'visible', timeout: 10000 });

    // Open RulerControlsModal via the Align window shortcut and add a vertical guide
    await page.locator('[data-testid="align-basis-select"]').selectOption('guide');
    await page.locator('[data-testid="align-open-guides"]').click();
    await page.locator('[data-testid="add-vertical-guide"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="add-vertical-guide"]').click();
    await sleep(150);

    // Verify RulerOverlay renders the guide line in DOM
    const guideCount = await page.locator('g[data-guide-id]').count();
    assert.equal(guideCount, 1, `Expected 1 rendered guide in RulerOverlay, got ${guideCount}`);

    // Set guide X=140 and paint a 40x40 block at (300, 200) on the active raster layer
    const info = await page.evaluate(() => {
      const dbg = window.__debugPixi;
      const g = dbg.rulerManager.state.guides.items[0];
      dbg.rulerManager.updateGuide(g.id, { position: 140 });
      const raster = dbg.layerManager.getLayers().find((l) => l.model.layerType === 'raster');
      const buf = new Uint8Array(40 * 40 * 4);
      for (let i = 0; i < buf.length; i += 4) { buf[i] = 99; buf[i + 1] = 102; buf[i + 2] = 241; buf[i + 3] = 255; }
      dbg.layerManager.writeRegion(raster.model.id, 300, 200, 40, 40, buf);
      dbg.layerManager.syncPingPong(raster.model.id);
      return { layerId: raster.model.id, w: dbg.layerManager.canvasWidth, h: dbg.layerManager.canvasHeight };
    });

    // Only 1 vertical guide -> vertical align disabled, horizontal align enabled
    assert.equal(await page.locator('[data-testid="align-y-top"]').isDisabled(), true);
    assert.equal(await page.locator('[data-testid="align-x-left"]').isDisabled(), false);

    // Align left to X=140 guide
    await page.locator('[data-testid="align-x-left"]').click();
    await sleep(250);
    const afterAlign = await readBounds(page, info.layerId, info.w, info.h);
    assert.equal(afterAlign?.x, 140, `Expected raster layer aligned to guide X=140, got ${afterAlign?.x}`);

    // Single Ctrl+Z undo restores to x=300
    await page.keyboard.press('Control+z');
    await sleep(250);
    const afterUndo = await readBounds(page, info.layerId, info.w, info.h);
    assert.equal(afterUndo?.x, 300, `Expected Ctrl+Z to restore x=300, got ${afterUndo?.x}`);
    console.log('✓ Step 2: Canvas guide creation, RulerOverlay rendering, guide alignment, and single Ctrl+Z undo verified');

    assert.deepEqual(pageErrors, [], `Electron page errors: ${pageErrors.join('; ')}`);
    console.log('ALL ISOLATED ELECTRON ALIGN L3 SMOKE CHECKS PASSED!');
  } finally {
    if (app) await app.close().catch(() => {});
    await sleep(400);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[Electron Align L3 Smoke] FAILED:', err);
  process.exit(1);
});

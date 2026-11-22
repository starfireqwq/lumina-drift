/**
 * Isolated Electron Desktop Smoke Verification for Plugin API v2.5.
 *
 * Strictly uses a fresh temporary directory for APPDATA, LOCALAPPDATA, and --user-data-dir
 * so the user's running desktop app and Port 3000 Fastify server are never touched.
 *
 * Usage:
 *   node apps/client/scripts/plugin-api-v2-5-electron-smoke.check.cjs
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
const v25KitPath = path.join(clientRoot, 'public/plugins/lumina-motion-atelier.lumina-plugin');

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
}

async function openPluginMenu(page) {
  const directBtn = page.getByRole('button', { name: '插件', exact: true });
  if ((await directBtn.count()) && (await directBtn.first().isVisible())) {
    await directBtn.first().click();
    return;
  }
  await page.locator('header button[title="檔案"]').first().click();
}

async function openPluginManager(page) {
  await openPluginMenu(page);
  await page.getByRole('menuitem', { name: '管理插件…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理插件' });
  await dialog.waitFor({ timeout: 10000 });
  return dialog;
}

async function readActiveRasterAlphaCount(page) {
  return page.evaluate(async () => {
    const dbg = window.__debugPixi;
    if (!dbg?.layerManager) return -1;
    const layers = dbg.layerManager.getLayers().filter((l) => l.model?.isVisible && l.model?.layerType === 'raster');
    if (!layers.length) return 0;
    layers.sort((a, b) => (b.model?.sortOrder ?? 0) - (a.model?.sortOrder ?? 0));
    const target = layers[0];
    const tileSize = 256;
    const occupied = dbg.layerManager.occupiedTiles?.(target.model.id) ?? [];
    const rects = occupied.length > 0
      ? occupied.map((c) => ({ x: c.col * tileSize, y: c.row * tileSize, w: tileSize, h: tileSize }))
      : [{ x: 0, y: 0, w: 512, h: 512 }];
    const bufs = await dbg.layerManager.readAsync(target.model.id, rects);
    let count = 0;
    for (const pixels of bufs) {
      if (!pixels) continue;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) count++;
      }
    }
    return count;
  });
}

async function main() {
  assert.ok(fs.existsSync(v25KitPath), `Missing v2.5 plugin sample: ${v25KitPath}`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-plugin-v25-electron-'));
  console.log(`[Electron v2.5 Smoke] Isolated userDataDir: ${userDataDir}`);

  let app = null;
  try {
    // Session 1: Cold start, install & enable v2.5 sample plugin, test command, panel, custom tool drag + single undo
    const s1 = await launchIsolated(userDataDir);
    app = s1.app;
    const { page, pageErrors } = s1;

    await enterOfflineCanvas(page);
    console.log('✓ Step 1: Isolated Electron launched and entered solo offline canvas');

    const mgr = await openPluginManager(page);
    await mgr.locator('input[type=file]').setInputFiles(v25KitPath);
    await mgr.locator('[data-plugin-api-version="2"]').waitFor({ timeout: 10000 });
    for (const perm of ['timeline:read', 'timeline:write', 'tools', 'input', 'brush']) {
      assert.ok((await mgr.getByText(perm, { exact: true }).count()) >= 1, `Missing permission badge ${perm}`);
    }
    assert.ok((await mgr.getByText(/工具 1/).count()) >= 1, 'Missing tools contribution badge');
    await mgr.getByRole('button', { name: '安裝插件', exact: true }).click();
    const card = mgr.locator('[data-plugin-card="lumina.motion-atelier"]');
    await card.waitFor({ timeout: 10000 });
    await card.locator('[data-plugin-toggle="lumina.motion-atelier"]').click();
    await mgr.getByRole('button', { name: '關閉', exact: true }).last().click();
    await mgr.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    console.log('✓ Step 2: Imported & enabled official v2.5 plugin with all new permission badges');

    // Run v2.5 commands: apply bounce keyframes & watercolor v2 brush
    await openPluginMenu(page);
    await page.getByRole('menuitem', { name: /建立彈跳關鍵影格/ }).click();
    await sleep(400);
    await openPluginMenu(page);
    await page.getByRole('menuitem', { name: /套用濕染動態筆刷 v2/ }).click();
    await sleep(400);
    console.log('✓ Step 3: Executed v2.5 timeline/keyframes and brush-v2 commands');

    // Open declarative ToolWindow panel and inspect timeline
    await openPluginMenu(page);
    await page.getByRole('menuitemcheckbox', { name: /流光動態控制台/ }).click();
    const inspectBtn = page.getByRole('button', { name: '讀取時間軸狀態', exact: true });
    await inspectBtn.waitFor({ state: 'visible', timeout: 10000 });
    await inspectBtn.click();
    await page.getByText(/FPS · Frame/).waitFor({ timeout: 10000 });
    console.log('✓ Step 4: Opened v2.5 ToolWindow panel and inspected timeline state');

    // Select custom plugin tool from ToolRail, drag stroke on canvas, verify painted pixels + single Ctrl+Z undo
    const toolBtn = page.locator('[data-plugin-tool-id="lumina.motion-atelier:starlight-ribbon"]').first();
    await toolBtn.waitFor({ state: 'visible', timeout: 10000 });
    await toolBtn.click();
    await page.locator('[data-plugin-tool-options="lumina.motion-atelier:starlight-ribbon"]').waitFor({ timeout: 10000 });

    const beforeAlpha = await readActiveRasterAlphaCount(page);
    const viewport = page.locator('.atelier-canvas-viewport').first();
    const box = await viewport.boundingBox();
    assert.ok(box && box.width > 100 && box.height > 100, 'Canvas viewport bounding box unavailable');
    const sx = box.x + box.width * 0.35;
    const sy = box.y + box.height * 0.35;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(sx + i * 18, sy + i * 10);
      await sleep(30);
    }
    await page.mouse.up();
    await sleep(600);

    const afterDragAlpha = await readActiveRasterAlphaCount(page);
    assert.ok(afterDragAlpha > beforeAlpha, `Expected starlight-ribbon drag to paint pixels (before=${beforeAlpha}, after=${afterDragAlpha})`);

    // Single Ctrl+Z undo must revert entire custom-tool drag
    await page.keyboard.press('Control+KeyZ');
    await sleep(600);
    const afterUndoAlpha = await readActiveRasterAlphaCount(page);
    assert.equal(afterUndoAlpha, beforeAlpha, `Expected single Ctrl+Z undo to restore pixels (before=${beforeAlpha}, afterUndo=${afterUndoAlpha})`);
    console.log(`✓ Step 5: Custom tool drag painted +${afterDragAlpha - beforeAlpha} px and reverted cleanly in 1 Ctrl+Z`);

    assert.deepEqual(pageErrors, [], `Unexpected page errors in session 1: ${pageErrors.join('; ')}`);
    await app.close();
    app = null;

    // Session 2: Relaunch with SAME isolated userDataDir and verify v2.5 plugin + tool persisted
    const s2 = await launchIsolated(userDataDir);
    app = s2.app;
    await enterOfflineCanvas(s2.page);
    await s2.page.locator('[data-plugin-tool-id="lumina.motion-atelier:starlight-ribbon"]').first().waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(s2.pageErrors, [], `Unexpected page errors in session 2: ${s2.pageErrors.join('; ')}`);
    console.log('✓ Step 6: v2.5 plugin & custom tool persisted cleanly across Electron restart');
    await app.close();
    app = null;

    console.log('ALL ELECTRON PLUGIN API v2.5 SMOKE CHECKS PASSED!');
  } finally {
    if (app) {
      await app.close().catch(() => {});
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors on Windows
    }
  }
}

const hardGuard = setTimeout(() => {
  console.error('[Electron v2.5 Smoke] Hard timeout (120s) exceeded.');
  process.exit(1);
}, 120_000);
hardGuard.unref();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Electron v2.5 Smoke] FAILED:', err);
    process.exit(1);
  });

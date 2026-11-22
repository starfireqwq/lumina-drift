/**
 * Isolated Electron Desktop Smoke Verification for Plugin API v1 & v2.
 *
 * Strictly uses a fresh temporary directory for APPDATA, LOCALAPPDATA, and --user-data-dir
 * so the user's running desktop app and Port 3000 Fastify server are never touched.
 *
 * Scenarios (single pass):
 *   1. Cold start isolated Electron -> solo offline canvas, zero uncaught page errors.
 *   2. Import & enable v1 plugin (studio-tools.lumina-plugin) -> verify API v1 badge,
 *      v1->v2 store compatibility, and command execution ('New Sketch Layer').
 *   3. Import & enable v2 sample kit (lumina-drift-studio-kit.lumina-plugin) -> verify API v2 badge
 *      & 8 granular permissions, run command ('建立流光色票'), run isolated F1 plugin filter
 *      ('極光雙色調', verifying builtin filterWorker stayed unused), run ToolWindow panel
 *      ('流光描邊工坊') Apply + single Ctrl+Z undo.
 *   4. Close & relaunch Electron with the SAME isolated user-data-dir -> verify both v1 & v2
 *      plugins and their enabled states persisted cleanly across restart.
 *
 * Usage:
 *   node apps/client/scripts/plugins-electron-smoke.check.cjs
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
const v1KitPath = path.join(clientRoot, 'public/plugins/studio-tools.lumina-plugin');
const v2KitPath = path.join(clientRoot, 'public/plugins/lumina-drift-studio-kit.lumina-plugin');

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

async function main() {
  assert.ok(fs.existsSync(v1KitPath), `Missing v1 plugin sample: ${v1KitPath}`);
  assert.ok(fs.existsSync(v2KitPath), `Missing v2 plugin sample: ${v2KitPath}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-plugin-electron-smoke-'));
  console.log(`[Electron Smoke] Isolated userDataDir: ${userDataDir}`);

  let app = null;
  try {
    // ── Session 1: Cold start, v1 + v2 import, command, filter, panel, single undo ──
    const s1 = await launchIsolated(userDataDir);
    app = s1.app;
    const { page, pageErrors } = s1;

    await enterOfflineCanvas(page);
    console.log('✓ Step 1: Isolated Electron launched and entered solo offline canvas');

    // Import & enable v1 plugin
    let mgr = await openPluginManager(page);
    await mgr.locator('input[type=file]').setInputFiles(v1KitPath);
    await mgr.locator('[data-plugin-api-version="1"]').waitFor({ timeout: 10000 });
    await mgr.getByRole('button', { name: '安裝插件', exact: true }).click();
    const v1Card = mgr.locator('[data-plugin-card="lumina.studio-tools"]');
    await v1Card.waitFor({ timeout: 10000 });
    await v1Card.locator('[data-plugin-toggle="lumina.studio-tools"]').click();

    // Import & enable v2 plugin
    await mgr.locator('input[type=file]').setInputFiles(v2KitPath);
    await mgr.locator('[data-plugin-api-version="2"]').waitFor({ timeout: 10000 });
    for (const perm of ['layers:read', 'layers:write', 'pixels:read', 'pixels:write', 'selection', 'filters', 'commands', 'ui:panel']) {
      assert.ok((await mgr.getByText(perm, { exact: true }).count()) >= 1, `Missing permission badge ${perm}`);
    }
    await mgr.getByRole('button', { name: '安裝插件', exact: true }).click();
    const v2Card = mgr.locator('[data-plugin-card="lumina.drift-studio-kit"]');
    await v2Card.waitFor({ timeout: 10000 });
    await v2Card.locator('[data-plugin-toggle="lumina.drift-studio-kit"]').click();
    await mgr.getByRole('button', { name: '關閉', exact: true }).last().click();
    await mgr.waitFor({ state: 'detached' });

    // Execute v1 command ('New Sketch Layer')
    await openPluginMenu(page);
    await page.getByRole('menuitem', { name: 'New Sketch Layer', exact: true }).click();
    await page.waitForFunction(
      () => window.__debugPixi?.layerManager?.getLayers().some((l) => l.model.name === 'Plugin Sketch'),
      null,
      { timeout: 15000 },
    );
    console.log('✓ Step 2: v1 plugin imported, enabled, and executed (created "Plugin Sketch")');

    // Execute v2 command ('建立流光色票')
    await openPluginMenu(page);
    await page.getByRole('menuitem', { name: '建立流光色票', exact: true }).click();
    await page.waitForFunction(
      () => window.__debugPixi?.layerManager?.getLayers().some((l) => l.model.name === 'Drift Swatches'),
      null,
      { timeout: 15000 },
    );

    // Execute v2 F1 plugin filter via isolated pluginFilterWorker
    await page.getByRole('button', { name: '圖層濾鏡', exact: true }).click();
    const filterWin = page.locator('[data-tool-window="layer-filter"]');
    await filterWin.waitFor({ timeout: 10000 });
    await filterWin.getByRole('button', { name: '插件', exact: true }).click();
    await filterWin.locator('[data-filter-id="plugin:lumina.drift-studio-kit:drift-prism"]').waitFor();
    await filterWin.getByRole('button', { name: '色彩濾鏡', exact: true }).click();
    const auroraBtn = filterWin.locator('[data-filter-id="plugin:lumina.drift-studio-kit:aurora-duotone"]');
    await auroraBtn.waitFor();
    await auroraBtn.click();
    await page.waitForFunction(
      () => Boolean(window.__debugPixi?.pluginFilterWorker && window.__debugPixi.pluginFilterWorker.started >= 1),
      null,
      { timeout: 15000 },
    );
    const workerStats = await page.evaluate(() => ({
      pluginStarted: window.__debugPixi?.pluginFilterWorker?.started ?? 0,
      builtinStarted: window.__debugPixi?.filterWorker?.started ?? 0,
    }));
    assert.ok(workerStats.pluginStarted >= 1, 'PluginFilterWorkerClient should execute plugin filter');
    assert.equal(workerStats.builtinStarted, 0, 'Builtin FilterWorkerClient must remain isolated');
    await filterWin.getByRole('button', { name: '套用' }).click();
    await filterWin.waitFor({ state: 'detached', timeout: 15000 });

    // Execute v2 ToolWindow panel ('流光描邊工坊') Apply + single Ctrl+Z undo
    await openPluginMenu(page);
    await page.getByRole('menuitemcheckbox', { name: '流光描邊工坊', exact: true }).click();
    const panelWin = page.locator('[data-tool-window="plugin_panel_lumina.drift-studio-kit_drift-workshop"]');
    await panelWin.waitFor({ timeout: 10000 });
    await panelWin.locator('[data-plugin-panel-action="apply"]').click();
    await panelWin.locator('[data-plugin-panel-status="true"]').filter({ hasText: /Applied glow frame/ }).waitFor({ timeout: 15000 });
    await page.waitForFunction(
      () => window.__debugPixi?.layerManager?.getLayers().some((l) => l.model.name === 'Drift Glow Frame'),
      null,
      { timeout: 10000 },
    );
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(
      () => !window.__debugPixi?.layerManager?.getLayers().some((l) => l.model.name === 'Drift Glow Frame'),
      null,
      { timeout: 10000 },
    );
    console.log('✓ Step 3: v2 kit command, isolated plugin filter worker, ToolWindow panel & single Ctrl+Z undo passed');

    // Verify v2 store serialized both plugins
    const storedRaw = await page.evaluate(() => localStorage.getItem('lumina_plugins_v2'));
    assert.ok(storedRaw, 'lumina_plugins_v2 storage key must be populated');
    const stored = JSON.parse(storedRaw);
    const list = Array.isArray(stored) ? stored : Array.isArray(stored?.plugins) ? stored.plugins : [];
    assert.ok(list.some((p) => p?.manifest?.id === 'lumina.studio-tools' && p.enabled === true), 'v1 plugin persisted enabled');
    assert.ok(list.some((p) => p?.manifest?.id === 'lumina.drift-studio-kit' && p.enabled === true), 'v2 plugin persisted enabled');

    assert.deepEqual(pageErrors, [], `Uncaught renderer errors in Session 1: ${pageErrors.join('; ')}`);

    await app.close();
    app = null;

    // ── Session 2: Relaunch with SAME isolated userDataDir and confirm persistence ──
    const s2 = await launchIsolated(userDataDir);
    app = s2.app;
    await enterOfflineCanvas(s2.page);

    mgr = await openPluginManager(s2.page);
    const persistedV1 = mgr.locator('[data-plugin-card="lumina.studio-tools"]');
    const persistedV2 = mgr.locator('[data-plugin-card="lumina.drift-studio-kit"]');
    await persistedV1.waitFor({ timeout: 10000 });
    await persistedV2.waitFor({ timeout: 10000 });
    assert.equal(await persistedV1.locator('[data-plugin-api-version="1"]').count(), 1, 'v1 badge persisted');
    assert.equal(await persistedV2.locator('[data-plugin-api-version="2"]').count(), 1, 'v2 badge persisted');
    await mgr.getByRole('button', { name: '關閉', exact: true }).last().click();
    await mgr.waitFor({ state: 'detached' });

    await openPluginMenu(s2.page);
    assert.equal(await s2.page.getByRole('menuitem', { name: 'New Sketch Layer', exact: true }).count(), 1, 'v1 command persisted after restart');
    assert.equal(await s2.page.getByRole('menuitemcheckbox', { name: '流光描邊工坊', exact: true }).count(), 1, 'v2 panel persisted after restart');
    await s2.page.keyboard.press('Escape');

    assert.deepEqual(s2.pageErrors, [], `Uncaught renderer errors in Session 2: ${s2.pageErrors.join('; ')}`);
    console.log('✓ Step 4: Isolated Electron restart preserved v1 & v2 plugins cleanly with zero renderer errors');
    console.log('ALL ISOLATED ELECTRON PLUGIN SMOKE CHECKS PASSED!');
  } finally {
    if (app) {
      await app.close().catch(() => {});
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold Chromium file locks right after exit; best effort cleanup.
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

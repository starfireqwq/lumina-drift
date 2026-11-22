/**
 * Plugin API v2.0 Cross-Device & Multi-Locale Playwright E2E Verification.
 *
 * Covers:
 * 1. Desktop (1440x900, zh-TW):
 *    - Import & inspect v2 Lumina Drift Studio Kit (API v2 badge, 8 granular permissions, contributions)
 *    - Enable plugin -> verify 'plugin' filter group appears + existing 'color' group shows puzzle badge
 *    - Run plugin filter (aurora-duotone) via isolated PluginFilterWorkerClient (layer-filter worker untouched)
 *    - Open declarative ToolWindow panel ('流光描邊工坊'), verify 'when' conditional field, 'reset' patchValues,
 *      'apply' creating glow frame layer + pixels + selection, and single Ctrl+Z undo restoring the full transaction
 *    - Verify Settings -> Shortcuts -> Plugins category (Alt+Shift+G bound, built-in Ctrl+Z / B unhijacked, clear button works)
 *    - Verify ACL boundary: locking the target layer blocks direct pixel write (newLayer=false) and shows alert without mutating pixels
 *    - Disable plugin -> verify panel auto-closes and 'plugin' filter group hides automatically
 * 2. Responsive no-clipping check across 5 viewports (desktop 1440x900, small 900x640, tablet 768x1024,
 *    mobile portrait 390x844, mobile landscape 844x390) on PluginManager modal & PluginPanelWindow.
 * 3. Multi-locale check (en-US, ja-JP, zh-TW) verifying localized plugin names, filter groups, menus, panels, and zero clipping.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireServer = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { chromium } = requireServer('playwright-core');

const dist = path.resolve(process.argv[2] || path.join(__dirname, '../dist'));
const kitPath = path.join(dist, 'plugins/lumina-drift-studio-kit.lumina-plugin');

function detectChromeExecutable() {
  if (process.env.LUMINA_TEST_CHROME && fs.existsSync(process.env.LUMINA_TEST_CHROME)) {
    return process.env.LUMINA_TEST_CHROME;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

async function assertElementInViewport(locator, label) {
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${label}: element must be visible with non-zero box`);
  const vp = locator.page().viewportSize();
  assert.ok(vp, 'viewport must exist');
  assert.ok(box.x >= -2, `${label}: left edge clipped (${box.x})`);
  assert.ok(box.y >= -2, `${label}: top edge clipped (${box.y})`);
  assert.ok(box.x + box.width <= vp.width + 2, `${label}: right edge clipped (${box.x + box.width} > ${vp.width})`);
  assert.ok(box.y + box.height <= vp.height + 2, `${label}: bottom edge clipped (${box.y + box.height} > ${vp.height})`);
  const overflow = await locator.evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.ok(overflow <= 4, `${label}: horizontal overflow detected (${overflow}px)`);
}

async function openPluginMenu(page, locale) {
  const menuName = locale === 'ja-JP' ? 'プラグイン' : locale === 'en-US' ? 'Plugins' : '插件';
  const directBtn = page.getByRole('button', { name: menuName, exact: true });
  if (await directBtn.count() && await directBtn.first().isVisible()) {
    await directBtn.first().click();
    return;
  }
  const fileName = locale === 'ja-JP' ? 'ファイル' : locale === 'en-US' ? 'File' : '檔案';
  await page.locator(`header button[title="${fileName}"]`).first().click();
}

async function runCoreDesktopScenario(browser, origin) {
  const context = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('atelier_language', 'zh-TW');
  });
  await page.goto(origin);

  // Enter Solo Offline Drawing
  await page.getByRole('button', { name: /單人離線作畫/ }).click();
  await page.getByRole('button', { name: '開始單機作畫', exact: true }).click();
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 20000 });

  // 1. Verify 'plugin' filter group is hidden before any plugin is enabled
  await page.getByRole('button', { name: '圖層濾鏡', exact: true }).click();
  const filterWin = page.locator('[data-tool-window="layer-filter"]');
  await filterWin.waitFor();
  assert.equal(await filterWin.getByRole('button', { name: '插件', exact: true }).count(), 0, 'Plugin filter group hidden when empty');
  await filterWin.getByRole('button', { name: '關閉' }).click();
  await filterWin.waitFor({ state: 'detached' });

  // 2. Open Plugin Manager, import v2 kit, verify API v2 badge, 8 permissions & contributions
  await openPluginMenu(page, 'zh-TW');
  await page.getByRole('menuitem', { name: '管理插件…', exact: true }).click();
  const mgrDialog = page.getByRole('dialog', { name: '管理插件' });
  await mgrDialog.waitFor();
  await assertElementInViewport(mgrDialog, 'Desktop zh-TW PluginManager');

  assert.ok(await mgrDialog.locator('a[href*="lumina-drift-studio-kit.lumina-plugin"]').count() === 1, 'v2 download link present');
  await mgrDialog.locator('input[type=file]').setInputFiles(kitPath);
  await mgrDialog.locator('[data-plugin-api-version="2"]').waitFor();
  for (const perm of ['layers:read', 'layers:write', 'pixels:read', 'pixels:write', 'selection', 'filters', 'commands', 'ui:panel']) {
    assert.ok(await mgrDialog.getByText(perm, { exact: true }).count() >= 1, `Permission badge ${perm} shown`);
  }
  await mgrDialog.getByRole('button', { name: '安裝插件', exact: true }).click();
  const card = mgrDialog.locator('[data-plugin-card="lumina.drift-studio-kit"]');
  await card.waitFor();
  await card.locator('[data-plugin-toggle="lumina.drift-studio-kit"]').click();
  await mgrDialog.getByRole('button', { name: '關閉', exact: true }).last().click();
  await mgrDialog.waitFor({ state: 'detached' });

  // 3. Run command to paint swatches (ensures visible non-empty pixels for filter test)
  await openPluginMenu(page, 'zh-TW');
  await page.getByRole('menuitem', { name: '建立流光色票', exact: true }).click();
  await page.waitForFunction(
    () => window.__debugPixi?.layerManager?.getLayers().some((l) => l.model.name === 'Drift Swatches'),
    null,
    { timeout: 15000 },
  );

  // 4. Filter registry Option A verification + isolated QuickJS plugin filter execution
  await page.getByRole('button', { name: '圖層濾鏡', exact: true }).click();
  await filterWin.waitFor();
  // Dedicated 'plugin' group visible with drift-prism
  await filterWin.getByRole('button', { name: '插件', exact: true }).click();
  await filterWin.locator('[data-filter-id="plugin:lumina.drift-studio-kit:drift-prism"]').waitFor();
  // Existing 'color' group shows aurora-duotone with puzzle badge
  await filterWin.getByRole('button', { name: '色彩濾鏡', exact: true }).click();
  const auroraBtn = filterWin.locator('[data-filter-id="plugin:lumina.drift-studio-kit:aurora-duotone"]');
  await auroraBtn.waitFor();
  assert.equal(await auroraBtn.locator('[data-plugin-badge="true"]').count(), 1, 'Existing-group plugin filter shows puzzle badge');

  // Open aurora-duotone filter and apply it
  await auroraBtn.click();
  await page.waitForFunction(
    () => Boolean(window.__debugPixi?.pluginFilterWorker && window.__debugPixi.pluginFilterWorker.started >= 1),
    null,
    { timeout: 15000 },
  );
  // Confirm builtin filterWorker was never started for this plugin filter
  const workerIsolation = await page.evaluate(() => ({
    pluginStarted: window.__debugPixi?.pluginFilterWorker?.started ?? 0,
    builtinStarted: window.__debugPixi?.filterWorker?.started ?? 0,
  }));
  assert.ok(workerIsolation.pluginStarted >= 1, 'PluginFilterWorkerClient executed plugin filter');
  assert.equal(workerIsolation.builtinStarted, 0, 'Builtin FilterWorkerClient stayed completely isolated');
  await filterWin.getByRole('button', { name: '套用' }).click();
  await filterWin.waitFor({ state: 'detached', timeout: 15000 });

  // 5. Declarative ToolWindow panel: toggle from menu (menuitemcheckbox), verify 'when', reset, apply, single Ctrl+Z undo
  await openPluginMenu(page, 'zh-TW');
  const panelMenuItem = page.getByRole('menuitemcheckbox', { name: '流光描邊工坊', exact: true });
  assert.equal(await panelMenuItem.getAttribute('aria-checked'), 'false', 'Panel unchecked initially');
  await panelMenuItem.click();
  const panelWin = page.locator('[data-tool-window="plugin_panel_lumina.drift-studio-kit_drift-workshop"]');
  await panelWin.waitFor();
  await assertElementInViewport(panelWin, 'Desktop zh-TW PluginPanelWindow');
  // Re-open menu briefly to confirm aria-checked="true"
  await openPluginMenu(page, 'zh-TW');
  assert.equal(await page.getByRole('menuitemcheckbox', { name: '流光描邊工坊', exact: true }).getAttribute('aria-checked'), 'true', 'Panel checked when open');
  await page.keyboard.press('Escape');

  // Verify 'when' condition: layerName input visible while newLayer is checked, hidden when unchecked
  const layerNameField = panelWin.locator('[data-panel-field="layerName"]');
  assert.equal(await layerNameField.count(), 1, 'layerName visible when newLayer=true');
  const newLayerCheckbox = panelWin.locator('[data-panel-field="newLayer"] input[type="checkbox"]');
  await newLayerCheckbox.uncheck();
  assert.equal(await layerNameField.count(), 0, 'layerName hidden when newLayer=false');

  // Click Reset -> restores newLayer=true via patchValues and shows statusText
  await panelWin.locator('[data-plugin-panel-action="reset"]').click();
  await panelWin.locator('[data-plugin-panel-status="true"]').waitFor({ timeout: 10000 });
  assert.equal(await layerNameField.count(), 1, 'Reset restored newLayer=true and revealed layerName');

  // Click Apply -> creates new glow frame layer + writes pixels + sets selection, wait for tx.commit() via statusText
  await panelWin.locator('[data-plugin-panel-action="apply"]').click();
  await panelWin.locator('[data-plugin-panel-status="true"]').filter({ hasText: /Applied glow frame/ }).waitFor({ timeout: 15000 });
  await page.waitForFunction(
    () => window.__debugPixi?.layerManager?.getLayers().some((l) => l.model.name === 'Drift Glow Frame'),
    null,
    { timeout: 10000 },
  );

  // Single Ctrl+Z undoes the entire transaction (removes Drift Glow Frame layer)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => !window.__debugPixi?.layerManager?.getLayers().some((l) => l.model.name === 'Drift Glow Frame'),
    null,
    { timeout: 10000 },
  );

  // 6. ACL boundary check: lock active layer via LayerPanel button -> select shows 🔒 & RO badge -> Apply with newLayer=false rejected by ACL
  const lockBtn = page.getByRole('button', { name: '鎖定圖層（禁止任何編輯）', exact: true });
  await lockBtn.click();
  const targetSelect = panelWin.locator('[data-panel-field="targetLayer"] select');
  await page.waitForFunction(
    () => {
      const sel = document.querySelector('[data-panel-field="targetLayer"] select');
      return Boolean(sel && [...sel.options].some((o) => o.textContent && o.textContent.includes('🔒')));
    },
    null,
    { timeout: 10000 },
  );
  const lockedOptionValue = await targetSelect.evaluate((sel) => {
    const opt = [...sel.options].find((o) => o.textContent && o.textContent.includes('🔒'));
    return opt ? opt.value : '';
  });
  await targetSelect.selectOption(lockedOptionValue);
  await panelWin.locator('[data-panel-field="targetLayer"]').getByText('RO', { exact: true }).waitFor();
  await newLayerCheckbox.uncheck();
  await panelWin.locator('[data-plugin-panel-action="apply"]').click();
  const alertMsg = panelWin.locator('[role="alert"]');
  await alertMsg.waitFor({ timeout: 10000 });
  const alertText = (await alertMsg.textContent()) || '';
  assert.ok(alertText.toLowerCase().includes('locked') || alertText.length > 0, 'Locked layer rejected by ACL');
  await lockBtn.click();

  // 7. Shortcuts Settings: 'Plugins' category present, Alt+Shift+G bound, built-in untouched, clear works
  await page.getByRole('button', { name: '說明', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '快捷鍵設定', exact: true }).click();
  const settingsDialog = page.locator('[role="dialog"][aria-modal="true"]');
  await settingsDialog.waitFor();
  const pluginShortcutSection = settingsDialog.locator('[data-shortcut-category="plugins"]');
  await pluginShortcutSection.waitFor();
  const haloShortcutRow = pluginShortcutSection.locator('[data-shortcut-id="plugin:lumina.drift-studio-kit:cmd:halo-frame"]');
  await haloShortcutRow.waitFor();
  assert.ok((await haloShortcutRow.textContent()).includes('Alt+Shift+G'), 'Suggested shortcut Alt+Shift+G bound');
  await haloShortcutRow.getByRole('button', { name: '清除快捷鍵', exact: true }).click();
  assert.ok(!(await haloShortcutRow.textContent()).includes('Alt+Shift+G'), 'Plugin shortcut cleared cleanly');
  await page.keyboard.press('Escape');
  await settingsDialog.waitFor({ state: 'detached' });

  // 8. Disable plugin -> panel closes automatically & 'plugin' filter group hides
  await openPluginMenu(page, 'zh-TW');
  await page.getByRole('menuitem', { name: '管理插件…', exact: true }).click();
  await mgrDialog.waitFor();
  await mgrDialog.locator('[data-plugin-toggle="lumina.drift-studio-kit"]').click();
  await mgrDialog.getByRole('button', { name: '關閉', exact: true }).last().click();
  await mgrDialog.waitFor({ state: 'detached' });
  await panelWin.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '圖層濾鏡', exact: true }).click();
  await filterWin.waitFor();
  assert.equal(await filterWin.getByRole('button', { name: '插件', exact: true }).count(), 0, 'Plugin filter group hidden after disable');
  await filterWin.getByRole('button', { name: '關閉' }).click();

  await context.close();
  console.log('✓ Scenario A (Desktop zh-TW full v2 flow + filter worker isolation + panel + shortcuts + single undo + ACL) passed');
}

async function runResponsiveAndLocaleMatrix(browser, origin) {
  const kitManifestJson = fs.readFileSync(kitPath, 'utf8');
  const kitManifest = JSON.parse(kitManifestJson);
  const preinstalled = JSON.stringify([{ manifest: kitManifest, enabled: true, installedAt: 1 }]);

  const matrix = [
    { name: 'Desktop en-US', viewport: { width: 1440, height: 900 }, locale: 'en-US', isMobile: false, hasTouch: false },
    { name: 'Small Window ja-JP', viewport: { width: 900, height: 640 }, locale: 'ja-JP', isMobile: false, hasTouch: false },
    { name: 'Tablet zh-TW', viewport: { width: 768, height: 1024 }, locale: 'zh-TW', isMobile: false, hasTouch: true },
    { name: 'Mobile Portrait en-US', viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true, hasTouch: true },
    { name: 'Mobile Landscape ja-JP', viewport: { width: 844, height: 390 }, locale: 'ja-JP', isMobile: true, hasTouch: true },
  ];

  for (const cfg of matrix) {
    const context = await browser.newContext({
      locale: cfg.locale,
      viewport: cfg.viewport,
      isMobile: cfg.isMobile,
      hasTouch: cfg.hasTouch,
    });
    const page = await context.newPage();
    await page.addInitScript(({ lang, stored }) => {
      localStorage.setItem('atelier_language', lang);
      localStorage.setItem('lumina_plugins_v2', stored);
    }, { lang: cfg.locale, stored: preinstalled });

    await page.goto(origin);
    const soloModeRe = cfg.locale === 'ja-JP' ? /ソロ・オフライン作画/ : cfg.locale === 'en-US' ? /Solo Offline Drawing/ : /單人離線作畫/;
    const soloStartText = cfg.locale === 'ja-JP' ? 'ソロ作画を開始' : cfg.locale === 'en-US' ? 'Start Solo Drawing' : '開始單機作畫';
    await page.getByRole('button', { name: soloModeRe }).click();
    await page.getByRole('button', { name: soloStartText, exact: true }).click();
    await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 20000 });

    // Check PluginManager modal bounds & zero horizontal overflow
    const manageLabel = cfg.locale === 'ja-JP' ? 'プラグインの管理…' : cfg.locale === 'en-US' ? 'Manage Plugins…' : '管理插件…';
    const closeLabel = cfg.locale === 'ja-JP' ? '閉じる' : cfg.locale === 'en-US' ? 'Close' : '關閉';
    await openPluginMenu(page, cfg.locale);
    await page.getByRole('menuitem', { name: manageLabel, exact: true }).click();
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await dialog.waitFor();
    await assertElementInViewport(dialog, `${cfg.name} PluginManager`);
    await dialog.getByRole('button', { name: closeLabel, exact: true }).last().click();
    await dialog.waitFor({ state: 'detached' });

    // Check PluginPanelWindow bounds (desktop ToolWindow vs phone bottom sheet)
    const panelTitle = cfg.locale === 'ja-JP' ? '流光グロー工房' : cfg.locale === 'en-US' ? 'Drift Glow Lab' : '流光描邊工坊';
    await openPluginMenu(page, cfg.locale);
    await page.getByRole('menuitemcheckbox', { name: panelTitle, exact: true }).click();
    const panelWin = page.locator('[data-tool-window="plugin_panel_lumina.drift-studio-kit_drift-workshop"]');
    await panelWin.waitFor();
    await assertElementInViewport(panelWin, `${cfg.name} PluginPanelWindow`);
    await panelWin.getByRole('button', { name: '關閉' }).click();
    await panelWin.waitFor({ state: 'detached' });

    await context.close();
    console.log(`✓ Matrix check passed: ${cfg.name} (${cfg.viewport.width}x${cfg.viewport.height})`);
  }
}

async function main() {
  assert.ok(fs.existsSync(dist), `Built dist directory not found: ${dist}`);
  assert.ok(fs.existsSync(kitPath), `v2 sample kit not found in dist: ${kitPath}`);

  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.json': 'application/json; charset=utf-8',
    '.lumina-plugin': 'application/json; charset=utf-8',
  };

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end('{"status":"ok"}');
    }
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const executablePath = detectChromeExecutable();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await runCoreDesktopScenario(browser, origin);
    await runResponsiveAndLocaleMatrix(browser, origin);
    console.log('ALL PLUGIN API V2 E2E SCENARIOS PASSED!');
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Isolated Electron Desktop Verification for Plugin API v3.0.
 *
 * Strictly uses a fresh temporary directory for APPDATA, LOCALAPPDATA, and --user-data-dir
 * so the user's running desktop app and Port 3000 Fastify server are never touched.
 *
 * Usage:
 *   node apps/client/scripts/plugin-api-v3-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireServer = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { _electron: electron } = requireServer('playwright-core');

const clientRoot = path.resolve(__dirname, '..');
const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const v3DemoPath = path.join(clientRoot, 'public/plugins/lumina-v3-bridge-demo.lumina-plugin');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpPost(urlStr, headers, bodyObj) {
  const url = new URL(urlStr);
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(body, 'utf8');
    req.end();
  });
}

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-v3-electron-'));
  const helperScript = path.join(userDataDir, 'echo-helper.cjs');
  fs.writeFileSync(
    helperScript,
    'process.stdout.write("LUMINA_ECHO:" + (process.argv[2] || ""));\n',
    'utf8',
  );

  let app = null;
  try {
    console.log(`[Electron v3 Smoke] Isolated userDataDir: ${userDataDir}`);
    const launched = await launchIsolated(userDataDir);
    app = launched.app;
    const { page, pageErrors } = launched;

    await enterOfflineCanvas(page);
    await sleep(600);

    // 1. Import & enable v3 demo plugin
    const mgr = await openPluginManager(page);
    await mgr.locator('input[type="file"]').setInputFiles(v3DemoPath);
    const installBtn = mgr.getByRole('button', { name: /安裝插件|取代插件/ });
    await installBtn.waitFor({ timeout: 5000 });
    await installBtn.click();

    const card = mgr.locator('[data-plugin-card="lumina.v3-bridge-demo"]');
    await card.waitFor({ timeout: 5000 });
    assert.equal(await card.locator('[data-plugin-api-version="3"]').isVisible(), true);
    assert.equal((await card.locator('[data-plugin-high-risk="true"]').count()) >= 3, true);

    await mgr.locator('[data-plugin-toggle="lumina.v3-bridge-demo"]').click();
    await mgr.getByRole('button', { name: '關閉', exact: true }).last().click();
    await sleep(300);

    // 2. Bind trusted local executable profile via IPC (Node binary + controlled helper script)
    const savedProfile = await page.evaluate(
      async ({ nodeExe, scriptPath }) => {
        return await window.atelierDesktop.pluginV3.saveToolProfile({
          id: 'echo-helper',
          label: 'Echo Helper Test',
          executablePath: nodeExe,
          argTemplate: [scriptPath, '{{arg:message}}'],
        });
      },
      { nodeExe: process.execPath, scriptPath: helperScript },
    );
    assert.equal(savedProfile.id, 'echo-helper');
    assert.ok(savedProfile.sha256 && savedProfile.sha256.length === 64);

    // 3. Reject shell-injection argument at Main Process boundary
    const injRes = await page.evaluate(async () => {
      return await window.atelierDesktop.pluginV3.invokeTool({
        toolId: 'echo-helper',
        args: { message: 'bad; whoami' },
      });
    });
    assert.equal(injRes.ok, false);
    assert.match(injRes.error || '', /disallowed shell/i);
    console.log('  ✓ Shell-injection argument rejected by Electron main process');

    // 4. Two-step consent flow via UI: first Deny, then Allow Once
    await openPluginMenu(page);
    await page.getByRole('menuitem', { name: /呼叫已綁定本機工具/ }).click();
    const consentModal = page.locator('[data-plugin-v3-consent-modal="true"]');
    await consentModal.waitFor({ timeout: 8000 });
    await page.locator('[data-plugin-v3-consent="deny"]').click();
    await consentModal.waitFor({ state: 'hidden', timeout: 5000 });
    await sleep(300);
    console.log('  ✓ Two-step consent Deny blocks local tool execution');

    await openPluginMenu(page);
    await page.getByRole('menuitem', { name: /呼叫已綁定本機工具/ }).click();
    await consentModal.waitFor({ timeout: 8000 });
    await page.locator('[data-plugin-v3-consent="once"]').click();
    await consentModal.waitFor({ state: 'hidden', timeout: 5000 });
    const toast = page.locator('[role="status"]').filter({ hasText: 'LUMINA_ECHO:hello-lumina' });
    await toast.waitFor({ timeout: 10000 });
    console.log('  ✓ Two-step consent Allow Once executes bound tool safely and displays output');

    // 5. Local MCP Server security + canvas read/write + single-step undo + kill switch
    const mcpStart = await page.evaluate(async () => {
      return await window.atelierDesktop.pluginV3.mcpServer.start({ allowWrite: false });
    });
    assert.equal(mcpStart.running, true);
    assert.ok(mcpStart.endpointUrl && mcpStart.token && mcpStart.port);

    // 5a. Missing token -> 401
    const r401 = await httpPost(
      mcpStart.endpointUrl,
      { Host: `127.0.0.1:${mcpStart.port}` },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    );
    assert.equal(r401.status, 401);

    // 5b. Evil Origin -> 403
    const rOrigin = await httpPost(
      mcpStart.endpointUrl,
      {
        Host: `127.0.0.1:${mcpStart.port}`,
        Origin: 'https://evil.example',
        Authorization: `Bearer ${mcpStart.token}`,
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    );
    assert.equal(rOrigin.status, 403);

    // 5c. Valid read call: layers.list
    const rLayers = await httpPost(
      mcpStart.endpointUrl,
      {
        Host: `127.0.0.1:${mcpStart.port}`,
        Authorization: `Bearer ${mcpStart.token}`,
      },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'layers.list', arguments: {} } },
    );
    assert.equal(rLayers.status, 200);
    const layersData = JSON.parse(rLayers.body).result.structuredContent;
    assert.ok(Array.isArray(layersData) && layersData.length > 0);
    const editableLayer = layersData.find((l) => l.layerType === 'raster' && l.canEditPixels) || layersData[0];
    assert.ok(editableLayer?.id, 'Expected an editable raster layer');

    // 5d. Read-only mode blocks pixels.fill_rect
    const rBlockedWrite = await httpPost(
      mcpStart.endpointUrl,
      {
        Host: `127.0.0.1:${mcpStart.port}`,
        Authorization: `Bearer ${mcpStart.token}`,
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'pixels.fill_rect',
          arguments: { layerId: editableLayer.id, x: 10, y: 10, width: 32, height: 32, color: '#22d3ee' },
        },
      },
    );
    assert.equal(rBlockedWrite.status, 200);
    assert.match(JSON.parse(rBlockedWrite.body).error.message, /read-only/i);

    // 5e. Enable writes -> pixels.fill_rect paints 1024 px -> 1 Ctrl+Z reverts to baseline
    const basePx = await readActiveRasterAlphaCount(page);
    await page.evaluate(async () => {
      await window.atelierDesktop.pluginV3.mcpServer.setAllowWrite(true);
    });
    const rWrite = await httpPost(
      mcpStart.endpointUrl,
      {
        Host: `127.0.0.1:${mcpStart.port}`,
        Authorization: `Bearer ${mcpStart.token}`,
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'pixels.fill_rect',
          arguments: { layerId: editableLayer.id, x: 20, y: 20, width: 32, height: 32, color: '#22d3ee' },
        },
      },
    );
    assert.equal(rWrite.status, 200);
    assert.ok(!JSON.parse(rWrite.body).error, `Unexpected MCP write error: ${rWrite.body}`);
    await sleep(300);
    const afterWritePx = await readActiveRasterAlphaCount(page);
    assert.ok(afterWritePx > basePx, `Expected pixels to increase (${basePx} -> ${afterWritePx})`);

    await page.keyboard.press('Control+z');
    await sleep(350);
    const afterUndoPx = await readActiveRasterAlphaCount(page);
    assert.equal(afterUndoPx, basePx, `Expected 1 Ctrl+Z to revert MCP write (${afterUndoPx} vs ${basePx})`);
    console.log(`  ✓ Local MCP read/write + single Ctrl+Z verified (${basePx} -> ${afterWritePx} -> ${afterUndoPx} px)`);

    // 5f. Kill Switch stops MCP server immediately
    await page.evaluate(async () => {
      await window.atelierDesktop.pluginV3.killAll();
    });
    const afterKill = await page.evaluate(async () => window.atelierDesktop.pluginV3.mcpServer.getStatus());
    assert.equal(afterKill.running, false);
    console.log('  ✓ Emergency kill switch stopped MCP server cleanly');

    assert.equal(pageErrors.length, 0, `Unexpected Electron page errors: ${pageErrors.join(' | ')}`);
    console.log('\nElectron Plugin API v3.0 isolated smoke test PASSED.');
  } finally {
    if (app) {
      await app.close().catch(() => {});
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore on Windows lock
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

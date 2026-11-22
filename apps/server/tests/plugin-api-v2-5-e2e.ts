/**
 * Plugin API v2.5 End-to-End Verification:
 *   1. Web 5 viewports (Desktop 1440x900, Compact 960x700, Tablet 1024x768, Phone Portrait 390x844,
 *      Phone Landscape 844x390) x 4 locales (zh-TW, zh-CN, en-US, ja-JP) overflow/clipping audit
 *      for PluginManager v2.5 badges, ToolRail custom tool button, and ToolOptionsBar custom options.
 *   2. Phone standalone offline mode (390x844): install & enable v2.5 kit, drag Starlight Ribbon
 *      custom tool to paint pixels, verify single Ctrl+Z undo reverts completely.
 *   3. LAN IPv4 + apps/server/tests/net-proxy.ts (25ms one-way / +/-5ms jitter) Multiplayer ACL:
 *      - Viewer (role='viewer') rejected on timeline/keyframes command and custom tool drag;
 *        zero write ops recorded in SQLite & zero keyframes written.
 *      - Editor atomic keyframes.setBatch touching BOTH own layer and Owner's private layer
 *        rejected atomically; own layer keyframes remain empty.
 *      - Editor legitimate bounce keyframes + Starlight Ribbon custom tool drag sync to Owner
 *        through net-proxy and revert cleanly on single Ctrl+Z undo.
 *
 * Uses a throwaway Fastify server on a dedicated test port with an ephemeral DATA_DIR,
 * never touching Port 3000 or 127.0.0.1/localhost for browser connections.
 *
 * Usage:
 *   pnpm --filter @atelier/server exec tsx tests/plugin-api-v2-5-e2e.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVER_DIR = path.resolve(REPO_ROOT, 'apps/server');
const KIT_V25_PATH = path.resolve(REPO_ROOT, 'apps/client/public/plugins/lumina-motion-atelier.lumina-plugin');
const NET_PROXY_SCRIPT = path.resolve(SERVER_DIR, 'tests/net-proxy.ts');
const TSX_CLI = path.resolve(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const SERVER_PORT = Number(process.env.LUMINA_V25_SERVER_PORT || 3991);
const PROXY_PORT = Number(process.env.LUMINA_V25_PROXY_PORT || 3992);
const ONE_WAY_MS = 25;
const JITTER_MS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function detectLanIpv4(): string {
  if (process.env.LUMINA_TEST_LAN_IP) return process.env.LUMINA_TEST_LAN_IP;
  const nets = os.networkInterfaces();
  const candidates: Array<{ addr: string; score: number }> = [];
  for (const list of Object.values(nets)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('127.') || info.address.startsWith('169.254.')) continue;
      const isPrivateLan =
        info.address.startsWith('192.168.') ||
        info.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(info.address);
      candidates.push({ addr: info.address, score: isPrivateLan ? 10 : 1 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  assert.ok(candidates.length > 0, 'No non-loopback IPv4 LAN address found');
  return candidates[0].addr;
}

function detectChromeExecutable(): string {
  if (process.env.LUMINA_TEST_CHROME && fs.existsSync(process.env.LUMINA_TEST_CHROME)) {
    return process.env.LUMINA_TEST_CHROME;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  assert.ok(found, 'Chrome/Edge executable not found');
  return found;
}

async function waitForHealth(baseUrl: string, proc: ChildProcess, label: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return;
    } catch {
      // retry
    }
    if (proc.exitCode !== null) {
      throw new Error(`${label} exited early with code ${proc.exitCode}`);
    }
    await sleep(200);
  }
  throw new Error(`${label} failed to respond at ${baseUrl}/health`);
}

async function api(baseUrl: string, token: string | null, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data as any;
}

const LOCALE_MENU_NAMES: Record<string, { plugins: string; manage: string; manageTitle: string; close: string }> = {
  'zh-TW': { plugins: '插件', manage: '管理插件…', manageTitle: '管理插件', close: '關閉' },
  'zh-CN': { plugins: '插件', manage: '管理插件…', manageTitle: '管理插件', close: '关闭' },
  'en-US': { plugins: 'Plugins', manage: 'Manage Plugins…', manageTitle: 'Manage Plugins', close: 'Close' },
  'ja-JP': { plugins: 'プラグイン', manage: 'プラグインの管理…', manageTitle: 'プラグインの管理', close: '閉じる' },
};

async function openPluginMenu(page: Page, locale: string) {
  const names = LOCALE_MENU_NAMES[locale] ?? LOCALE_MENU_NAMES['zh-TW'];
  const direct = page.getByRole('button', { name: names.plugins, exact: true });
  if ((await direct.count()) && (await direct.first().isVisible())) {
    await direct.first().click();
    return;
  }
  // Compact/phone navbar puts menus inside the collapsed menu button
  const menuBtn = page.locator('header button[aria-haspopup="menu"]').first();
  await menuBtn.click();
}

async function seedPluginInLocalStorage(page: Page, manifestObj: unknown, enabled = true) {
  await page.evaluate(
    ({ manifest, en }) => {
      const key = 'lumina_plugins_v2';
      let list: Array<{ manifest: any; enabled: boolean }> = [];
      try {
        list = JSON.parse(localStorage.getItem(key) || '[]');
      } catch {
        list = [];
      }
      list = list.filter((p) => p?.manifest?.id !== (manifest as any).id);
      list.push({ manifest, enabled: en });
      localStorage.setItem(key, JSON.stringify(list));
    },
    { manifest: manifestObj, en: enabled },
  );
}

async function readLayerAlphaCount(page: Page, layerId: string): Promise<number> {
  return Promise.race([
    page.evaluate(async (id) => {
      const dbg = (window as any).__debugPixi;
      const lm = dbg?.layerManager;
      if (!lm) return -1;
      const item = lm.getLayers().find((l: any) => l.model.id === id);
      if (!item) return -1;
      const w = dbg.viewport?.canvasWidth ?? 512;
      const h = dbg.viewport?.canvasHeight ?? 512;
      const [pixels] = await lm.readAsync(id, [{ x: 0, y: 0, w, h }]);
      if (!pixels) return 0;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) count++;
      }
      return count;
    }, layerId),
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error('readLayerAlphaCount timed out (5s)')), 5000)),
  ]);
}

async function readActiveRasterAlphaCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const dbg = (window as any).__debugPixi;
    if (!dbg?.layerManager) return -1;
    const layers = dbg.layerManager.getLayers().filter((l: any) => l.model?.isVisible && l.model?.layerType === 'raster');
    if (!layers.length) return 0;
    layers.sort((a: any, b: any) => (b.model?.sortOrder ?? 0) - (a.model?.sortOrder ?? 0));
    const target = layers[0];
    const tileSize = 256;
    const occupied = dbg.layerManager.occupiedTiles?.(target.model.id) ?? [];
    const rects = occupied.length > 0
      ? occupied.map((c: { col: number; row: number }) => ({ x: c.col * tileSize, y: c.row * tileSize, w: tileSize, h: tileSize }))
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

async function openRoomPage(
  browser: Browser,
  baseUrl: string,
  canvasId: string,
  token: string | null,
  locale = 'zh-TW',
  viewport = { width: 1440, height: 900 },
  v25Manifest?: unknown,
): Promise<{ ctx: BrowserContext; page: Page; pageErrors: string[] }> {
  const ctx = await browser.newContext({ locale, viewport });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(
    ({ tok, loc, cid, manifest }) => {
      localStorage.setItem('atelier_language', loc);
      localStorage.setItem('atelier_gateway_resolved', '1');
      if (tok) {
        localStorage.setItem('atelier_token', tok);
        localStorage.removeItem('atelier_offline_mode');
      } else {
        localStorage.removeItem('atelier_token');
      }
      if (cid) {
        localStorage.setItem('atelier_active_canvas_id', cid);
      }
      if (manifest && !localStorage.getItem('lumina_plugins_v2')) {
        localStorage.setItem('lumina_plugins_v2', JSON.stringify([{ manifest, enabled: true }]));
      }
    },
    { tok: token, loc: locale, cid: canvasId, manifest: v25Manifest ?? null },
  );
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30000 });
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  if (await dialog.isVisible({ timeout: 1200 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 1, null, {
    timeout: 20000,
  });
  await sleep(300);
  return { ctx, page, pageErrors };
}

async function main() {
  assert.ok(fs.existsSync(KIT_V25_PATH), `Missing v2.5 sample plugin: ${KIT_V25_PATH}`);
  const v25Manifest = JSON.parse(fs.readFileSync(KIT_V25_PATH, 'utf-8'));

  const lanIp = detectLanIpv4();
  const chromeExe = detectChromeExecutable();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-v25-e2e-'));
  const directServerUrl = `http://${lanIp}:${SERVER_PORT}`;
  const proxyBaseUrl = `http://${lanIp}:${PROXY_PORT}`;

  console.log(`[Plugin v2.5 E2E] LAN IP: ${lanIp} | Server: ${directServerUrl} | Proxy: ${proxyBaseUrl}`);

  const serverProc = spawn(process.execPath, [TSX_CLI, 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      HOST: '0.0.0.0',
      DATA_DIR: dataDir,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverStderr = '';
  serverProc.stderr?.on('data', (d) => { serverStderr += String(d); });

  const proxyProc = spawn(
    process.execPath,
    [TSX_CLI, NET_PROXY_SCRIPT, String(PROXY_PORT), String(SERVER_PORT), String(ONE_WAY_MS), '0', '0', String(JITTER_MS)],
    {
      cwd: SERVER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let browser: Browser | null = null;
  try {
    await waitForHealth(directServerUrl, serverProc, 'Fastify test server');
    await waitForHealth(proxyBaseUrl, proxyProc, 'LAN net-proxy');

    // Register 3 users: Owner, Editor, Viewer
    const ownerAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'v25_owner',
      password: 'Password123!',
      displayName: 'Owner',
    });
    const editorAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'v25_editor',
      password: 'Password123!',
      displayName: 'Editor',
    });
    const viewerAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'v25_viewer',
      password: 'Password123!',
      displayName: 'Viewer',
    });

    // Owner creates canvas + private layer
    const createdCanvas = await api(proxyBaseUrl, ownerAuth.token, 'POST', '/api/canvases', {
      title: 'Plugin v2.5 Room',
      width: 512,
      height: 512,
    });
    const canvasId = createdCanvas.canvas.id as string;

    // Fetch initial layers created with canvas
    const initialLayersResp = await api(proxyBaseUrl, ownerAuth.token, 'GET', `/api/canvases/${canvasId}/layers`);
    const ownerPrivateLayer = initialLayersResp.layers.find((l: any) => l.ownerId === ownerAuth.user.id) ?? initialLayersResp.layers[0];
    assert.ok(ownerPrivateLayer, 'Owner must have an initial layer');
    await api(proxyBaseUrl, ownerAuth.token, 'PATCH', `/api/canvases/${canvasId}/layers/${ownerPrivateLayer.id}`, {
      aclMode: 'owner_only',
      isPublic: false,
      name: 'Owner Private',
    });

    // Join Editor and Viewer, then assign Viewer role
    await api(proxyBaseUrl, editorAuth.token, 'POST', '/api/canvases/join', { canvasId });
    await api(proxyBaseUrl, viewerAuth.token, 'POST', '/api/canvases/join', { canvasId });
    {
      const dbPath = path.join(dataDir, 'atelier.db');
      const db = new Database(dbPath);
      try {
        db.prepare(`UPDATE canvas_members SET role = 'viewer' WHERE canvas_id = ? AND user_id = ?`).run(
          canvasId,
          viewerAuth.user.id,
        );
      } finally {
        db.close();
      }
    }

    // Editor creates their own raster layer
    const editorLayerResp = await api(proxyBaseUrl, editorAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'Editor Own Layer',
      aclMode: 'owner_only',
    });
    const editorOwnLayerId = editorLayerResp.layer.id as string;

    browser = await chromium.launch({
      executablePath: chromeExe,
      headless: true,
    });

    // -------------------------------------------------------------------------
    // PART 1: Web 5 viewports x 4 locales layout & no-clipping verification
    // -------------------------------------------------------------------------
    const viewports = [
      { name: 'Desktop', width: 1440, height: 900 },
      { name: 'Compact', width: 960, height: 700 },
      { name: 'Tablet', width: 1024, height: 768 },
      { name: 'PhonePortrait', width: 390, height: 844 },
      { name: 'PhoneLandscape', width: 844, height: 390 },
    ] as const;
    const locales = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'] as const;

    const matrixCtx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1440, height: 900 } });
    await matrixCtx.addInitScript({ content: 'window.__name = (f) => f;' });
    await matrixCtx.addInitScript(
      ({ tok, cid, manifest }) => {
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_token', tok);
        localStorage.setItem('atelier_active_canvas_id', cid);
        localStorage.setItem('lumina_plugins_v2', JSON.stringify([{ manifest, enabled: true }]));
      },
      { tok: ownerAuth.token, cid: canvasId, manifest: v25Manifest },
    );
    const matrixPage = await matrixCtx.newPage();
    const matrixErrors: string[] = [];
    matrixPage.on('pageerror', (err) => matrixErrors.push(err.message || String(err)));

    await matrixPage.goto(proxyBaseUrl, { waitUntil: 'domcontentloaded' });
    await matrixPage.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });

    let checkedCells = 0;
    for (const loc of locales) {
      await matrixPage.evaluate((l) => {
        localStorage.setItem('atelier_language', l);
      }, loc);
      await matrixPage.reload({ waitUntil: 'domcontentloaded' });
      await matrixPage.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
      await sleep(200);

      for (const vp of viewports) {
        await matrixPage.setViewportSize({ width: vp.width, height: vp.height });
        await sleep(180);

        // Verify custom plugin tool button exists in ToolRail (vertical or horizontal) and fits within viewport
        const toolBtn = matrixPage.locator('[data-plugin-tool-id="lumina.motion-atelier:starlight-ribbon"]').first();
        await toolBtn.waitFor({ state: 'visible', timeout: 8000 });
        const btnBox = await toolBtn.boundingBox();
        assert.ok(btnBox && btnBox.width >= 20 && btnBox.height >= 20, `${loc}/${vp.name}: plugin tool button collapsed`);

        // Activate custom plugin tool -> verify ToolOptionsBar renders v2.5 options without horizontal page overflow
        if ((await toolBtn.getAttribute('aria-pressed')) !== 'true') {
          await toolBtn.click();
          await sleep(120);
        }
        const optBar = matrixPage.locator('[data-plugin-tool-options="lumina.motion-atelier:starlight-ribbon"]');
        await optBar.waitFor({ state: 'visible', timeout: 5000 });
        const overflow = await matrixPage.evaluate(() => ({
          docScrollW: document.documentElement.scrollWidth,
          winW: window.innerWidth,
        }));
        assert.ok(
          overflow.docScrollW <= overflow.winW + 2,
          `${loc}/${vp.name}: horizontal overflow detected (${overflow.docScrollW} > ${overflow.winW})`,
        );
        checkedCells += 1;
      }

      // Also verify PluginManager modal fits cleanly in this locale on compact viewport (960x700)
      await matrixPage.setViewportSize({ width: 960, height: 700 });
      await sleep(150);
      await openPluginMenu(matrixPage, loc);
      const names = LOCALE_MENU_NAMES[loc];
      await matrixPage.getByRole('menuitem', { name: names.manage, exact: true }).click();
      const dlg = matrixPage.getByRole('dialog', { name: names.manageTitle });
      await dlg.waitFor({ state: 'visible', timeout: 8000 });
      for (const perm of ['timeline:read', 'timeline:write', 'tools', 'input']) {
        assert.ok((await dlg.getByText(perm, { exact: true }).count()) >= 1, `${loc}: missing permission ${perm}`);
      }
      const dlgBox = await dlg.boundingBox();
      assert.ok(dlgBox && dlgBox.x >= -1 && dlgBox.x + dlgBox.width <= 962, `${loc}: PluginManager clipped horizontally`);
      await dlg.getByRole('button', { name: names.close, exact: true }).last().click();
      await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
    assert.deepEqual(matrixErrors, [], `Matrix page errors: ${matrixErrors.join('; ')}`);
    await matrixCtx.close();
    console.log(`✓ Part 1: 5 viewports x 4 locales (${checkedCells}/20 checks + 4 locale PluginManager audits) passed with zero overflow`);

    // -------------------------------------------------------------------------
    // PART 2: Phone standalone offline mode (390x844) custom tool drag + undo
    // -------------------------------------------------------------------------
    {
      const phoneCtx = await browser.newContext({
        locale: 'zh-TW',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      await phoneCtx.addInitScript({ content: 'window.__name = (f) => f;' });
      await phoneCtx.addInitScript(
        ({ manifest }) => {
          (window as any).atelierMobile = { isAndroid: true };
          localStorage.setItem('atelier_language', 'zh-TW');
          localStorage.setItem('atelier_gateway_resolved', '1');
          localStorage.setItem('atelier_session_mode', 'offline');
          localStorage.removeItem('atelier_token');
          localStorage.setItem('lumina_plugins_v2', JSON.stringify([{ manifest, enabled: true }]));
        },
        { manifest: v25Manifest },
      );
      const phonePage = await phoneCtx.newPage();
      const phoneErrors: string[] = [];
      phonePage.on('pageerror', (err) => phoneErrors.push(err.message || String(err)));
      await phonePage.goto(`${proxyBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      const startOffline = phonePage.getByRole('button', { name: '開始單機作畫', exact: true });
      if (await startOffline.isVisible({ timeout: 2500 }).catch(() => false)) {
        await startOffline.click();
      }
      await phonePage.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
      await sleep(300);

      // Select Starlight Ribbon from mobile horizontal ToolRail
      const phoneToolBtn = phonePage.locator('[data-plugin-tool-id="lumina.motion-atelier:starlight-ribbon"]').first();
      await phoneToolBtn.scrollIntoViewIfNeeded();
      await phoneToolBtn.click();
      await phonePage.locator('[data-plugin-tool-options="lumina.motion-atelier:starlight-ribbon"]').waitFor({ timeout: 8000 });

      const beforePx = await readActiveRasterAlphaCount(phonePage);
      const vp = phonePage.locator('.atelier-canvas-viewport').first();
      const box = await vp.boundingBox();
      assert.ok(box && box.width > 100 && box.height > 100, 'Phone canvas viewport missing');
      await phonePage.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
      await phonePage.mouse.down();
      for (let i = 1; i <= 5; i++) {
        await phonePage.mouse.move(box.x + box.width * 0.3 + i * 20, box.y + box.height * 0.4 + i * 10);
        await sleep(30);
      }
      await phonePage.mouse.up();
      await sleep(1200);
      const afterPx = await readActiveRasterAlphaCount(phonePage);
      if (afterPx <= beforePx) {
        const diag = await phonePage.evaluate(async () => {
          const dbg = (window as any).__debugPixi;
          const layers = dbg?.layerManager?.getLayers?.() ?? [];
          const toasts = Array.from(document.querySelectorAll('[role="status"], [role="alert"]')).map((el) => el.textContent);
          return {
            layerCount: layers.length,
            layers: layers.map((l: any) => ({
              id: l.model?.id,
              name: l.model?.name,
              type: l.model?.layerType,
              ownerId: l.model?.ownerId,
              occupied: dbg.layerManager.occupiedTiles?.(l.model?.id)?.length ?? -1,
            })),
            undoCount: dbg?.undo?.getUndoCount?.() ?? -1,
            toasts,
            bodyText: document.body.innerText.slice(0, 400),
          };
        });
        console.error('[Part 2 Diag]', JSON.stringify(diag, null, 2));
      }
      assert.ok(afterPx > beforePx, `Phone standalone custom tool should paint pixels (${beforePx} -> ${afterPx})`);

      // Tap Undo button on ToolOptionsBar -> single step reverts entire stroke
      await phonePage.locator('[data-workspace-entry="options"] button').first().click();
      await sleep(500);
      const afterUndoPx = await readActiveRasterAlphaCount(phonePage);
      assert.equal(afterUndoPx, beforePx, `Phone standalone single undo should revert (${beforePx} vs ${afterUndoPx})`);
      assert.deepEqual(phoneErrors, [], `Phone standalone page errors: ${phoneErrors.join('; ')}`);
      await phoneCtx.close();
      console.log(`✓ Part 2: Phone standalone offline mode (390x844) custom tool painted +${afterPx - beforePx} px and reverted in 1 undo`);
    }

    // -------------------------------------------------------------------------
    // PART 3: Multiplayer LAN + net-proxy ACL & sync verification
    // -------------------------------------------------------------------------
    const ownerSession = await openRoomPage(browser, proxyBaseUrl, canvasId, ownerAuth.token, 'zh-TW', { width: 1440, height: 900 }, v25Manifest);
    const editorSession = await openRoomPage(browser, proxyBaseUrl, canvasId, editorAuth.token, 'zh-TW', { width: 1440, height: 900 }, v25Manifest);
    const viewerSession = await openRoomPage(browser, proxyBaseUrl, canvasId, viewerAuth.token, 'zh-TW', { width: 1440, height: 900 }, v25Manifest);

    // 3A. Viewer attempts bounce keyframes command AND custom tool drag -> both blocked by ACL
    {
      await openPluginMenu(viewerSession.page, 'zh-TW');
      await viewerSession.page.getByRole('menuitem', { name: /建立彈跳關鍵影格/ }).click();
      await sleep(500);

      // Select custom tool as viewer and drag on canvas
      const viewerToolBtn = viewerSession.page.locator('[data-plugin-tool-id="lumina.motion-atelier:starlight-ribbon"]').first();
      await viewerToolBtn.click();
      const vp = viewerSession.page.locator('.atelier-canvas-viewport').first();
      const box = await vp.boundingBox();
      assert.ok(box);
      await viewerSession.page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
      await viewerSession.page.mouse.down();
      await viewerSession.page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
      await sleep(40);
      await viewerSession.page.mouse.up();
      await sleep(500);

      // Verify SQLite has ZERO ops by viewer and ZERO keyframes on any layer
      const dbPath = path.join(dataDir, 'atelier.db');
      const db = new Database(dbPath, { readonly: true });
      const viewerOps = db
        .prepare('SELECT COUNT(*) as c FROM canvas_ops WHERE canvas_id = ? AND user_id = ?')
        .get(canvasId, viewerAuth.user.id) as { c: number };
      db.close();
      assert.equal(viewerOps.c, 0, 'Viewer must have 0 persisted ops');

      const layersCheck = await api(proxyBaseUrl, ownerAuth.token, 'GET', `/api/canvases/${canvasId}/layers`);
      for (const l of layersCheck.layers) {
        assert.equal(l.meta?.keyframes?.length ?? 0, 0, `Viewer must not write keyframes on layer ${l.id}`);
      }
      console.log('✓ Part 3A: Viewer blocked on v2.5 timeline/keyframes command & custom tool drag (0 ops, 0 keyframes)');
    }

    // 3B. Editor atomic keyframes.setBatch touching own layer + Owner's private layer -> ENTIRE batch rejected
    {
      const batchProbePlugin = {
        apiVersion: 2,
        id: 'lumina.acl-batch-probe',
        name: 'ACL Batch Probe',
        version: '2.5.0',
        author: 'Test',
        description: 'Attempts mixed own+foreign keyframes.setBatch.',
        permissions: ['commands', 'layers:read', 'timeline:write'],
        commands: [{ id: 'probe', label: 'Run ACL Batch Probe' }],
        script: `
          async function onCommand(cmd, api) {
            const list = await api.layers.list();
            const mine = list.find((l) => l.isOwnedByMe);
            const foreign = list.find((l) => !l.isOwnedByMe);
            if (!mine || !foreign) throw new Error('Missing layers for probe');
            await api.keyframes.setBatch([
              { layerId: mine.id, keyframes: [{ frame: 0, x: 42, y: 12 }] },
              { layerId: foreign.id, keyframes: [{ frame: 0, x: 99, y: 99 }] }
            ]);
            return { notice: 'SHOULD_NOT_SUCCEED' };
          }
        `,
      };
      await seedPluginInLocalStorage(editorSession.page, batchProbePlugin, true);
      await editorSession.page.reload({ waitUntil: 'domcontentloaded' });
      await editorSession.page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
      await sleep(300);

      await openPluginMenu(editorSession.page, 'zh-TW');
      await editorSession.page.getByRole('menuitem', { name: 'Run ACL Batch Probe', exact: true }).click();
      await sleep(600);

      const layersAfterProbe = await api(proxyBaseUrl, ownerAuth.token, 'GET', `/api/canvases/${canvasId}/layers`);
      const edLayer = layersAfterProbe.layers.find((l: any) => l.id === editorOwnLayerId);
      const ownLayer = layersAfterProbe.layers.find((l: any) => l.id === ownerPrivateLayer.id);
      assert.equal(edLayer?.meta?.keyframes?.length ?? 0, 0, 'Atomic batch reject must leave Editor own layer untouched');
      assert.equal(ownLayer?.meta?.keyframes?.length ?? 0, 0, 'Owner private layer must remain untouched');
      console.log('✓ Part 3B: Editor mixed own+foreign keyframes.setBatch atomically rejected (zero side effects)');
    }

    // 3C. Editor legitimate custom tool drag on own layer -> syncs over LAN net-proxy to Owner + single Ctrl+Z reverts both
    {
      // Close Viewer context first to keep headless SwiftShader WebGL contexts light & responsive
      assert.deepEqual(viewerSession.pageErrors, [], `Viewer page errors: ${viewerSession.pageErrors.join('; ')}`);
      await viewerSession.ctx.close();

      // Ensure Editor has their own layer selected
      await editorSession.page.getByText('Editor Own Layer').first().click();
      await sleep(200);

      const edToolBtn = editorSession.page.locator('[data-plugin-tool-id="lumina.motion-atelier:starlight-ribbon"]').first();
      await edToolBtn.click();
      const vp = editorSession.page.locator('.atelier-canvas-viewport').first();
      const box = await vp.boundingBox();
      assert.ok(box);
      const sx = box.x + box.width * 0.35;
      const sy = box.y + box.height * 0.35;
      await editorSession.page.mouse.move(sx, sy);
      await editorSession.page.mouse.down();
      for (let i = 1; i <= 5; i++) {
        await editorSession.page.mouse.move(sx + i * 20, sy + i * 12);
        await sleep(30);
      }
      await editorSession.page.mouse.up();
      await sleep(600);

      // Bring owner tab to front so Chromium renders WebGL frames immediately
      await ownerSession.page.bringToFront();
      let ownerSaw = 0;
      for (let i = 0; i < 20; i++) {
        ownerSaw = await readLayerAlphaCount(ownerSession.page, editorOwnLayerId);
        if (ownerSaw > 0) break;
        await sleep(200);
      }
      assert.ok(ownerSaw > 0, `Owner should see Editor's Starlight Ribbon stroke via net-proxy (got ${ownerSaw} px)`);

      // Single Ctrl+Z on Editor reverts both Editor and Owner
      await editorSession.page.bringToFront();
      await editorSession.page.keyboard.press('Control+KeyZ');
      await sleep(400);
      await ownerSession.page.bringToFront();
      let ownerAfterUndo = ownerSaw;
      for (let i = 0; i < 20; i++) {
        ownerAfterUndo = await readLayerAlphaCount(ownerSession.page, editorOwnLayerId);
        if (ownerAfterUndo === 0) break;
        await sleep(200);
      }
      assert.equal(ownerAfterUndo, 0, `Single Ctrl+Z on Editor should clear Owner's view (got ${ownerAfterUndo} px)`);

      // Legitimate bounce keyframes on Editor's own layer -> persisted & visible to Owner
      await editorSession.page.bringToFront();
      await openPluginMenu(editorSession.page, 'zh-TW');
      await editorSession.page.getByRole('menuitem', { name: /建立彈跳關鍵影格/ }).click();
      await sleep(700);
      const layersAfterKf = await api(proxyBaseUrl, ownerAuth.token, 'GET', `/api/canvases/${canvasId}/layers`);
      const edLayerKf = layersAfterKf.layers.find((l: any) => l.id === editorOwnLayerId);
      assert.equal(edLayerKf?.meta?.keyframes?.length, 3, 'Editor own layer should persist 3 bounce keyframes');
      console.log(`✓ Part 3C: Editor custom tool (+${ownerSaw} px -> 0 px on 1 Ctrl+Z) & bounce keyframes synced over LAN net-proxy`);
    }

    assert.deepEqual(ownerSession.pageErrors, [], `Owner page errors: ${ownerSession.pageErrors.join('; ')}`);
    assert.deepEqual(editorSession.pageErrors, [], `Editor page errors: ${editorSession.pageErrors.join('; ')}`);

    await ownerSession.ctx.close();
    await editorSession.ctx.close();

    console.log('ALL PLUGIN API v2.5 WEB + PHONE + LAN NET-PROXY MULTIPLAYER ACL CHECKS PASSED!');
  } catch (err) {
    if (serverStderr) console.error('[Server stderr]', serverStderr);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    serverProc.kill('SIGTERM');
    proxyProc.kill('SIGTERM');
    await sleep(300);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors on Windows
    }
  }
}

const hardGuard = setTimeout(() => {
  console.error('[Plugin v2.5 E2E] Hard timeout (120s) exceeded.');
  process.exit(1);
}, 120_000);
hardGuard.unref();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Plugin v2.5 E2E] FAILED:', err);
    process.exit(1);
  });

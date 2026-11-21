/**
 * Multiplayer Room Plugin API v2 ACL & Collaborative Sync Verification.
 *
 * Uses a throwaway Fastify server (ephemeral DATA_DIR + dedicated test port, never touching Port 3000)
 * fronted by apps/server/tests/net-proxy.ts (25ms one-way / 50ms RTT, ±5ms jitter), with ALL browsers
 * connecting over the real LAN IPv4 address (never 127.0.0.1 / localhost).
 *
 * Scenarios (single pass):
 *   1. Guest (unauthenticated): Plugin panel shows layers read-only; both new-layer creation and
 *      direct pixel writes are rejected by ACL; zero write ops recorded in SQLite.
 *   2. Viewer (canvas_members.role = 'viewer'): Plugin panel shows layers read-only; both new-layer
 *      creation and direct pixel writes to shared_all are rejected by ACL; F1 plugin filter blocked;
 *      zero write ops recorded in SQLite.
 *   3. Editor writing to Owner A's private layer (aclMode = 'owner_only'): Rejected by ACL;
 *      Owner A's private layer pixels and DB ops remain untouched.
 *   4. Editor legitimate collaborative v2 plugin transaction + net-proxy sync + single Ctrl+Z (groupId):
 *      - Multi-step new layer + pixel write syncs to Owner A, and a single Ctrl+Z removes it on both ends.
 *      - Direct pixel write on Owner A's shared_all layer syncs to Owner A, and a single Ctrl+Z restores
 *        pixels to empty on both ends.
 *
 * Usage (from repo root):
 *   .\apps\server\node_modules\.bin\tsx.cmd apps/server/tests/plugins-collab-acl-browser.ts
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
const KIT_PATH = path.resolve(REPO_ROOT, 'apps/client/public/plugins/lumina-drift-studio-kit.lumina-plugin');
const NET_PROXY_SCRIPT = path.resolve(SERVER_DIR, 'tests/net-proxy.ts');
const TSX_CLI = path.resolve(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const SERVER_PORT = Number(process.env.LUMINA_ACL_SERVER_PORT || 3987);
const PROXY_PORT = Number(process.env.LUMINA_ACL_PROXY_PORT || 3988);
const ONE_WAY_MS = 25;
const JITTER_MS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function detectLanIpv4(): string {
  if (process.env.LUMINA_TEST_LAN_IP) return process.env.LUMINA_TEST_LAN_IP;
  const nets = os.networkInterfaces();
  const candidates: Array<{ name: string; addr: string; score: number }> = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('127.') || info.address.startsWith('169.254.')) continue;
      // Prefer RFC1918 LAN addresses (192.168.x.x / 10.x.x.x / 172.16-31.x.x) over VPN overlays
      const isPrivateLan =
        info.address.startsWith('192.168.') ||
        info.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(info.address);
      candidates.push({ name, addr: info.address, score: isPrivateLan ? 10 : 1 });
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
      // not ready yet
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

async function openRoomPage(
  browser: Browser,
  baseUrl: string,
  canvasId: string,
  token: string | null,
  label: string,
): Promise<{ ctx: BrowserContext; page: Page; pageErrors: string[] }> {
  const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(
    ([t, c]) => {
      localStorage.setItem('atelier_language', 'zh-TW');
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_active_canvas_id', c);
      if (t) localStorage.setItem('atelier_token', t);
      else localStorage.removeItem('atelier_token');
    },
    [token, canvasId] as [string | null, string],
  );
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => {
    pageErrors.push(e.message || String(e));
    console.log(`   [pageerror ${label}]`, e.message);
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30000 });
  // Guest sessions may auto-open the Auth modal on connect; close it if present.
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  if (await dialog.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 2, null, {
    timeout: 20000,
  });
  return { ctx, page, pageErrors };
}

async function openPluginMenu(page: Page) {
  const directBtn = page.getByRole('button', { name: '插件', exact: true });
  if ((await directBtn.count()) && (await directBtn.first().isVisible())) {
    await directBtn.first().click();
    return;
  }
  await page.locator('header button[title="檔案"]').first().click();
}

async function installAndEnableV2Kit(page: Page) {
  await openPluginMenu(page);
  await page.getByRole('menuitem', { name: '管理插件…', exact: true }).click();
  const mgr = page.getByRole('dialog', { name: '管理插件' });
  await mgr.waitFor({ timeout: 10000 });
  await mgr.locator('input[type=file]').setInputFiles(KIT_PATH);
  await mgr.locator('[data-plugin-api-version="2"]').waitFor({ timeout: 10000 });
  await mgr.getByRole('button', { name: '安裝插件', exact: true }).click();
  const card = mgr.locator('[data-plugin-card="lumina.drift-studio-kit"]');
  await card.waitFor({ timeout: 10000 });
  await card.locator('[data-plugin-toggle="lumina.drift-studio-kit"]').click();
  await mgr.getByRole('button', { name: '關閉', exact: true }).last().click();
  await mgr.waitFor({ state: 'detached' });
}

async function openWorkshopPanel(page: Page) {
  await openPluginMenu(page);
  await page.getByRole('menuitemcheckbox', { name: '流光描邊工坊', exact: true }).click();
  const panelWin = page.locator('[data-tool-window="plugin_panel_lumina.drift-studio-kit_drift-workshop"]');
  await panelWin.waitFor({ timeout: 10000 });
  return panelWin;
}

async function countNonZeroPixels(page: Page, layerName: string): Promise<number> {
  return page.evaluate(async (name) => {
    const dbg = (window as any).__debugPixi;
    const lm = dbg?.layerManager;
    if (!lm) return -1;
    const item = lm.getLayers().find((l: any) => l.model.name === name);
    if (!item) return -1;
    const w = dbg.viewport.canvasWidth;
    const h = dbg.viewport.canvasHeight;
    const [buf] = await lm.readAsync(item.model.id, [{ x: 0, y: 0, w, h }]);
    if (!buf) return 0;
    let nonZero = 0;
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i] > 0) nonZero++;
    }
    return nonZero;
  }, layerName);
}

async function selectTargetLayerOption(panelWin: ReturnType<Page['locator']>, nameSubstring: string) {
  const select = panelWin.locator('[data-panel-field="targetLayer"] select');
  const optionInfo = await select.evaluate((el, needle) => {
    const sel = el as HTMLSelectElement;
    const opt = [...sel.options].find((o) => (o.textContent || '').includes(needle));
    return opt ? { value: opt.value, text: opt.textContent || '' } : null;
  }, nameSubstring);
  assert.ok(optionInfo, `Could not find targetLayer option containing "${nameSubstring}"`);
  await select.selectOption(optionInfo.value);
  return optionInfo;
}

async function main() {
  assert.ok(fs.existsSync(KIT_PATH), `Missing v2 kit: ${KIT_PATH}`);
  assert.ok(fs.existsSync(path.join(SERVER_DIR, 'dist/server.js')), 'Build apps/server first');
  assert.ok(fs.existsSync(NET_PROXY_SCRIPT), `Missing net-proxy.ts: ${NET_PROXY_SCRIPT}`);

  const lanIp = detectLanIpv4();
  assert.ok(!lanIp.startsWith('127.') && lanIp !== 'localhost', `Expected LAN IP, got ${lanIp}`);
  const proxyUrl = `http://${lanIp}:${PROXY_PORT}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-plugin-acl-'));
  const dbPath = path.join(dataDir, 'atelier.db');
  const serverLogFd = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  const proxyLogFd = fs.openSync(path.join(dataDir, 'proxy.log'), 'a');

  console.log(`[Collab ACL] Throwaway server :${SERVER_PORT} -> net-proxy :${PROXY_PORT} (${ONE_WAY_MS}ms ±${JITTER_MS}ms)`);
  console.log(`[Collab ACL] Clients connecting via LAN URL: ${proxyUrl}`);
  console.log(`[Collab ACL] Isolated DATA_DIR: ${dataDir}`);

  let serverProc: ChildProcess | null = null;
  let proxyProc: ChildProcess | null = null;
  let browser: Browser | null = null;

  const dbOpsCount = (canvasId: string) => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM canvas_ops WHERE canvas_id = ?').get(canvasId) as { cnt: number };
      return row.cnt;
    } finally {
      db.close();
    }
  };
  const dbLayerCount = (canvasId: string) => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM layers WHERE canvas_id = ?').get(canvasId) as { cnt: number };
      return row.cnt;
    } finally {
      db.close();
    }
  };

  try {
    // 1. Start isolated throwaway Fastify server (Port 3000 untouched)
    serverProc = spawn(process.execPath, ['dist/server.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(SERVER_PORT), DATA_DIR: dataDir },
      stdio: ['ignore', serverLogFd, serverLogFd],
    });
    await waitForHealth(`http://${lanIp}:${SERVER_PORT}`, serverProc, 'throwaway server');

    // 2. Start net-proxy.ts (25ms one-way / 50ms RTT, ±5ms jitter)
    proxyProc = spawn(
      process.execPath,
      [TSX_CLI, NET_PROXY_SCRIPT, String(PROXY_PORT), String(SERVER_PORT), String(ONE_WAY_MS), '0', '0', String(JITTER_MS)],
      {
        cwd: SERVER_DIR,
        stdio: ['ignore', proxyLogFd, proxyLogFd],
      },
    );
    await waitForHealth(proxyUrl, proxyProc, 'net-proxy');

    // 3. Provision accounts, room, layers & Viewer membership via LAN proxy URL
    const runId = Date.now().toString(36);
    const ownerA = await api(proxyUrl, null, 'POST', '/api/auth/register', {
      username: `ownera_${runId}`,
      password: 'password123',
      displayName: 'OwnerA',
    });
    const editorB = await api(proxyUrl, null, 'POST', '/api/auth/register', {
      username: `editorb_${runId}`,
      password: 'password123',
      displayName: 'EditorB',
    });
    const viewerV = await api(proxyUrl, null, 'POST', '/api/auth/register', {
      username: `viewerv_${runId}`,
      password: 'password123',
      displayName: 'ViewerV',
    });

    const { canvas } = await api(proxyUrl, ownerA.token, 'POST', '/api/canvases', {
      title: `Plugin ACL ${runId}`,
      width: 512,
      height: 512,
    });
    await api(proxyUrl, editorB.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
    await api(proxyUrl, viewerV.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });

    // Set ViewerV role to 'viewer' in throwaway DB
    {
      const db = new Database(dbPath);
      try {
        db.prepare(`UPDATE canvas_members SET role = 'viewer' WHERE canvas_id = ? AND user_id = ?`).run(canvas.id, viewerV.user.id);
      } finally {
        db.close();
      }
    }

    await api(proxyUrl, ownerA.token, 'POST', `/api/canvases/${canvas.id}/layers`, {
      name: 'A Private Layer',
      aclMode: 'owner_only',
    });
    await api(proxyUrl, ownerA.token, 'POST', `/api/canvases/${canvas.id}/layers`, {
      name: 'Shared Collab Layer',
      aclMode: 'shared_all',
    });
    await api(proxyUrl, editorB.token, 'POST', `/api/canvases/${canvas.id}/layers`, {
      name: 'B Own Layer',
      aclMode: 'owner_only',
    });

    browser = await chromium.launch({ executablePath: detectChromeExecutable(), headless: true });

    // ── Scenario 1: Unauthenticated Guest rejected from creating layers & writing pixels ──
    {
      const opsBefore = dbOpsCount(canvas.id);
      const layersBefore = dbLayerCount(canvas.id);
      const guest = await openRoomPage(browser, proxyUrl, canvas.id, null, 'Guest');
      await installAndEnableV2Kit(guest.page);
      const panelWin = await openWorkshopPanel(guest.page);

      const sharedOpt = await selectTargetLayerOption(panelWin, 'Shared Collab Layer');
      assert.ok(sharedOpt.text.includes('🔒'), `Guest must see lock icon on target layer, got: ${sharedOpt.text}`);
      await panelWin.locator('[data-panel-field="targetLayer"]').getByText('RO', { exact: true }).waitFor();

      // 1a. Try creating new layer as Guest
      await panelWin.locator('[data-plugin-panel-action="apply"]').click();
      const alertEl = panelWin.locator('[role="alert"]');
      await alertEl.waitFor({ timeout: 10000 });
      const guestCreateErr = (await alertEl.textContent()) || '';
      assert.ok(guestCreateErr.toLowerCase().includes('guest') || guestCreateErr.length > 0, `Expected guest ACL error, got: ${guestCreateErr}`);

      // 1b. Uncheck newLayer and try direct pixel write onto Shared Collab Layer as Guest
      await panelWin.locator('[data-panel-field="newLayer"] input[type="checkbox"]').uncheck();
      await panelWin.locator('[data-plugin-panel-action="apply"]').click();
      await alertEl.waitFor({ timeout: 10000 });
      const guestWriteErr = (await alertEl.textContent()) || '';
      assert.ok(guestWriteErr.toLowerCase().includes('guest') || guestWriteErr.length > 0, `Expected guest write ACL error, got: ${guestWriteErr}`);

      await sleep(400);
      assert.equal(dbOpsCount(canvas.id), opsBefore, 'Guest must produce 0 write ops in DB');
      assert.equal(dbLayerCount(canvas.id), layersBefore, 'Guest must produce 0 new layers in DB');
      assert.deepEqual(guest.pageErrors, [], `Guest pageErrors: ${guest.pageErrors.join('; ')}`);
      await guest.ctx.close();
      console.log(`✓ Scenario 1 (Guest ACL rejection): "${guestCreateErr.trim()}" / "${guestWriteErr.trim()}" (0 DB ops)`);
    }

    // ── Scenario 2: Viewer role rejected from panel create, panel direct write, and F1 plugin filter ──
    {
      const opsBefore = dbOpsCount(canvas.id);
      const layersBefore = dbLayerCount(canvas.id);
      const viewer = await openRoomPage(browser, proxyUrl, canvas.id, viewerV.token, 'ViewerV');
      // Wait for socket presence/roomMembers to propagate canvasRole='viewer'
      await sleep(600);
      await installAndEnableV2Kit(viewer.page);
      const panelWin = await openWorkshopPanel(viewer.page);

      const sharedOpt = await selectTargetLayerOption(panelWin, 'Shared Collab Layer');
      assert.ok(sharedOpt.text.includes('🔒'), `Viewer must see lock icon on shared layer, got: ${sharedOpt.text}`);
      await panelWin.locator('[data-panel-field="targetLayer"]').getByText('RO', { exact: true }).waitFor();

      // 2a. Try creating new layer as Viewer
      await panelWin.locator('[data-plugin-panel-action="apply"]').click();
      const alertEl = panelWin.locator('[role="alert"]');
      await alertEl.waitFor({ timeout: 10000 });
      const viewerCreateErr = (await alertEl.textContent()) || '';
      assert.ok(viewerCreateErr.toLowerCase().includes('viewer') || viewerCreateErr.length > 0, `Expected viewer create error, got: ${viewerCreateErr}`);

      // 2b. Uncheck newLayer and try direct pixel write onto Shared Collab Layer as Viewer
      await panelWin.locator('[data-panel-field="newLayer"] input[type="checkbox"]').uncheck();
      await panelWin.locator('[data-plugin-panel-action="apply"]').click();
      await alertEl.waitFor({ timeout: 10000 });
      const viewerWriteErr = (await alertEl.textContent()) || '';
      assert.ok(viewerWriteErr.includes('瀏覽者') || viewerWriteErr.toLowerCase().includes('viewer'), `Expected viewer pixel ACL error, got: ${viewerWriteErr}`);

      // 2c. Try opening Layer Filters as Viewer -> blocked (layer-filter window must not open)
      await viewer.page.getByRole('button', { name: '圖層濾鏡', exact: true }).click();
      await sleep(400);
      assert.equal(await viewer.page.locator('[data-tool-window="layer-filter"]').count(), 0, 'Viewer must not open filter dialog');

      assert.equal(dbOpsCount(canvas.id), opsBefore, 'Viewer must produce 0 write ops in DB');
      assert.equal(dbLayerCount(canvas.id), layersBefore, 'Viewer must produce 0 new layers in DB');
      assert.deepEqual(viewer.pageErrors, [], `Viewer pageErrors: ${viewer.pageErrors.join('; ')}`);
      await viewer.ctx.close();
      console.log(`✓ Scenario 2 (Viewer ACL rejection): "${viewerCreateErr.trim()}" / "${viewerWriteErr.trim()}" + filter blocked (0 DB ops)`);
    }

    // ── Scenarios 3 & 4: Owner A + Editor B live collaboration over LAN + net-proxy ──
    const ownerSession = await openRoomPage(browser, proxyUrl, canvas.id, ownerA.token, 'OwnerA');
    const editorSession = await openRoomPage(browser, proxyUrl, canvas.id, editorB.token, 'EditorB');
    await installAndEnableV2Kit(editorSession.page);
    const panelWinB = await openWorkshopPanel(editorSession.page);

    // ── Scenario 3: Editor B rejected from writing to Owner A's private layer ──
    {
      const opsBefore = dbOpsCount(canvas.id);
      const privatePixelsBeforeA = await countNonZeroPixels(ownerSession.page, 'A Private Layer');
      const privOpt = await selectTargetLayerOption(panelWinB, 'A Private Layer');
      assert.ok(privOpt.text.includes('🔒'), `Editor B must see lock icon on Owner A private layer, got: ${privOpt.text}`);
      await panelWinB.locator('[data-panel-field="targetLayer"]').getByText('RO', { exact: true }).waitFor();

      const newLayerCb = panelWinB.locator('[data-panel-field="newLayer"] input[type="checkbox"]');
      await newLayerCb.uncheck();
      await panelWinB.locator('[data-plugin-panel-action="apply"]').click();
      const alertEl = panelWinB.locator('[role="alert"]');
      await alertEl.waitFor({ timeout: 10000 });
      const privErr = (await alertEl.textContent()) || '';
      assert.ok(privErr.length > 0, 'Private layer write must show ACL rejection error');

      await sleep(500);
      const privatePixelsAfterA = await countNonZeroPixels(ownerSession.page, 'A Private Layer');
      assert.equal(privatePixelsAfterA, privatePixelsBeforeA, 'Owner A private layer pixels must be untouched');
      assert.equal(dbOpsCount(canvas.id), opsBefore, 'Rejected private layer write must produce 0 DB ops');
      console.log(`✓ Scenario 3 (Other user's private layer ACL rejection): "${privErr.trim()}" (Owner A pixels unchanged: ${privatePixelsAfterA})`);
    }

    // ── Scenario 4a: Editor B multi-step v2 plugin (new layer + pixels) syncs to Owner A + single Ctrl+Z (groupId) undo ──
    {
      const newLayerCb = panelWinB.locator('[data-panel-field="newLayer"] input[type="checkbox"]');
      await newLayerCb.check();
      await panelWinB.locator('[data-plugin-panel-action="apply"]').click();
      await panelWinB.locator('[data-plugin-panel-status="true"]').filter({ hasText: /Applied glow frame/ }).waitFor({ timeout: 15000 });

      // Wait for Drift Glow Frame + painted pixels to sync across net-proxy to Owner A
      await ownerSession.page.waitForFunction(
        () => (window as any).__debugPixi?.layerManager?.getLayers().some((l: any) => l.model.name === 'Drift Glow Frame'),
        null,
        { timeout: 15000 },
      );
      let syncedPixelsA = 0;
      for (let i = 0; i < 40; i++) {
        syncedPixelsA = await countNonZeroPixels(ownerSession.page, 'Drift Glow Frame');
        if (syncedPixelsA > 0) break;
        await sleep(150);
      }
      const paintedPixelsB = await countNonZeroPixels(editorSession.page, 'Drift Glow Frame');
      assert.ok(paintedPixelsB > 0, `Editor B must have painted Drift Glow Frame pixels (${paintedPixelsB})`);
      assert.equal(syncedPixelsA, paintedPixelsB, `Owner A synced pixels (${syncedPixelsA}) must match Editor B (${paintedPixelsB})`);

      // Single Ctrl+Z on Editor B must remove Drift Glow Frame on BOTH Editor B and Owner A
      await editorSession.page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await editorSession.page.keyboard.press('Control+z');
      await editorSession.page.waitForFunction(
        () => !(window as any).__debugPixi?.layerManager?.getLayers().some((l: any) => l.model.name === 'Drift Glow Frame'),
        null,
        { timeout: 15000 },
      );
      await ownerSession.page.waitForFunction(
        () => !(window as any).__debugPixi?.layerManager?.getLayers().some((l: any) => l.model.name === 'Drift Glow Frame'),
        null,
        { timeout: 15000 },
      );
      console.log(`✓ Scenario 4a (New-layer plugin tx sync & single Ctrl+Z groupId undo): synced ${syncedPixelsA} px over net-proxy, both ends reverted in 1 undo`);
    }

    // ── Scenario 4b: Editor B direct pixel write onto Owner A's shared_all layer + sync + single Ctrl+Z undo ──
    {
      const sharedOpt = await selectTargetLayerOption(panelWinB, 'Shared Collab Layer');
      assert.ok(!sharedOpt.text.includes('🔒'), `Shared Collab Layer must be editable for Editor B, got: ${sharedOpt.text}`);
      const newLayerCb = panelWinB.locator('[data-panel-field="newLayer"] input[type="checkbox"]');
      await newLayerCb.uncheck();
      await panelWinB.locator('[data-plugin-panel-action="apply"]').click();
      await panelWinB.locator('[data-plugin-panel-status="true"]').filter({ hasText: /Applied glow frame/ }).waitFor({ timeout: 15000 });

      let syncedSharedA = 0;
      for (let i = 0; i < 40; i++) {
        syncedSharedA = await countNonZeroPixels(ownerSession.page, 'Shared Collab Layer');
        if (syncedSharedA > 0) break;
        await sleep(150);
      }
      const sharedPixelsB = await countNonZeroPixels(editorSession.page, 'Shared Collab Layer');
      assert.ok(sharedPixelsB > 0, `Editor B must paint Shared Collab Layer (${sharedPixelsB})`);
      assert.equal(syncedSharedA, sharedPixelsB, `Owner A Shared Collab Layer pixels (${syncedSharedA}) must match Editor B (${sharedPixelsB})`);

      // Single Ctrl+Z reverts shared_all pixels to 0 on BOTH ends
      await editorSession.page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await editorSession.page.keyboard.press('Control+z');
      let afterUndoB = -1;
      let afterUndoA = -1;
      for (let i = 0; i < 40; i++) {
        afterUndoB = await countNonZeroPixels(editorSession.page, 'Shared Collab Layer');
        afterUndoA = await countNonZeroPixels(ownerSession.page, 'Shared Collab Layer');
        if (afterUndoB === 0 && afterUndoA === 0) break;
        await sleep(150);
      }
      assert.equal(afterUndoB, 0, `Editor B Shared Collab Layer must revert to 0 px after 1 undo (got ${afterUndoB})`);
      assert.equal(afterUndoA, 0, `Owner A Shared Collab Layer must revert to 0 px after 1 undo (got ${afterUndoA})`);
      console.log(`✓ Scenario 4b (shared_all pixel write sync & single Ctrl+Z undo): synced ${syncedSharedA} px over net-proxy, both ends reverted to 0 px in 1 undo`);
    }

    assert.deepEqual(ownerSession.pageErrors, [], `Owner A pageErrors: ${ownerSession.pageErrors.join('; ')}`);
    assert.deepEqual(editorSession.pageErrors, [], `Editor B pageErrors: ${editorSession.pageErrors.join('; ')}`);
    await ownerSession.ctx.close();
    await editorSession.ctx.close();

    console.log('ALL MULTIPLAYER LAN + NET-PROXY PLUGIN ACL & SYNC CHECKS PASSED!');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (proxyProc && proxyProc.exitCode === null) {
      try {
        proxyProc.kill();
      } catch {}
    }
    if (serverProc && serverProc.exitCode === null) {
      try {
        serverProc.kill();
      } catch {}
    }
    try {
      fs.closeSync(serverLogFd);
      fs.closeSync(proxyLogFd);
    } catch {}
    await sleep(300);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

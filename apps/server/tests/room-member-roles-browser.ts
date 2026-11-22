/**
 * Room Member Roles UI / API / Live Sync / ACL / Responsive Verification.
 *
 * Uses a throwaway Fastify server (ephemeral DATA_DIR + dedicated test port, never touching Port 3000)
 * fronted by apps/server/tests/net-proxy.ts (25ms one-way / 50ms RTT, ±5ms jitter), with ALL clients
 * connecting over the real LAN IPv4 address (never 127.0.0.1 / localhost).
 *
 * Single finite round-trip: editor -> viewer -> admin -> editor
 * Covers:
 *   1. Public-room member listing (GET /api/canvases/:id/members) & UPSERT role updates (PATCH .../role)
 *   2. Multi-tab live sync (memberB with 2 tabs) + read-only indicator & restoration
 *   3. Viewer ACL guards: brush (UI + socket preview_dab & op_commit), layers (UI + REST),
 *      stickers (UI + socket sticker_add/update/remove), and v2 plugin panel write rejection
 *   4. Canvas admin delegation boundaries (can toggle regular member editor/viewer, cannot promote admin or touch owner/guest/self)
 *   5. Offline member role badge + switching + SQLite persistence across reconnect
 *   6. Responsive non-clipping check across Desktop, Small Window, Tablet, Phone Portrait & Landscape,
 *      plus en-US & ja-JP locales.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { io as ioClient, type Socket } from 'socket.io-client';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVER_DIR = path.resolve(REPO_ROOT, 'apps/server');
const KIT_PATH = path.resolve(REPO_ROOT, 'apps/client/public/plugins/lumina-drift-studio-kit.lumina-plugin');
const NET_PROXY_SCRIPT = path.resolve(SERVER_DIR, 'tests/net-proxy.ts');
const TSX_CLI = path.resolve(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const SERVER_PORT = Number(process.env.LUMINA_ROLE_SERVER_PORT || 3991);
const PROXY_PORT = Number(process.env.LUMINA_ROLE_PROXY_PORT || 3992);
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

async function apiRaw(baseUrl: string, token: string | null, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data: data as any };
}

async function api(baseUrl: string, token: string | null, method: string, urlPath: string, body?: unknown) {
  const res = await apiRaw(baseUrl, token, method, urlPath, body);
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function openRoomPage(
  browser: Browser,
  baseUrl: string,
  canvasId: string,
  token: string | null,
  label: string,
  opts: { viewport?: { width: number; height: number }; language?: string } = {},
): Promise<{ ctx: BrowserContext; page: Page; pageErrors: string[] }> {
  const language = opts.language ?? 'zh-TW';
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const ctx = await browser.newContext({ locale: language, viewport });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(
    ([t, c, lang]) => {
      localStorage.setItem('atelier_language', lang);
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_active_canvas_id', c);
      if (t) localStorage.setItem('atelier_token', t);
      else localStorage.removeItem('atelier_token');
    },
    [token, canvasId, language] as [string | null, string, string],
  );
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => {
    pageErrors.push(e.message || String(e));
    console.log(`   [pageerror ${label}]`, e.message);
  });
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
  return { ctx, page, pageErrors };
}

async function ensureMembersPanelOpen(page: Page, language = 'zh-TW') {
  const onlineSectionLabel =
    language === 'en-US' ? 'Online Members' : language === 'ja-JP' ? 'オンラインメンバー' : '在線成員';
  const sec = page.locator(`section[aria-label="${onlineSectionLabel}"]`);
  if (await sec.isVisible({ timeout: 500 }).catch(() => false)) return sec;

  // Desktop / tablet topbar button or mobile bottom bar button
  const mobileBtn = page.locator('button[aria-label="成員"]');
  if (await mobileBtn.isVisible({ timeout: 400 }).catch(() => false)) {
    await mobileBtn.click();
  } else {
    const titleNeedle =
      language === 'en-US' ? 'Online' : language === 'ja-JP' ? 'オンライン' : '在線成員';
    const topBtn = page.locator(`header button[title*="${titleNeedle}"]`).first();
    if (await topBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await topBtn.click();
    } else {
      // Fallback: button with Users icon in header
      await page.locator('header button[aria-pressed]').last().click();
    }
  }
  await sec.waitFor({ state: 'visible', timeout: 10000 });
  return sec;
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

async function checkMembersPanelNoClipping(page: Page, label: string, language = 'zh-TW') {
  const sec = await ensureMembersPanelOpen(page, language);
  await sleep(250);
  const report = await sec.evaluate((sectionEl) => {
    const scrollBox = sectionEl.parentElement as HTMLElement;
    const panelRect = scrollBox.getBoundingClientRect();
    const overflowX = scrollBox.scrollWidth - scrollBox.clientWidth;
    const controls = Array.from(scrollBox.querySelectorAll<HTMLElement>('[data-role-select], [data-role-badge]'));
    const clipped: Array<{ text: string; right: number; panelRight: number; width: number; height: number }> = [];
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.right > panelRect.right + 2 || r.left < panelRect.left - 2) {
        clipped.push({
          text: (el.textContent || (el as HTMLSelectElement).value || '').trim().slice(0, 20),
          right: Math.round(r.right),
          panelRight: Math.round(panelRect.right),
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
    }
    return {
      panelWidth: Math.round(panelRect.width),
      overflowX: Math.round(overflowX),
      controlCount: controls.length,
      clipped,
    };
  });
  assert.ok(report.controlCount >= 2, `[${label}] expected >=2 role badges/controls, got ${report.controlCount}`);
  assert.ok(report.overflowX <= 2, `[${label}] horizontal overflow detected: ${report.overflowX}px`);
  assert.equal(
    report.clipped.length,
    0,
    `[${label}] clipped role badges/controls: ${JSON.stringify(report.clipped)}`,
  );
  console.log(`   ✓ [${label}] panelWidth=${report.panelWidth}px overflowX=${report.overflowX}px controls=${report.controlCount}`);
}

async function main() {
  assert.ok(fs.existsSync(KIT_PATH), `Missing v2 kit: ${KIT_PATH}`);
  assert.ok(fs.existsSync(path.join(SERVER_DIR, 'dist/server.js')), 'Build apps/server first');
  assert.ok(fs.existsSync(NET_PROXY_SCRIPT), `Missing net-proxy.ts: ${NET_PROXY_SCRIPT}`);

  const lanIp = detectLanIpv4();
  const chromePath = detectChromeExecutable();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-roles-e2e-'));
  const proxyUrl = `http://${lanIp}:${PROXY_PORT}`;
  const serverDirectHealth = `http://${lanIp}:${SERVER_PORT}`;

  console.log(`=== Room Member Roles E2E Verification (1 round-trip: editor -> viewer -> admin -> editor) ===`);
  console.log(`LAN IPv4 : ${lanIp}`);
  console.log(`Server   : ${serverDirectHealth} (ephemeral DATA_DIR=${dataDir})`);
  console.log(`Proxy    : ${proxyUrl} (${ONE_WAY_MS}ms one-way / ${ONE_WAY_MS * 2}ms RTT, ±${JITTER_MS}ms jitter)`);

  let serverProc: ChildProcess | null = null;
  let proxyProc: ChildProcess | null = null;
  let browser: Browser | null = null;
  const openSockets: Socket[] = [];
  const openContexts: BrowserContext[] = [];

  try {
    const serverLog = fs.openSync(path.join(dataDir, 'server.log'), 'a');
    serverProc = spawn(process.execPath, ['dist/server.js'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        HOST: '0.0.0.0',
        DATA_DIR: dataDir,
      },
      stdio: ['ignore', serverLog, serverLog],
    });
    await waitForHealth(serverDirectHealth, serverProc, 'throwaway server');

    const proxyLog = fs.openSync(path.join(dataDir, 'proxy.log'), 'a');
    proxyProc = spawn(
      process.execPath,
      [TSX_CLI, NET_PROXY_SCRIPT, String(PROXY_PORT), String(SERVER_PORT), String(ONE_WAY_MS), '0', '0', String(JITTER_MS)],
      {
        cwd: SERVER_DIR,
        stdio: ['ignore', proxyLog, proxyLog],
      },
    );
    await waitForHealth(proxyUrl, proxyProc, 'net-proxy');

    // Register test accounts over LAN + net-proxy
    const suffix = Date.now().toString(36);
    const ownerAuth = await api(proxyUrl, null, 'POST', '/api/auth/register', {
      username: `own_${suffix}`,
      password: 'Password123!',
      displayName: 'OwnerA',
    });
    const memberBAuth = await api(proxyUrl, null, 'POST', '/api/auth/register', {
      username: `memB_${suffix}`,
      password: 'Password123!',
      displayName: 'MemberB',
    });
    const memberCAuth = await api(proxyUrl, null, 'POST', '/api/auth/register', {
      username: `memC_${suffix}`,
      password: 'Password123!',
      displayName: 'MemberC',
    });

    // OwnerA creates a public canvas (no password) and a shared_all layer
    const created = await api(proxyUrl, ownerAuth.token, 'POST', '/api/canvases', {
      title: 'Roles E2E Room',
      width: 512,
      height: 512,
      accessMode: 'invite',
    });
    const canvasId: string = created.canvas.id;
    const sharedLayerRes = await api(proxyUrl, ownerAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'SharedLayer',
      layerType: 'raster',
      aclMode: 'shared_all',
      isPublic: false,
    });
    const sharedLayerId: string = sharedLayerRes.layer.id;
    const publicLayerRes = await api(proxyUrl, ownerAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'PublicUnclaimed',
      layerType: 'raster',
      aclMode: 'owner_only',
      isPublic: true,
    });
    const publicLayerId: string = publicLayerRes.layer.id;

    // MemberB also owns a layer before being demoted to viewer (tests viewer guard even on own layer!)
    const bOwnLayerRes = await api(proxyUrl, memberBAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'MemberBOwnLayer',
      layerType: 'raster',
      aclMode: 'owner_only',
      isPublic: false,
    });
    const bOwnLayerId: string = bOwnLayerRes.layer.id;

    const dbPath = path.join(dataDir, 'atelier.db');
    const countOpsByUser = (uid: string) => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare('SELECT COUNT(*) AS cnt FROM canvas_ops WHERE canvas_id = ? AND user_id = ?')
          .get(canvasId, uid) as { cnt: number };
        return row.cnt;
      } finally {
        db.close();
      }
    };
    const countLayersByUser = (uid: string) => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare('SELECT COUNT(*) AS cnt FROM layers WHERE canvas_id = ? AND owner_id = ?')
          .get(canvasId, uid) as { cnt: number };
        return row.cnt;
      } finally {
        db.close();
      }
    };
    const readMemberRow = (uid: string) => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db
          .prepare(
            'SELECT role, can_create_layer AS canCreateLayer, can_delete_other_layer AS canDeleteOtherLayer, can_export AS canExport, can_manage_members AS canManageMembers FROM canvas_members WHERE canvas_id = ? AND user_id = ?',
          )
          .get(canvasId, uid) as
          | {
              role: string;
              canCreateLayer: number;
              canDeleteOtherLayer: number;
              canExport: number;
              canManageMembers: number;
            }
          | undefined;
      } finally {
        db.close();
      }
    };

    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu-sandbox'],
    });

    // Open browsers over LAN + net-proxy:
    // - OwnerA
    // - MemberB Tab 1 + Tab 2 (multi-tab sync verification)
    // - MemberC (for canvas-admin delegation + offline persistence)
    // - GuestD
    const ownerSession = await openRoomPage(browser, proxyUrl, canvasId, ownerAuth.token, 'OwnerA');
    const bTab1 = await openRoomPage(browser, proxyUrl, canvasId, memberBAuth.token, 'MemberB-Tab1');
    const bTab2 = await openRoomPage(browser, proxyUrl, canvasId, memberBAuth.token, 'MemberB-Tab2');
    const cSession = await openRoomPage(browser, proxyUrl, canvasId, memberCAuth.token, 'MemberC');
    const guestSession = await openRoomPage(browser, proxyUrl, canvasId, null, 'GuestD');
    openContexts.push(ownerSession.ctx, bTab1.ctx, bTab2.ctx, cSession.ctx, guestSession.ctx);

    // Also open direct Socket.IO probes over LAN + net-proxy to verify raw preview_dab / sticker ACL
    const connectSocket = (token: string) =>
      new Promise<Socket>((resolve, reject) => {
        const s = ioClient(proxyUrl, {
          auth: { token, canvasId },
          transports: ['websocket'],
          timeout: 10000,
        });
        openSockets.push(s);
        s.once('connect', () => {
          s.emit('join_canvas', { canvasId });
          resolve(s);
        });
        s.once('connect_error', reject);
      });
    const ownerProbeSock = await connectSocket(ownerAuth.token);
    const bProbeSock = await connectSocket(memberBAuth.token);
    await sleep(500);

    // 1. Verify GET /api/canvases/:id/members + initial UI badges
    console.log('\n[Step 0] Initial member listing & badges');
    const membersRes = await api(proxyUrl, ownerAuth.token, 'GET', `/api/canvases/${canvasId}/members`);
    assert.equal(membersRes.ownerId, ownerAuth.user.id);
    assert.ok(
      membersRes.members.some((m: any) => m.userId === memberBAuth.user.id && m.role === 'editor'),
      'MemberB should appear as editor in public room roster',
    );
    assert.ok(
      membersRes.members.some((m: any) => m.userId === ownerAuth.user.id && m.role === 'owner'),
      'OwnerA should appear as owner',
    );

    await ensureMembersPanelOpen(ownerSession.page);
    await ensureMembersPanelOpen(bTab1.page);
    await ensureMembersPanelOpen(bTab2.page);

    // Owner sees Owner badge for self, select for MemberB/MemberC, and Guest badge (no select) for GuestD
    await ownerSession.page
      .locator(`[data-member-id="${ownerAuth.user.id}"] [data-role-badge="owner"]`)
      .waitFor({ timeout: 10000 });
    await ownerSession.page.locator(`[data-role-select="${memberBAuth.user.id}"]`).waitFor({ timeout: 10000 });
    await ownerSession.page.locator(`[data-role-badge="guest"]`).waitFor({ timeout: 10000 });
    assert.equal(await ownerSession.page.locator(`[data-role-select="${ownerAuth.user.id}"]`).count(), 0);
    console.log('   ✓ Initial badges & owner role selectors verified');

    // Install & enable v2 plugin kit on MemberB Tab 1 before switching to viewer
    await installAndEnableV2Kit(bTab1.page);

    // 2. Round-trip Step 1: editor -> viewer
    console.log('\n[Step 1] editor -> viewer (live multi-tab sync + brush/layer/sticker/plugin ACL)');
    await ownerSession.page.locator(`[data-role-select="${memberBAuth.user.id}"]`).selectOption('viewer');

    // Both MemberB tabs immediately show viewer read-only badge and viewer role badge
    await bTab1.page.locator('[data-viewer-readonly]').waitFor({ state: 'visible', timeout: 8000 });
    await bTab2.page.locator('[data-viewer-readonly]').waitFor({ state: 'visible', timeout: 8000 });
    await bTab1.page
      .locator(`[data-member-id="${memberBAuth.user.id}"] [data-role-badge="viewer"]`)
      .waitFor({ timeout: 8000 });
    await bTab2.page
      .locator(`[data-member-id="${memberBAuth.user.id}"] [data-role-badge="viewer"]`)
      .waitFor({ timeout: 8000 });

    // Verify DB capability flags synced via public-room UPSERT
    const bRowViewer = readMemberRow(memberBAuth.user.id);
    assert.ok(bRowViewer, 'MemberB row should be UPSERTed into canvas_members');
    assert.equal(bRowViewer!.role, 'viewer');
    assert.equal(bRowViewer!.canCreateLayer, 0);
    assert.equal(bRowViewer!.canDeleteOtherLayer, 0);
    assert.equal(bRowViewer!.canManageMembers, 0);
    console.log('   ✓ Multi-tab live read-only badge + viewer badge + DB UPSERT flags verified');

    // 2a. Brush ACL: preview_dab & op_commit blocked even on MemberB's own layer & shared layer
    const opsBeforeViewer = countOpsByUser(memberBAuth.user.id);
    const layersBeforeViewer = countLayersByUser(memberBAuth.user.id);
    let previewReceivedFromB = 0;
    const onPreview = (p: any) => {
      if (p?.userId === memberBAuth.user.id) previewReceivedFromB++;
    };
    const onPreviewBatch = (arr: any[]) => {
      for (const p of arr ?? []) if (p?.userId === memberBAuth.user.id) previewReceivedFromB++;
    };
    ownerProbeSock.on('preview_dab', onPreview);
    ownerProbeSock.on('preview_batch', onPreviewBatch);

    const opRejectedPromise = new Promise<any>((resolve) => bProbeSock.once('op_rejected', resolve));
    bProbeSock.emit('preview_dab', {
      canvasId,
      layerId: bOwnLayerId,
      color: '#ff0000',
      brushSize: 8,
      dabs: [{ x: 40, y: 40, pressure: 0.8 }],
    });
    bProbeSock.emit('op_commit', {
      type: 'OP_COMMIT',
      canvasId,
      layerId: bOwnLayerId,
      clientSeq: 101,
      opType: 'STROKE',
      payload: { points: [{ x: 40, y: 40, pressure: 0.8 }] },
    });
    const opRejected = await Promise.race([opRejectedPromise, sleep(4000).then(() => null)]);
    await sleep(350);
    ownerProbeSock.off('preview_dab', onPreview);
    ownerProbeSock.off('preview_batch', onPreviewBatch);
    assert.ok(opRejected, 'Viewer op_commit must be rejected with op_rejected');
    assert.equal(previewReceivedFromB, 0, 'Viewer preview_dab must not be forwarded to other room members');
    assert.equal(countOpsByUser(memberBAuth.user.id), opsBeforeViewer, 'Zero DB ops should be recorded for viewer');

    // Also try drawing on canvas UI in bTab1 -> read-only warning, still zero ops
    const canvasBox = await bTab1.page.locator('.atelier-canvas-viewport').boundingBox();
    assert.ok(canvasBox, 'Canvas viewport box exists');
    await bTab1.page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await bTab1.page.mouse.down();
    await bTab1.page.mouse.move(canvasBox.x + canvasBox.width / 2 + 30, canvasBox.y + canvasBox.height / 2 + 15);
    await bTab1.page.mouse.up();
    await sleep(300);
    assert.equal(countOpsByUser(memberBAuth.user.id), opsBeforeViewer, 'UI brush stroke blocked for viewer');
    console.log('   ✓ Viewer brush ACL (UI + preview_dab + op_commit) verified');

    // 2b. Layer ACL: REST create / update / claim blocked (403) + UI hides add-layer button
    const createRes = await apiRaw(proxyUrl, memberBAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'ShouldFail',
      layerType: 'raster',
    });
    assert.equal(createRes.status, 403, 'Viewer POST /layers must return 403');
    const claimRes = await apiRaw(
      proxyUrl,
      memberBAuth.token,
      'POST',
      `/api/canvases/${canvasId}/layers/${publicLayerId}/claim`,
      {},
    );
    assert.equal(claimRes.status, 403, 'Viewer POST /claim must return 403');
    const patchLayerRes = await apiRaw(
      proxyUrl,
      memberBAuth.token,
      'PATCH',
      `/api/canvases/${canvasId}/layers/${bOwnLayerId}`,
      { name: 'ViewerRenameBlocked' },
    );
    assert.equal(patchLayerRes.status, 403, 'Viewer PATCH /layers/:id must return 403');
    assert.equal(await bTab1.page.locator('button[aria-label="新增點陣圖層"]').count(), 0, 'LayerPanel hides add button for viewer');
    console.log('   ✓ Viewer layer ACL (UI + REST create/claim/patch) verified');

    // 2c. Sticker ACL: UI hides sticker button + socket sticker_add rejected with PERMISSION_DENIED
    assert.equal(await bTab1.page.locator('button[title="貼圖與參考圖"]').count(), 0, 'Sticker button hidden for viewer');
    let stickerBroadcasted = false;
    const onStickerAdded = () => {
      stickerBroadcasted = true;
    };
    ownerProbeSock.on('sticker_added', onStickerAdded);
    const stickerErrPromise = new Promise<any>((resolve) => bProbeSock.once('error', resolve));
    bProbeSock.emit('sticker_add', {
      canvasId,
      sticker: {
        id: 'stk-blocked-1',
        title: 'Blocked',
        imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
        x: 10,
        y: 10,
        width: 100,
        height: 100,
        isPinnedToScreen: false,
        isShared: true,
        createdBy: memberBAuth.user.id,
        createdAt: Date.now(),
      },
    });
    const stickerErr = await Promise.race([stickerErrPromise, sleep(4000).then(() => null)]);
    await sleep(250);
    ownerProbeSock.off('sticker_added', onStickerAdded);
    assert.equal(stickerErr?.code, 'PERMISSION_DENIED', 'Viewer sticker_add must emit PERMISSION_DENIED');
    assert.equal(stickerBroadcasted, false, 'Viewer sticker_add must not broadcast');
    console.log('   ✓ Viewer sticker ACL (UI + socket) verified');

    // 2d. Plugin ACL: v2 plugin panel rejects write when user is viewer
    const workshopWin = await openWorkshopPanel(bTab1.page);
    await workshopWin.locator('[data-plugin-panel-action="apply"]').click();
    await workshopWin.locator('[role="alert"]').waitFor({ state: 'visible', timeout: 8000 });
    await sleep(400);
    assert.equal(countLayersByUser(memberBAuth.user.id), layersBeforeViewer, 'Viewer plugin apply must not create layer');
    assert.equal(countOpsByUser(memberBAuth.user.id), opsBeforeViewer, 'Viewer plugin apply must not commit ops');
    await workshopWin.locator('button[aria-label="關閉"]').click().catch(() => {});
    console.log('   ✓ Viewer v2 plugin ACL verified');

    // 3. Round-trip Step 2: viewer -> admin
    console.log('\n[Step 2] viewer -> admin (read-only cleared + canvas admin delegation boundaries)');
    await ownerSession.page.locator(`[data-role-select="${memberBAuth.user.id}"]`).selectOption('admin');
    await bTab1.page.locator('[data-viewer-readonly]').waitFor({ state: 'detached', timeout: 8000 });
    await bTab2.page.locator('[data-viewer-readonly]').waitFor({ state: 'detached', timeout: 8000 });
    await bTab1.page
      .locator(`[data-member-id="${memberBAuth.user.id}"] [data-role-badge="admin"]`)
      .waitFor({ timeout: 8000 });

    const bRowAdmin = readMemberRow(memberBAuth.user.id);
    assert.equal(bRowAdmin?.role, 'admin');
    assert.equal(bRowAdmin?.canCreateLayer, 1);
    assert.equal(bRowAdmin?.canDeleteOtherLayer, 1);
    assert.equal(bRowAdmin?.canManageMembers, 1);

    // Canvas admin B sees role select for MemberC with ONLY ['editor', 'viewer'], NOT for OwnerA or self
    const cSelectInB = bTab1.page.locator(`[data-role-select="${memberCAuth.user.id}"]`);
    await cSelectInB.waitFor({ timeout: 8000 });
    const cOptionsInB = await cSelectInB.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => o.value));
    assert.deepEqual(cOptionsInB, ['editor', 'viewer'], 'Canvas admin may only assign editor/viewer');
    assert.equal(await bTab1.page.locator(`[data-role-select="${ownerAuth.user.id}"]`).count(), 0);
    assert.equal(await bTab1.page.locator(`[data-role-select="${memberBAuth.user.id}"]`).count(), 0);

    // API boundary checks for canvas admin B
    const promoteToAdmin = await apiRaw(
      proxyUrl,
      memberBAuth.token,
      'PATCH',
      `/api/canvases/${canvasId}/members/${memberCAuth.user.id}/role`,
      { role: 'admin' },
    );
    assert.equal(promoteToAdmin.status, 403, 'Canvas admin cannot promote another member to admin');
    const modifyOwner = await apiRaw(
      proxyUrl,
      memberBAuth.token,
      'PATCH',
      `/api/canvases/${canvasId}/members/${ownerAuth.user.id}/role`,
      { role: 'viewer' },
    );
    assert.equal(modifyOwner.status, 403, 'Canvas admin cannot modify owner');

    // Canvas admin B demotes MemberC to viewer via UI
    await cSelectInB.selectOption('viewer');
    await cSession.page.locator('[data-viewer-readonly]').waitFor({ state: 'visible', timeout: 8000 });
    console.log('   ✓ Canvas admin promotion, capability sync, and delegation boundaries verified');

    // 4. Round-trip Step 3: admin -> editor (restoration + write works again)
    console.log('\n[Step 3] admin -> editor (delegation revoked + editing restored)');
    await ownerSession.page.locator(`[data-role-select="${memberBAuth.user.id}"]`).selectOption('editor');
    await bTab1.page
      .locator(`[data-member-id="${memberBAuth.user.id}"] [data-role-badge="editor"]`)
      .waitFor({ timeout: 8000 });
    await bTab1.page
      .locator(`[data-member-id="${memberCAuth.user.id}"] [data-role-badge="viewer"]`)
      .waitFor({ timeout: 8000 });
    assert.equal(await bTab1.page.locator(`[data-role-select="${memberCAuth.user.id}"]`).count(), 0);

    const bRowEditor = readMemberRow(memberBAuth.user.id);
    assert.equal(bRowEditor?.role, 'editor');
    assert.equal(bRowEditor?.canCreateLayer, 1);
    assert.equal(bRowEditor?.canDeleteOtherLayer, 0);
    assert.equal(bRowEditor?.canManageMembers, 0);

    // MemberB can now create a layer and add a sticker again
    const restoredLayer = await api(proxyUrl, memberBAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'RestoredEditorLayer',
      layerType: 'raster',
    });
    assert.ok(restoredLayer.layer?.id, 'Restored editor can create layer');

    const stickerSyncPromise = new Promise<any>((resolve) => ownerProbeSock.once('sticker_added', resolve));
    bProbeSock.emit('sticker_add', {
      canvasId,
      sticker: {
        id: 'stk-restored-1',
        title: 'Restored',
        imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
        x: 20,
        y: 20,
        width: 100,
        height: 100,
        isPinnedToScreen: false,
        isShared: true,
        createdBy: memberBAuth.user.id,
        createdAt: Date.now(),
      },
    });
    const syncedSticker = await Promise.race([stickerSyncPromise, sleep(4000).then(() => null)]);
    assert.equal(syncedSticker?.sticker?.id, 'stk-restored-1', 'Restored editor sticker syncs to OwnerA');
    console.log('   ✓ Editor restoration (layer + sticker + revoked admin UI) verified');

    // 5. Offline member role management & persistence
    console.log('\n[Step 4] Offline member role badge, update & persistence');
    await cSession.ctx.close();
    const offlineRowC = ownerSession.page.locator(
      `section[aria-label="離線成員"] [data-member-id="${memberCAuth.user.id}"]`,
    );
    await offlineRowC.waitFor({ state: 'visible', timeout: 10000 });
    const offlineSelectC = offlineRowC.locator(`[data-role-select="${memberCAuth.user.id}"]`);
    assert.equal(await offlineSelectC.inputValue(), 'viewer', 'Offline MemberC preserves viewer role');

    // Owner switches offline MemberC back to editor
    await offlineSelectC.selectOption('editor');
    await sleep(500);
    const cRowPersisted = readMemberRow(memberCAuth.user.id);
    assert.equal(cRowPersisted?.role, 'editor');
    assert.equal(cRowPersisted?.canCreateLayer, 1);

    // MemberC reconnects and confirms editor role persisted
    const cReconnected = await openRoomPage(browser, proxyUrl, canvasId, memberCAuth.token, 'MemberC-Reconnected');
    openContexts.push(cReconnected.ctx);
    await sleep(500);
    assert.equal(await cReconnected.page.locator('[data-viewer-readonly]').count(), 0, 'Reconnected MemberC is no longer viewer');
    const cNewLayer = await api(proxyUrl, memberCAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'MemberCRestoredLayer',
      layerType: 'raster',
    });
    assert.ok(cNewLayer.layer?.id, 'Reconnected MemberC can create layer');
    console.log('   ✓ Offline member role update & reconnect persistence verified');

    // 6. Responsive & multi-locale non-clipping checks
    console.log('\n[Step 5] Multi-viewport & multi-locale non-clipping checks');
    const viewports: Array<{ name: string; width: number; height: number }> = [
      { name: 'Desktop 1440x900', width: 1440, height: 900 },
      { name: 'Small Window 1024x680', width: 1024, height: 680 },
      { name: 'Tablet 820x1180', width: 820, height: 1180 },
      { name: 'Phone Portrait 390x844', width: 390, height: 844 },
      { name: 'Phone Landscape 844x390', width: 844, height: 390 },
    ];
    for (const vp of viewports) {
      await ownerSession.page.setViewportSize({ width: vp.width, height: vp.height });
      await sleep(300);
      await checkMembersPanelNoClipping(ownerSession.page, `${vp.name} (zh-TW)`, 'zh-TW');
    }

    // Check en-US & ja-JP on Phone Portrait (390x844) and Small Window (1024x680)
    for (const lang of ['en-US', 'ja-JP'] as const) {
      const langSession = await openRoomPage(browser, proxyUrl, canvasId, ownerAuth.token, `Owner-${lang}`, {
        viewport: { width: 390, height: 844 },
        language: lang,
      });
      openContexts.push(langSession.ctx);
      await checkMembersPanelNoClipping(langSession.page, `Phone Portrait 390x844 (${lang})`, lang);
      await langSession.page.setViewportSize({ width: 1024, height: 680 });
      await sleep(300);
      await checkMembersPanelNoClipping(langSession.page, `Small Window 1024x680 (${lang})`, lang);
      await langSession.ctx.close();
    }

    // Also verify viewer read-only badge doesn't clip on Phone Portrait (390x844)
    await ownerSession.page.setViewportSize({ width: 1440, height: 900 });
    await sleep(200);
    await api(proxyUrl, ownerAuth.token, 'PATCH', `/api/canvases/${canvasId}/members/${memberBAuth.user.id}/role`, {
      role: 'viewer',
    });
    await bTab1.page.setViewportSize({ width: 390, height: 844 });
    const viewerChip = bTab1.page.locator('[data-viewer-readonly]');
    await viewerChip.waitFor({ state: 'visible', timeout: 8000 });
    const chipCheck = await viewerChip.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const stage = (el.closest('.atelier-canvas-viewport') ?? document.documentElement).getBoundingClientRect();
      return {
        ok: r.width > 0 && r.height > 0 && r.left >= stage.left - 1 && r.right <= stage.right + 1,
        width: Math.round(r.width),
        stageWidth: Math.round(stage.width),
      };
    });
    assert.ok(chipCheck.ok, `Viewer read-only chip clipped on phone portrait: ${JSON.stringify(chipCheck)}`);
    console.log(`   ✓ Viewer read-only chip fits Phone Portrait (${chipCheck.width}px / ${chipCheck.stageWidth}px)`);

    // Restore MemberB back to editor to finish clean
    await api(proxyUrl, ownerAuth.token, 'PATCH', `/api/canvases/${canvasId}/members/${memberBAuth.user.id}/role`, {
      role: 'editor',
    });

    assert.equal(ownerSession.pageErrors.length, 0, `Owner page errors: ${ownerSession.pageErrors.join('; ')}`);
    assert.equal(bTab1.pageErrors.length, 0, `MemberB Tab1 page errors: ${bTab1.pageErrors.join('; ')}`);
    assert.equal(bTab2.pageErrors.length, 0, `MemberB Tab2 page errors: ${bTab2.pageErrors.join('; ')}`);

    console.log('\n=== ALL ROOM MEMBER ROLES E2E CHECKS PASSED ===');
  } finally {
    for (const s of openSockets) {
      try {
        s.disconnect();
      } catch {
        // ignore
      }
    }
    for (const c of openContexts) {
      await c.close().catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    if (proxyProc && proxyProc.exitCode === null) proxyProc.kill();
    if (serverProc && serverProc.exitCode === null) serverProc.kill();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});

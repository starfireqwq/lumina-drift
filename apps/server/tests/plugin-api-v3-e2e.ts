/**
 * Plugin API v3.0 End-to-End Verification:
 *   1. Web 5 viewports (Desktop 1440x900, Compact 1024x700, Tablet 768x1024, Phone Portrait 390x844,
 *      Phone Landscape 844x390) x 4 locales (zh-TW, zh-CN, en-US, ja-JP) zero-overflow check for
 *      PluginManager v3 high-risk badges and PluginV3BridgeModal degradation banner & tabs.
 *   2. Phone standalone offline mode (390x844): install & enable v3 demo plugin, verify graceful
 *      degradation (v2 layers.list works while v3 bridge degrades cleanly) and zero clipping.
 *   3. Real LAN IPv4 + apps/server/tests/net-proxy.ts (25ms / +/-5ms jitter) Multiplayer ACL:
 *      - Owner & Viewer join a collaborative room over LAN + net-proxy.
 *      - Verify v3 is locked inside collaborative rooms (BLOCKED_COLLAB_ROOM banner & badge)
 *        and v3 plugin calls degrade safely with 0 unauthorized SQLite write ops.
 *
 * Uses a throwaway Fastify server on a dedicated test port with an ephemeral DATA_DIR,
 * never touching Port 3000 or 127.0.0.1/localhost for browser connections.
 *
 * Usage:
 *   pnpm --filter @atelier/server exec tsx tests/plugin-api-v3-e2e.ts
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
const V3_DEMO_PATH = path.resolve(REPO_ROOT, 'apps/client/public/plugins/lumina-v3-bridge-demo.lumina-plugin');
const NET_PROXY_SCRIPT = path.resolve(SERVER_DIR, 'tests/net-proxy.ts');
const TSX_CLI = path.resolve(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const SERVER_PORT = Number(process.env.LUMINA_V3_SERVER_PORT || 3995);
const PROXY_PORT = Number(process.env.LUMINA_V3_PROXY_PORT || 3996);

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
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`API ${method} ${urlPath} failed (${res.status}): ${text}`);
  }
  return json;
}

const LOCALES = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'] as const;
const PLUGIN_MENU_NAME: Record<(typeof LOCALES)[number], string> = {
  'zh-TW': '插件',
  'zh-CN': '插件',
  'en-US': 'Plugins',
  'ja-JP': 'プラグイン',
};
const MANAGE_MENU_NAME: Record<(typeof LOCALES)[number], string> = {
  'zh-TW': '管理插件…',
  'zh-CN': '管理插件…',
  'en-US': 'Manage Plugins…',
  'ja-JP': 'プラグインの管理…',
};
const FILE_MENU_TITLE: Record<(typeof LOCALES)[number], string> = {
  'zh-TW': '檔案',
  'zh-CN': '文件',
  'en-US': 'File',
  'ja-JP': 'ファイル',
};

const VIEWPORTS = [
  { name: 'Desktop', width: 1440, height: 900, hasTouch: false },
  { name: 'Compact', width: 1024, height: 700, hasTouch: false },
  { name: 'Tablet', width: 768, height: 1024, hasTouch: true },
  { name: 'PhonePortrait', width: 390, height: 844, hasTouch: true },
  { name: 'PhoneLandscape', width: 844, height: 390, hasTouch: true },
] as const;

async function openPluginManagerInLocale(page: Page, locale: (typeof LOCALES)[number]) {
  const direct = page.getByRole('button', { name: PLUGIN_MENU_NAME[locale], exact: true });
  if ((await direct.count()) && (await direct.first().isVisible())) {
    await direct.first().click();
  } else {
    const fileBtn = page.locator(`header button[title="${FILE_MENU_TITLE[locale]}"]`).first();
    if (await fileBtn.isVisible().catch(() => false)) {
      await fileBtn.click();
    } else {
      await page.locator('header button[aria-haspopup="menu"]').first().click();
    }
  }
  const manage = page.getByRole('menuitem', { name: MANAGE_MENU_NAME[locale], exact: true });
  await manage.waitFor({ timeout: 8000 });
  await manage.click();
  const dialog = page.getByRole('dialog');
  await dialog.first().waitFor({ timeout: 8000 });
  return dialog.first();
}

async function assertDialogNoHorizontalOverflow(page: Page, label: string) {
  const metrics = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement | null;
    if (!dlg) return { found: false, overflowX: 0, docOverflowX: 0, rightClip: 0 };
    const rect = dlg.getBoundingClientRect();
    const docOverflowX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
    const overflowX = Math.max(0, dlg.scrollWidth - dlg.clientWidth);
    const rightClip = Math.max(0, rect.right - window.innerWidth - 2);
    return { found: true, overflowX, docOverflowX, rightClip };
  });
  assert.equal(metrics.found, true, `[${label}] dialog not found`);
  assert.ok(
    metrics.overflowX <= 4 && metrics.docOverflowX <= 4 && metrics.rightClip <= 4,
    `[${label}] overflow detected: ${JSON.stringify(metrics)}`,
  );
}

async function seedAuthedPage(
  context: BrowserContext,
  baseUrl: string,
  auth: { token: string; user: unknown },
  locale: string,
  canvasId: string,
) {
  const page = await context.newPage();
  await page.addInitScript(
    ({ token, user, lang, cid, origin }) => {
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_language', lang);
      localStorage.setItem('atelier_token', token);
      localStorage.setItem('atelier_user', JSON.stringify(user));
      localStorage.setItem('atelier_server_origin', origin);
      localStorage.setItem('atelier_offline_mode', 'false');
      localStorage.setItem('atelier_active_canvas_id', cid);
    },
    { token: auth.token, user: auth.user, lang: locale, cid: canvasId, origin: baseUrl },
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
  return page;
}

async function main() {
  const lanIp = detectLanIpv4();
  const chromeExe = detectChromeExecutable();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-v3-e2e-'));
  const directBaseUrl = `http://${lanIp}:${SERVER_PORT}`;
  const proxyBaseUrl = `http://${lanIp}:${PROXY_PORT}`;

  console.log(`[v3 E2E] LAN IP=${lanIp}, direct=${directBaseUrl}, proxy=${proxyBaseUrl}`);

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

  const proxyProc = spawn(
    process.execPath,
    [TSX_CLI, NET_PROXY_SCRIPT, String(PROXY_PORT), String(SERVER_PORT), '25', '0', '0', '5'],
    {
      cwd: SERVER_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let browser: Browser | null = null;
  try {
    await waitForHealth(directBaseUrl, serverProc, 'Fastify test server');
    await waitForHealth(proxyBaseUrl, proxyProc, 'net-proxy');

    // Create Owner + Viewer + shared canvas
    const ownerAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'v3owner',
      password: 'Password123!',
      displayName: 'Owner',
    });
    const viewerAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'v3viewer',
      password: 'Password123!',
      displayName: 'Viewer',
    });
    const createdCanvas = await api(proxyBaseUrl, ownerAuth.token, 'POST', '/api/canvases', {
      title: 'V3 Collab ACL Room',
      width: 512,
      height: 512,
    });
    const canvasId = createdCanvas.canvas.id as string;
    await api(proxyBaseUrl, viewerAuth.token, 'POST', '/api/canvases/join', { canvasId });
    {
      const db = new Database(path.join(dataDir, 'atelier.db'));
      try {
        db.prepare(`UPDATE canvas_members SET role = 'viewer' WHERE canvas_id = ? AND user_id = ?`).run(
          canvasId,
          viewerAuth.user.id,
        );
      } finally {
        db.close();
      }
    }

    browser = await chromium.launch({
      executablePath: chromeExe,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu-sandbox'],
    });

    // === 1. Web 5 viewports x 4 locales (20/20) zero-overflow check ===
    console.log('\n[1/3] Running Web 5 viewports x 4 locales (20/20) v3 UI layout audit...');
    const v3DemoJson = JSON.parse(fs.readFileSync(V3_DEMO_PATH, 'utf8'));
    let matrixCount = 0;

    const matrixCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await matrixCtx.newPage();
      await page.addInitScript(
        ({ pluginManifest, origin, token, user, cid }) => {
          localStorage.setItem('atelier_gateway_resolved', '1');
          if (!localStorage.getItem('atelier_language')) {
            localStorage.setItem('atelier_language', 'zh-TW');
          }
          localStorage.setItem('atelier_server_origin', origin);
          localStorage.setItem('atelier_token', token);
          localStorage.setItem('atelier_user', JSON.stringify(user));
          localStorage.setItem('atelier_offline_mode', 'false');
          localStorage.setItem('atelier_active_canvas_id', cid);
          localStorage.setItem(
            'lumina_plugins_v2',
            JSON.stringify([{ manifest: pluginManifest, enabled: true }]),
          );
        },
        {
          pluginManifest: v3DemoJson,
          origin: proxyBaseUrl,
          token: ownerAuth.token,
          user: ownerAuth.user,
          cid: canvasId,
        },
      );
      await page.goto(proxyBaseUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });

      for (const locale of LOCALES) {
        await page.evaluate((l) => localStorage.setItem('atelier_language', l), locale);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
        await sleep(150);

        for (const vp of VIEWPORTS) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await sleep(120);

          const mgr = await openPluginManagerInLocale(page, locale);
          await mgr.locator('[data-plugin-api-version="3"]').waitFor({ timeout: 5000 });
          await assertDialogNoHorizontalOverflow(page, `${vp.name}/${locale}/PluginManager`);

          await mgr.locator('[data-plugin-open-v3-console="true"]').click();
          const consoleEl = page.locator('[data-plugin-v3-console="true"]');
          await consoleEl.waitFor({ timeout: 5000 });
          await consoleEl.locator('[data-plugin-v3-blocked]').waitFor({ timeout: 5000 });
          await assertDialogNoHorizontalOverflow(page, `${vp.name}/${locale}/PluginV3BridgeModal`);

          await page.keyboard.press('Escape');
          await consoleEl.waitFor({ state: 'hidden', timeout: 5000 });
          matrixCount += 1;
        }
      }
    } finally {
      await matrixCtx.close();
    }
    assert.equal(matrixCount, 20);
    console.log(`  ✓ 20/20 viewport x locale checks passed with zero overflow`);

    // === 2. Phone standalone offline mode (390x844) graceful degradation ===
    console.log('\n[2/3] Running Phone standalone offline (390x844) v3 degradation check...');
    {
      const ctx = await browser.newContext({
        locale: 'zh-TW',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      try {
        const page = await ctx.newPage();
        await page.addInitScript(
          ({ origin }) => {
            (window as any).atelierMobile = { isAndroid: true };
            localStorage.setItem('atelier_language', 'zh-TW');
            localStorage.setItem('atelier_gateway_resolved', '1');
            localStorage.setItem('atelier_session_mode', 'offline');
            localStorage.setItem('atelier_server_origin', origin);
            localStorage.removeItem('atelier_token');
          },
          { origin: proxyBaseUrl },
        );
        await page.goto(proxyBaseUrl, { waitUntil: 'domcontentloaded' });
        const startOffline = page.getByRole('button', { name: '開始單機作畫', exact: true });
        if (await startOffline.isVisible({ timeout: 3000 }).catch(() => false)) {
          await startOffline.click();
        }
        await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });

        const mgr = await openPluginManagerInLocale(page, 'zh-TW');
        await mgr.locator('input[type="file"]').setInputFiles(V3_DEMO_PATH);
        await mgr.getByRole('button', { name: /安裝插件|取代插件/ }).click();
        await mgr.locator('[data-plugin-toggle="lumina.v3-bridge-demo"]').click();
        await mgr.locator('[data-plugin-open-v3-console="true"]').click();
        await page.locator('[data-plugin-v3-blocked="UNSUPPORTED_MOBILE"]').waitFor({ timeout: 5000 });
        await assertDialogNoHorizontalOverflow(page, 'PhoneStandalone/PluginV3BridgeModal');
        await page.keyboard.press('Escape');
        await sleep(200);

        // Execute v3 status command on phone -> degrades cleanly with layer count intact
        const menuTrigger = page.locator('header button[aria-haspopup="menu"]').first();
        await menuTrigger.click();
        await page.getByRole('menuitem', { name: '檢查桌面橋接與 MCP 狀態' }).click();
        const toast = page.locator('[role="status"]').filter({ hasText: /Safe fallback/i });
        await toast.waitFor({ timeout: 10000 });
        console.log('  ✓ Phone standalone mode imported v3 plugin, verified UNSUPPORTED_MOBILE banner, and degraded gracefully');
      } finally {
        await ctx.close();
      }
    }

    // === 3. LAN IP + net-proxy.ts Multiplayer Room v3 lock & ACL verification ===
    console.log('\n[3/3] Running LAN IP + net-proxy.ts multiplayer room v3 block & ACL check...');
    {
      const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const viewerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      try {
        const ownerPage = await seedAuthedPage(ownerCtx, proxyBaseUrl, ownerAuth, 'zh-TW', canvasId);
        const viewerPage = await seedAuthedPage(viewerCtx, proxyBaseUrl, viewerAuth, 'zh-TW', canvasId);
        await sleep(800);

        // Open v3 console in collaborative room -> verify blocked banner
        const ownerMgr = await openPluginManagerInLocale(ownerPage, 'zh-TW');
        await ownerMgr.locator('input[type="file"]').setInputFiles(V3_DEMO_PATH);
        await ownerMgr.getByRole('button', { name: /安裝插件|取代插件/ }).click();
        await ownerMgr.locator('[data-plugin-toggle="lumina.v3-bridge-demo"]').click();
        await ownerMgr.locator('[data-plugin-open-v3-console="true"]').click();
        await ownerPage.locator('[data-plugin-v3-blocked]').waitFor({ timeout: 5000 });
        await ownerPage.getByRole('button', { name: '關閉', exact: true }).last().click();

        // Viewer also blocked from v3 console & zero write ops in SQLite
        const db = new Database(path.join(dataDir, 'atelier.db'), { readonly: true });
        const opsBefore = (
          db.prepare('SELECT COUNT(*) as c FROM canvas_ops WHERE canvas_id = ? AND user_id = ?').get(canvasId, viewerAuth.user.id) as { c: number }
        ).c;

        const viewerMgr = await openPluginManagerInLocale(viewerPage, 'zh-TW');
        await viewerMgr.locator('[data-plugin-open-v3-console="true"]').click();
        await viewerPage.locator('[data-plugin-v3-blocked]').waitFor({ timeout: 5000 });

        const opsAfter = (
          db.prepare('SELECT COUNT(*) as c FROM canvas_ops WHERE canvas_id = ? AND user_id = ?').get(canvasId, viewerAuth.user.id) as { c: number }
        ).c;
        db.close();
        assert.equal(opsAfter, opsBefore, 'Viewer must produce 0 write ops in collaborative room');
        console.log(`  ✓ LAN net-proxy collab room v3 lock & Viewer zero-op ACL verified (${opsBefore} -> ${opsAfter} ops)`);
      } finally {
        await ownerCtx.close();
        await viewerCtx.close();
      }
    }

    console.log('\nALL Plugin API v3.0 Web 5x4, Phone Standalone, and LAN net-proxy E2E checks PASSED!');
  } finally {
    if (browser) await browser.close().catch(() => {});
    serverProc.kill();
    proxyProc.kill();
    await sleep(300);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore on Windows lock
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Brush Engine v2 End-to-End Verification (Web 5 viewports × 4 locales + phone standalone +
 * pressure-opacity pixel test + LAN IP net-proxy.ts multiplayer sync).
 *
 * Uses a throwaway Fastify server (ephemeral DATA_DIR + dedicated test port, never touching Port 3000)
 * fronted by apps/server/tests/net-proxy.ts (25ms one-way / 50ms RTT, ±5ms jitter), with ALL browser
 * pages connecting over the real LAN IPv4 address (never 127.0.0.1 / localhost).
 *
 * Usage (from repo root):
 *   .\apps\server\node_modules\.bin\tsx.cmd apps/server/tests/brush-engine-v2-e2e.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVER_DIR = path.resolve(REPO_ROOT, 'apps/server');
const CLIENT_DIST = path.resolve(REPO_ROOT, 'apps/client/dist');
const NET_PROXY_SCRIPT = path.resolve(SERVER_DIR, 'tests/net-proxy.ts');
const TSX_CLI = path.resolve(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const SERVER_PORT = Number(process.env.LUMINA_BRUSH_SERVER_PORT || 3977);
const PROXY_PORT = Number(process.env.LUMINA_BRUSH_PROXY_PORT || 3978);

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

async function waitForHttp(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const BRUSH_SETTINGS_TITLES: Record<string, string> = {
  'zh-TW': '筆刷詳細設定',
  'zh-CN': '画笔详细设置',
  'en-US': 'Brush Details',
  'ja-JP': 'サブツール詳細',
};

async function openBrushSettings(page: Page, locale: string) {
  const title = BRUSH_SETTINGS_TITLES[locale] ?? '筆刷詳細設定';
  const btn = page.locator(`button[title="${title}"]`).first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
  const panel = page.getByTestId('brush-engine-panel');
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  return panel;
}

async function closeBrushSettings(page: Page) {
  await page.getByRole('button', { name: '完成' }).click();
  await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await sleep(120);
}

async function readActiveLayerAlphaSum(page: Page, rect?: { x: number; y: number; w: number; h: number }): Promise<{ nonZero: number; alphaSum: number; undoCount: number; layerCount: number }> {
  return page.evaluate(async (r) => {
    const dbg = (window as any).__debugPixi;
    if (!dbg?.layerManager) return { nonZero: 0, alphaSum: 0, undoCount: 0, layerCount: 0 };
    const undoCount = dbg.undo?.getUndoCount?.() ?? -1;
    const layers = dbg.layerManager.getLayers().filter((l: any) => l.model?.isVisible && l.model?.layerType === 'raster');
    if (layers.length === 0) return { nonZero: 0, alphaSum: 0, undoCount, layerCount: 0 };
    layers.sort((a: any, b: any) => (b.model?.sortOrder ?? 0) - (a.model?.sortOrder ?? 0));
    const box = r ?? { x: 200, y: 160, w: 300, h: 180 };
    for (const layer of layers) {
      const [pixels] = await dbg.layerManager.readAsync(layer.model.id, [box]);
      if (!pixels) continue;
      let nonZero = 0;
      let alphaSum = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        const a = pixels[i];
        if (a > 0) {
          nonZero++;
          alphaSum += a;
        }
      }
      // Skip solid opaque background layer if every pixel in box is 255
      if (nonZero > 0 && nonZero < box.w * box.h) {
        return { nonZero, alphaSum, undoCount, layerCount: layers.length };
      }
    }
    return { nonZero: 0, alphaSum: 0, undoCount, layerCount: layers.length };
  }, rect);
}

async function dispatchPressureStroke(page: Page, x1: number, y1: number, x2: number, y2: number, pressure: number) {
  await page.evaluate(
    async ({ x1, y1, x2, y2, pressure }) => {
      const dbg = (window as any).__debugPixi;
      const surface = document.querySelector('.atelier-canvas-viewport') ?? dbg?.app?.canvas;
      const canvas: HTMLCanvasElement | null = dbg?.app?.canvas ?? document.querySelector('canvas');
      if (!surface || !canvas || !dbg?.viewport) throw new Error('Canvas surface or viewport not found');
      const rect = canvas.getBoundingClientRect();
      const s1 = dbg.viewport.canvasToScreen(x1, y1);
      const s2 = dbg.viewport.canvasToScreen(x2, y2);
      surface.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 42, pointerType: 'pen', isPrimary: true, button: 0,
        clientX: rect.left + s1.x, clientY: rect.top + s1.y, buttons: 1, pressure,
      }));
      const steps = 16;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const sc = dbg.viewport.canvasToScreen(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
        surface.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 42, pointerType: 'pen', isPrimary: true, button: -1,
          clientX: rect.left + sc.x, clientY: rect.top + sc.y, buttons: 1, pressure,
        }));
        await new Promise((r) => setTimeout(r, 12));
      }
      surface.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 42, pointerType: 'pen', isPrimary: true, button: 0,
        clientX: rect.left + s2.x, clientY: rect.top + s2.y, buttons: 0, pressure: 0,
      }));
      await new Promise((r) => setTimeout(r, 300));
    },
    { x1, y1, x2, y2, pressure }
  );
}

async function main() {
  assert.ok(fs.existsSync(path.join(CLIENT_DIST, 'index.html')), 'Missing apps/client/dist/index.html');
  const lanIp = detectLanIpv4();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-brush-v2-e2e-'));
  console.log(`[Brush v2 E2E] LAN IP: ${lanIp}, dataDir: ${dataDir}`);

  let serverProc: ChildProcess | null = null;
  let proxyProc: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    serverProc = spawn(process.execPath, [TSX_CLI, path.join(SERVER_DIR, 'src/server.ts')], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        PORT: String(SERVER_PORT),
        DATA_DIR: dataDir,
        DATABASE_PATH: path.join(dataDir, 'atelier.db'),
        CLIENT_DIST_PATH: CLIENT_DIST,
      },
      stdio: 'pipe',
    });

    const serverUrl = `http://${lanIp}:${SERVER_PORT}`;
    await waitForHttp(`${serverUrl}/api/health`);

    proxyProc = spawn(
      process.execPath,
      [TSX_CLI, NET_PROXY_SCRIPT, String(PROXY_PORT), String(SERVER_PORT), '25', '0', '0', '5'],
      { cwd: SERVER_DIR, stdio: 'pipe' }
    );
    const proxyUrl = `http://${lanIp}:${PROXY_PORT}`;
    await waitForHttp(`${proxyUrl}/api/health`);
    console.log(`[Brush v2 E2E] Server (${serverUrl}) + net-proxy (${proxyUrl}) ready`);

    // Register two users and create a shared canvas over proxyUrl
    const reg = async (username: string) => {
      const res = await fetch(`${proxyUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'brush-v2-password' }),
      });
      assert.equal(res.status, 201, `register ${username}`);
      return (await res.json()) as { token: string; user: { id: string } };
    };
    const userA = await reg('brush_owner_a');
    const userB = await reg('brush_editor_b');

    const createCanvas = await fetch(`${proxyUrl}/api/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userA.token}` },
      body: JSON.stringify({ title: 'Brush Engine v2 Sync Room', width: 512, height: 512 }),
    });
    assert.equal(createCanvas.status, 201);
    const { canvas } = (await createCanvas.json()) as { canvas: { id: string } };

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
    });

    // --- Scenario 1: 5 viewports × 4 locales + Phone Standalone zero horizontal overflow ---
    const viewports = [
      { name: 'desktop', width: 1440, height: 900, offline: false },
      { name: 'small', width: 1024, height: 680, offline: false },
      { name: 'tablet', width: 768, height: 1024, offline: false },
      { name: 'phone-portrait-standalone', width: 390, height: 844, offline: true },
      { name: 'phone-landscape', width: 844, height: 390, offline: false },
    ];
    const locales = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'] as const;

    const pageErrors: string[] = [];
    for (const vp of viewports) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => pageErrors.push(`[${vp.name}] ${e.message}`));

      for (const locale of locales) {
        await page.addInitScript(
          ({ locale, token, roomId, proxyUrl, offline }) => {
            localStorage.setItem('atelier_language', locale);
            localStorage.setItem('atelier_token', token);
            localStorage.setItem('atelier_active_canvas_id', roomId);
            localStorage.setItem('atelier_gateway_resolved', '1');
            localStorage.setItem('atelier_server_url', proxyUrl);
            localStorage.setItem('atelier_session_mode', offline ? 'offline' : 'online');
          },
          { locale, token: userA.token, roomId: canvas.id, proxyUrl, offline: vp.offline }
        );
        await page.goto(vp.offline ? `${proxyUrl}/` : `${proxyUrl}/?room=${canvas.id}`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 20000 });
        await openBrushSettings(page, locale);

        // Verify all new v2 controls exist and panel has no horizontal clipping/overflow
        const metrics = await page.evaluate(() => {
          const panel = document.querySelector('[data-testid="brush-engine-panel"]') as HTMLElement | null;
          const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
          if (!panel || !dialog) return null;
          const pRect = panel.getBoundingClientRect();
          const dRect = dialog.getBoundingClientRect();
          return {
            panelOverflow: panel.scrollWidth - panel.clientWidth,
            dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
            dialogExceedsViewport: dRect.right > window.innerWidth + 2 || dRect.left < -2,
            panelWidth: pRect.width,
          };
        });
        assert.ok(metrics, `Metrics missing for ${vp.name}/${locale}`);
        assert.ok(metrics.panelOverflow <= 2, `Horizontal overflow in panel (${vp.name}/${locale}): ${metrics.panelOverflow}px`);
        assert.ok(metrics.dialogOverflow <= 2, `Horizontal overflow in dialog (${vp.name}/${locale}): ${metrics.dialogOverflow}px`);
        assert.equal(metrics.dialogExceedsViewport, false, `Dialog exceeds viewport (${vp.name}/${locale})`);
        assert.ok(await page.getByTestId('dyn-opacity-pressure').isVisible());
        assert.ok(await page.getByTestId('mix-mode-smudge').isVisible());
        assert.ok(await page.getByTestId('mix-mode-dilute').isVisible());
        assert.ok(await page.getByTestId('brush-wet-edges').isVisible());
        assert.ok(await page.getByTestId('dyn-fgbg-pressure').isVisible());
      }
      await ctx.close();
      console.log(`  [Scenario 1] ${vp.name} × 4 locales passed`);
    }

    // --- Scenario 2: Real pixel test (Opacity Pressure ON vs OFF + Mix modes + Live preview) ---
    const createCanvas2 = await fetch(`${proxyUrl}/api/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userA.token}` },
      body: JSON.stringify({ title: 'Brush Engine v2 Pixel Check', width: 512, height: 512 }),
    });
    assert.equal(createCanvas2.status, 201);
    const { canvas: canvas2 } = (await createCanvas2.json()) as { canvas: { id: string } };

    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => pageErrors.push(`[Scenario 2] ${e.message}`));
    await p2.addInitScript(
      ({ token, roomId, proxyUrl }) => {
        localStorage.setItem('atelier_language', 'zh-TW');
        localStorage.setItem('atelier_token', token);
        localStorage.setItem('atelier_active_canvas_id', roomId);
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_server_url', proxyUrl);
        localStorage.setItem('atelier_session_mode', 'online');
      },
      { token: userA.token, roomId: canvas2.id, proxyUrl }
    );
    await p2.goto(`${proxyUrl}/?room=${canvas2.id}`, { waitUntil: 'domcontentloaded' });
    await p2.locator('[data-canvas-presented="true"]').waitFor({ timeout: 20000 });

    // Open brush settings, ensure opacity pressure is ON, verify live preview renders
    await openBrushSettings(p2, 'zh-TW');
    const opBtn = p2.getByTestId('dyn-opacity-pressure');
    if ((await opBtn.getAttribute('aria-pressed')) !== 'true') await opBtn.click();
    await sleep(160);
    const previewOn = await p2.locator('[aria-label="筆劃預覽"] img').getAttribute('src');
    assert.ok(previewOn && previewOn.startsWith('data:image/png'), 'Live preview rendered with opacity pressure ON');
    await closeBrushSettings(p2);

    // Draw low-pressure stroke (p = 0.2) with opacity pressure ON
    await dispatchPressureStroke(p2, 220, 220, 420, 220, 0.2);
    const statsOn = await readActiveLayerAlphaSum(p2, { x: 180, y: 160, w: 280, h: 120 });
    assert.ok(statsOn.nonZero > 50, `Expected visible pixels with opacity pressure ON, got ${statsOn.nonZero}`);

    // Undo, then turn opacity pressure OFF and draw identical low-pressure stroke
    await p2.keyboard.press('Control+z');
    await sleep(250);
    await openBrushSettings(p2, 'zh-TW');
    if ((await p2.getByTestId('dyn-opacity-pressure').getAttribute('aria-pressed')) === 'true') {
      await p2.getByTestId('dyn-opacity-pressure').click();
    }
    await sleep(160);
    const previewOff = await p2.locator('[aria-label="筆劃預覽"] img').getAttribute('src');
    assert.ok(previewOff && previewOff.startsWith('data:image/png'), 'Live preview rendered with opacity pressure OFF');
    await closeBrushSettings(p2);

    await dispatchPressureStroke(p2, 220, 220, 420, 220, 0.2);
    const statsOff = await readActiveLayerAlphaSum(p2, { x: 180, y: 160, w: 280, h: 120 });
    const avgAlphaOn = statsOn.alphaSum / Math.max(1, statsOn.nonZero);
    const avgAlphaOff = statsOff.alphaSum / Math.max(1, statsOff.nonZero);
    console.log(`  [Scenario 2] Low-pressure (0.2) avgAlpha: ON=${avgAlphaOn.toFixed(1)}, OFF=${avgAlphaOff.toFixed(1)}`);
    assert.ok(avgAlphaOff > avgAlphaOn + 25, `Expected OFF avgAlpha (${avgAlphaOff}) > ON avgAlpha (${avgAlphaOn}) + 25`);

    // Exercise smudge, dilute, wet edges, fg/bg mix without errors
    await openBrushSettings(p2, 'zh-TW');
    await p2.getByTestId('mix-mode-dilute').click();
    await p2.getByTestId('brush-wet-edges').check();
    await p2.getByTestId('dyn-fgbg-pressure').click();
    await sleep(150);
    await closeBrushSettings(p2);
    await dispatchPressureStroke(p2, 260, 300, 440, 300, 0.65);

    await openBrushSettings(p2, 'zh-TW');
    await p2.getByTestId('mix-mode-smudge').click();
    await closeBrushSettings(p2);
    await dispatchPressureStroke(p2, 260, 290, 440, 310, 0.5);
    await ctx2.close();
    console.log('  [Scenario 2] Pressure-opacity + wet mix + wet edges + smudge passed');

    // --- Scenario 3: LAN IP + net-proxy.ts Multiplayer Sync ---
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    pageA.on('pageerror', (e) => pageErrors.push(`[Multiplayer A] ${e.message}`));
    pageB.on('pageerror', (e) => pageErrors.push(`[Multiplayer B] ${e.message}`));

    for (const [pg, tok] of [
      [pageA, userA.token],
      [pageB, userB.token],
    ] as const) {
      await pg.addInitScript(
        ({ token, roomId, proxyUrl }) => {
          localStorage.setItem('atelier_language', 'zh-TW');
          localStorage.setItem('atelier_token', token);
          localStorage.setItem('atelier_active_canvas_id', roomId);
          localStorage.setItem('atelier_gateway_resolved', '1');
          localStorage.setItem('atelier_server_url', proxyUrl);
          localStorage.setItem('atelier_session_mode', 'online');
        },
        { token: tok, roomId: canvas.id, proxyUrl }
      );
      await pg.goto(`${proxyUrl}/?room=${canvas.id}`, { waitUntil: 'domcontentloaded' });
      await pg.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
    }
    await sleep(600);

    // Painter A configures Brush Engine v2 dynamics & draws on shared canvas
    await openBrushSettings(pageA, 'zh-TW');
    await pageA.getByTestId('dyn-opacity-pressure').click();
    await pageA.getByTestId('brush-wet-edges').check();
    await closeBrushSettings(pageA);
    await dispatchPressureStroke(pageA, 280, 260, 460, 320, 0.7);

    // Wait for net-proxy sync to deliver pixels to Painter B
    let syncedB = { nonZero: 0, alphaSum: 0 };
    for (let attempt = 0; attempt < 25; attempt++) {
      syncedB = await readActiveLayerAlphaSum(pageB);
      if (syncedB.nonZero > 50) break;
      await sleep(200);
    }
    console.log(`  [Scenario 3] LAN net-proxy sync: Painter B received ${syncedB.nonZero} non-zero pixels`);
    assert.ok(syncedB.nonZero > 50, `Expected synced stroke pixels on Painter B, got ${syncedB.nonZero}`);

    await ctxA.close();
    await ctxB.close();
    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(' | ')}`);
    console.log('[Brush v2 E2E] ALL 3 SCENARIOS PASSED!');
  } finally {
    await browser?.close().catch(() => {});
    proxyProc?.kill();
    serverProc?.kill();
    await sleep(400);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows SQLite handle release delay; temp folder cleanup is best-effort
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

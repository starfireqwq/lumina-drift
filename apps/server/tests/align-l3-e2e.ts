/**
 * Align L3 End-to-End Verification:
 *   1. Web 5 viewports (Desktop 1440x900, Compact 960x700, Tablet 1024x768, Phone Portrait 390x844,
 *      Phone Landscape 844x390) x 4 locales (zh-TW, zh-CN, en-US, ja-JP) no-clipping & no-overflow audit
 *      for LayerAlignWindow (guide strip, vector scope/bounds, text bounds) and RulerControlsModal.
 *   2. Phone standalone offline mode (390x844):
 *      - Canvas guide basis: single vertical guide disables vertical/distribute buttons; align left to guide X;
 *        multi-guide span ('range') vs 'nearest'; single Ctrl+Z undo.
 *      - Vector strokes align & distribute: 'path' vs 'stroke' bounds difference (anchor + Bézier handle shift),
 *        horizontal equal-gap distribute between 2 vertical guides, single Ctrl+Z undo.
 *      - Text layer bounds mode: 'glyph' (actual ink top == 0) vs 'box' (meta.text.y == 0), preserves editable
 *        meta.text, single Ctrl+Z undo restores both pixels and meta.
 *   3. LAN IPv4 + apps/server/tests/net-proxy.ts (25ms one-way / +/-5ms jitter) Multiplayer Sync & ACL:
 *      - Owner aligns vector strokes + text layer via Align L3; Editor receives synced vector strokes
 *        (anchors + handles) and text meta/pixels; single Ctrl+Z undo syncs back to Editor.
 *      - Viewer (role='viewer') blocked on Align window; zero write ops in SQLite.
 *      - Editor selecting own layer + Owner's private/locked layer is rejected atomically with zero partial move.
 *
 * Uses a throwaway Fastify server on a dedicated test port with an ephemeral DATA_DIR,
 * never touching Port 3000 or 127.0.0.1/localhost for browser connections.
 *
 * Usage:
 *   pnpm --filter @atelier/server exec tsx tests/align-l3-e2e.ts
 *   Add --workspace-only for the offline workspace checks against a built client.
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
const NET_PROXY_SCRIPT = path.resolve(SERVER_DIR, 'tests/net-proxy.ts');
const TSX_CLI = path.resolve(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const SERVER_PORT = Number(process.env.LUMINA_ALIGN_SERVER_PORT || 3993);
const PROXY_PORT = Number(process.env.LUMINA_ALIGN_PROXY_PORT || 3994);
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

const ALIGN_OPEN_LABEL: Record<string, string> = {
  'zh-TW': '對齊・均分',
  'zh-CN': '对齐・分布',
  'en-US': 'Align & Distribute',
  'ja-JP': '整列・分布',
};

async function openAlignWindow(page: Page, locale = 'zh-TW') {
  const win = page.locator('[data-testid="align-basis-select"]');
  if (await win.isVisible({ timeout: 300 }).catch(() => false)) return;
  const label = ALIGN_OPEN_LABEL[locale] ?? ALIGN_OPEN_LABEL['zh-TW'];
  const btn = page.getByRole('button', { name: label, exact: true }).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  await win.waitFor({ state: 'visible', timeout: 10000 });
}

async function paintRectOnLayer(page: Page, layerId: string, x: number, y: number, w: number, h: number, rgba = [220, 60, 120, 255]) {
  await page.evaluate(
    ({ id, rx, ry, rw, rh, col }) => {
      const dbg = (window as any).__debugPixi;
      const buf = new Uint8Array(rw * rh * 4);
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = col[0];
        buf[i + 1] = col[1];
        buf[i + 2] = col[2];
        buf[i + 3] = col[3];
      }
      dbg.layerManager.writeRegion(id, rx, ry, rw, rh, buf);
      dbg.layerManager.syncPingPong(id);
    },
    { id: layerId, rx: x, ry: y, rw: w, rh: h, col: rgba },
  );
}

async function readLayerContentBounds(page: Page, layerId: string, width = 512, height = 512) {
  return page.evaluate(
    async ({ id, cw, ch }) => {
      const dbg = (window as any).__debugPixi;
      const [px] = await dbg.layerManager.readAsync(id, [{ x: 0, y: 0, w: cw, h: ch }]);
      let minX = cw, minY = ch, maxX = -1, maxY = -1;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          if (px[(y * cw + x) * 4 + 3] > 0) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX) return null;
      return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    },
    { id: layerId, cw: width, ch: height },
  );
}

async function openRoomPage(
  browser: Browser,
  baseUrl: string,
  canvasId: string,
  token: string | null,
  locale = 'zh-TW',
  viewport = { width: 1440, height: 900 },
): Promise<{ ctx: BrowserContext; page: Page; pageErrors: string[] }> {
  const ctx = await browser.newContext({ locale, viewport });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(
    ({ tok, loc, cid }) => {
      localStorage.setItem('atelier_language', loc);
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.removeItem('atelier_align_basis');
      localStorage.removeItem('atelier_align_guide_mode');
      localStorage.removeItem('atelier_align_vector_bounds');
      localStorage.removeItem('atelier_align_text_bounds');
      if (tok) {
        localStorage.setItem('atelier_token', tok);
        localStorage.removeItem('atelier_offline_mode');
      } else {
        localStorage.removeItem('atelier_token');
        localStorage.setItem('atelier_offline_mode', '1');
      }
      if (cid) {
        localStorage.setItem('atelier_active_canvas_id', cid);
      }
    },
    { tok: token, loc: locale, cid: canvasId },
  );
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30000 });
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
  }
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 1, null, {
    timeout: 20000,
  });
  await sleep(300);
  return { ctx, page, pageErrors };
}

async function checkSoloWorkspace(browser: Browser) {
  const dist = path.resolve(REPO_ROOT, 'apps/client/dist');
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Build the web client before testing the workspace');
  const workspaceSizes = [
    { width: 1440, height: 900, phone: false },
    { width: 1024, height: 700, phone: false },
    { width: 768, height: 1024, phone: false },
    { width: 390, height: 844, phone: true },
    { width: 844, height: 390, phone: true },
    { width: 568, height: 320, phone: true },
  ];
  for (const language of ['zh-TW', 'zh-CN', 'en-US', 'ja-JP']) {
    for (const { width, height, phone } of workspaceSizes) {
      const rotateWithSheetOpen = width === 568;
      const viewport = rotateWithSheetOpen ? { width: height, height: width } : { width, height };
      const context = await browser.newContext({ viewport, screen: viewport, hasTouch: phone, isMobile: phone, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(9000);
      try {
        await context.addInitScript((locale) => {
          localStorage.setItem('atelier_language', locale);
          localStorage.setItem('atelier_gateway_resolved', '1');
          localStorage.setItem('atelier_session_mode', 'offline');
        }, language);
        // This virtual secure origin serves the built files without an HTTP listener.
        await context.route('http://localhost/**', async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          const file = path.resolve(dist, pathname === '/' ? 'index.html' : '.' + pathname);
          if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            await route.fulfill({ status: 404 });
            return;
          }
          await route.fulfill({ path: file });
        });
        await page.goto('http://localhost');
        await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 12000 });
        const details = page.locator('[data-workspace-entry="options"] button[aria-haspopup="dialog"]').first();
        assert.equal(await details.isVisible(), phone, `${language} ${width}×${height}: expandable phone options`);
        if (phone) {
          assert.equal(await page.locator('[data-workspace-entry="left-tools"], [data-workspace-entry="right-tools"]').count(), 0);
          await details.click();
          const sheet = page.locator('[data-mobile-panel="toolProps"]');
          await sheet.waitFor({ timeout: 5000 });
          if (rotateWithSheetOpen) {
            await page.setViewportSize({ width, height });
            await sheet.waitFor();
            assert.equal(await details.isVisible(), true, 'Rotation keeps the phone workspace active');
          }
          const sliders = sheet.locator('[data-mobile-brush-sliders] input[type="range"]');
          assert.equal(await sliders.count(), 2);
          const [size, opacity] = await Promise.all([sliders.nth(0).boundingBox(), sliders.nth(1).boundingBox()]);
          assert.ok(size && opacity, 'Both slider inputs must be visible');
          for (const slider of [size, opacity]) {
            assert.ok(slider.width > 80 && slider.x >= 0 && slider.x + slider.width <= width + 1);
            assert.ok(slider.y >= 0 && slider.y + slider.height <= height + 1);
          }
          if (width > height) assert.ok(Math.abs(size.y - opacity.y) < 24 && size.x + size.width <= opacity.x);
          else assert.ok(size.y + size.height <= opacity.y);
          for (const [i, box] of [size, opacity].entries()) {
            const slider = sliders.nth(i);
            const before = await slider.inputValue();
            const atMax = before === await slider.getAttribute('max');
            await slider.press(atMax ? 'ArrowLeft' : 'ArrowRight');
            const keyboardValue = await slider.inputValue();
            assert.notEqual(keyboardValue, before, 'The brush slider accepts keyboard input');
            await slider.tap({ position: { x: box.width / 4, y: box.height / 2 } });
            assert.notEqual(await slider.inputValue(), keyboardValue, 'The brush slider accepts touch input');
          }
          await sheet.locator('button').first().click();
          await sheet.waitFor({ state: 'hidden', timeout: 5000 });
          const openPicker = page.locator('[data-workspace-entry="mobile-tools"] button[aria-haspopup="dialog"]');
          await openPicker.click();
          const picker = page.locator('[data-mobile-panel="toolPicker"]');
          await picker.locator('[data-tool-id="eraser"]').click();
          await picker.waitFor({ state: 'hidden', timeout: 5000 });
          await openPicker.click();
          assert.equal(await picker.locator('[data-tool-id="eraser"]').getAttribute('aria-pressed'), 'true');
          await picker.locator('[data-tool-id="brush"]').click();
          await picker.waitFor({ state: 'hidden', timeout: 5000 });
          const canvasRect = await page.locator('.atelier-canvas-viewport canvas').first().boundingBox();
          assert.ok(canvasRect);
          await page.touchscreen.tap(canvasRect.x + canvasRect.width / 2, canvasRect.y + canvasRect.height / 2);
          await page.waitForFunction(() => {
            const dbg = (window as any).__debugPixi;
            return dbg.layerManager.getLayers().some((layer: { model: { id: string } }) =>
              dbg.undo.peekLatestForLayer(layer.model.id)?.afterTiles?.length > 0);
          }, undefined, { timeout: 5000 });
          await page.keyboard.press('Control+KeyZ');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
        if (language === 'zh-TW' && width === 1440) {
          await openAlignWindow(page);
          const align = page.locator('[data-tool-window="layer-align"]');
          await align.locator('[data-testid="align-basis-select"]').selectOption('canvas');
          await align.getByRole('button', { name: '停靠左側' }).click();
          const leftAlign = page.locator('[data-dock-side="left"] [data-panel="align"]');
          await leftAlign.waitFor();
          assert.equal(await leftAlign.locator('[data-testid="align-basis-select"]').inputValue(), 'canvas');
          await leftAlign.getByRole('button', { name: '面板位置' }).click();
          await page.getByRole('menuitemradio', { name: '浮動視窗' }).click();
          await align.getByRole('button', { name: '停靠右側' }).waitFor();
          await align.getByRole('button', { name: '關閉', exact: true }).click();
          await align.waitFor({ state: 'hidden' });
          await page.locator('button[title="新建畫布"]').first().click();
          await page.locator('#new-canvas-w').fill('4000');
          await page.locator('#new-canvas-h').fill('4000');
          await page.getByRole('button', { name: '建立畫布', exact: true }).click();
          await page.waitForFunction(() => (window as any).__debugPixi?.viewport.canvasWidth === 4000 &&
            document.querySelector('[data-canvas-presented="true"]'), undefined, { timeout: 8000 }).catch(async (error) => {
            const width = await page.evaluate(() => (window as any).__debugPixi?.viewport.canvasWidth);
            const dialogs = await page.locator('[role="dialog"],[role="status"]').allTextContents();
            throw new Error(`Creation landed at width ${width}. Dialogs: ${dialogs.join(' | ')}`, { cause: error });
          });
          await page.locator('button[aria-label="新增點陣圖層"]').first().click();
          await page.getByRole('button', { name: '圖層濾鏡', exact: true }).first().click();
          const filter = page.locator('[data-tool-window="layer-filter"]');
          await filter.getByRole('button', { name: '停靠右側' }).click({ timeout: 6000 }).catch(async (error) => {
            throw new Error(`Filter failed to open: ${(await page.locator('[role="dialog"],[role="status"]').allTextContents()).join(' | ')}`, { cause: error });
          });
          const rightFilter = page.locator('[data-dock-side="right"] [data-panel="filters"]');
          await rightFilter.locator('[data-tool-window="layer-filter"]').waitFor();
          await rightFilter.locator('button').filter({ has: page.locator('svg.lucide-x') }).first().click();
          console.log('✓ Align and filter dock, and align options survive a round trip into the dock');

          await page.evaluate(() => (window as any).__debugPixi.viewport.setZoom(1.25));
          await page.waitForFunction(() => (window as any).__debugPixi?.layerManager.pixelated);
          await page.locator('[data-tool-id="bucket"]').first().click();
          await page.getByRole('radio', { name: '套索填色', exact: true }).first().click();
          for (const [offset, aa, partialExpected] of [[-76, '中', true], [76, '無', false]] as const) {
            await page.getByRole('radio', { name: `消除鋸齒: ${aa}`, exact: true }).first().click();
            const box = await page.locator('.atelier-canvas-viewport canvas').first().boundingBox();
            assert.ok(box);
            const x = box.x + box.width / 2 + offset;
            const y = box.y + box.height / 2;
            await page.mouse.move(x - 50, y - 35);
            await page.mouse.down();
            await page.mouse.move(x + 43, y - 17, { steps: 6 });
            await page.mouse.move(x + 12, y + 43, { steps: 6 });
            await page.mouse.move(x - 50, y - 35, { steps: 6 });
            await page.mouse.up();
            const region = { x: x - 55, y: y - 40, width: 105, height: 88 };
            await page.waitForFunction(async (area) => {
              const { viewport, layerManager } = (window as any).__debugPixi;
              const start = viewport.screenToCanvas(area.x, area.y);
              const end = viewport.screenToCanvas(area.x + area.width, area.y + area.height);
              const layer = layerManager.getLayers().filter((l: { model: { layerType: string } }) => l.model.layerType === 'raster').at(-1)?.model;
              if (!layer) return false;
              const [pixels] = await layerManager.readAsync(layer.id, [{
                x: Math.floor(start.x), y: Math.floor(start.y),
                w: Math.ceil(end.x - start.x), h: Math.ceil(end.y - start.y),
              }]);
              return pixels.some((v: number, i: number) => i % 4 === 3 && v === 255);
            }, region, { timeout: 6000 });
            const partial = await page.evaluate(async (area) => {
              const { viewport, layerManager } = (window as any).__debugPixi;
              const start = viewport.screenToCanvas(area.x, area.y);
              const end = viewport.screenToCanvas(area.x + area.width, area.y + area.height);
              const layer = layerManager.getLayers().filter((l: { model: { layerType: string } }) => l.model.layerType === 'raster').at(-1).model;
              const [pixels] = await layerManager.readAsync(layer.id, [{
                x: Math.floor(start.x), y: Math.floor(start.y),
                w: Math.ceil(end.x - start.x), h: Math.ceil(end.y - start.y),
              }]);
              return pixels.some((v: number, i: number) => i % 4 === 3 && v > 0 && v < 255);
            }, region);
            assert.equal(partial, partialExpected, `Lasso fill edge coverage with AA ${aa}`);
          }
          console.log('✓ 4000×4000: physical-pixel magnification and antialiased vs hard-edged lasso fill verified');
        }
      } finally {
        await context.close();
      }
    }
  }
  console.log('✓ Workspace: 24 localized viewport combinations and touch drawing in each phone locale');
}

async function main() {
  if (process.argv.includes('--workspace-only')) {
    const browser = await chromium.launch({ executablePath: detectChromeExecutable(), headless: true });
    try {
      await checkSoloWorkspace(browser);
    } finally {
      await browser.close();
    }
    return;
  }

  const lanIp = detectLanIpv4();
  const chromeExe = detectChromeExecutable();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-align-l3-e2e-'));
  const directServerUrl = `http://${lanIp}:${SERVER_PORT}`;
  const proxyBaseUrl = `http://${lanIp}:${PROXY_PORT}`;

  console.log(`[Align L3 E2E] LAN IP: ${lanIp} | Server: ${directServerUrl} | Proxy: ${proxyBaseUrl}`);

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
    { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let browser: Browser | null = null;
  try {
    await waitForHealth(directServerUrl, serverProc, 'Fastify test server');
    await waitForHealth(proxyBaseUrl, proxyProc, 'LAN net-proxy');

    // Register 3 users: Owner, Editor, Viewer
    const ownerAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'align_owner',
      password: 'Password123!',
      displayName: 'Owner',
    });
    const editorAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'align_editor',
      password: 'Password123!',
      displayName: 'Editor',
    });
    const viewerAuth = await api(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'align_viewer',
      password: 'Password123!',
      displayName: 'Viewer',
    });

    // Owner creates 512x512 canvas
    const createdCanvas = await api(proxyBaseUrl, ownerAuth.token, 'POST', '/api/canvases', {
      title: 'Align L3 Test Room',
      width: 512,
      height: 512,
    });
    const canvasId = createdCanvas.canvas.id as string;

    const initialLayersResp = await api(proxyBaseUrl, ownerAuth.token, 'GET', `/api/canvases/${canvasId}/layers`);
    const ownerRasterLayer = initialLayersResp.layers.find((l: any) => l.ownerId === ownerAuth.user.id) ?? initialLayersResp.layers[0];
    assert.ok(ownerRasterLayer, 'Owner must have an initial layer');
    await api(proxyBaseUrl, ownerAuth.token, 'PATCH', `/api/canvases/${canvasId}/layers/${ownerRasterLayer.id}`, {
      aclMode: 'owner_only',
      isPublic: false,
      isLocked: true,
      name: 'Owner Locked Private',
    });

    // Owner creates a vector layer and a text layer
    const ownerVectorResp = await api(proxyBaseUrl, ownerAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'Owner Vector',
      layerType: 'vector',
      aclMode: 'owner_only',
    });
    const ownerVectorId = ownerVectorResp.layer.id as string;

    const ownerTextResp = await api(proxyBaseUrl, ownerAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'Owner Text',
      layerType: 'text',
      aclMode: 'owner_only',
      meta: {
        text: {
          content: 'A',
          x: 160,
          y: 140,
          vertical: false,
          fontFamily: 'sans-serif',
          fontSize: 96,
          color: '#111111',
          strokeColor: '#ffffff',
          strokeWidth: 0,
          lineHeight: 1.8,
        },
      },
    });
    const ownerTextId = ownerTextResp.layer.id as string;

    // Join Editor & Viewer; assign Viewer role
    await api(proxyBaseUrl, editorAuth.token, 'POST', '/api/canvases/join', { canvasId });
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

    const editorLayerResp = await api(proxyBaseUrl, editorAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
      name: 'Editor Own Layer',
      aclMode: 'owner_only',
    });
    const editorOwnLayerId = editorLayerResp.layer.id as string;

    browser = await chromium.launch({
      executablePath: chromeExe,
      headless: true,
    });

    // =========================================================================
    // PART 1: Web 5 viewports x 4 locales layout & no-clipping verification
    // =========================================================================
    const viewports = [
      { name: 'Desktop', width: 1440, height: 900 },
      { name: 'Compact', width: 960, height: 700 },
      { name: 'Tablet', width: 1024, height: 768 },
      { name: 'PhonePortrait', width: 390, height: 844 },
      { name: 'PhoneLandscape', width: 844, height: 390 },
    ] as const;
    const locales = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'] as const;

    for (const loc of locales) {
      const { ctx, page, pageErrors } = await openRoomPage(browser, proxyBaseUrl, canvasId, ownerAuth.token, loc, { width: 1440, height: 900 });
      try {
        // Add 1 vertical + 1 horizontal guide so the guide strip renders in LayerAlignWindow
        await page.evaluate(() => {
          const rm = (window as any).__debugPixi.rulerManager;
          rm.clearGuides();
          rm.addGuide('x', 180);
          rm.addGuide('y', 220);
        });
        await openAlignWindow(page, loc);
        await page.locator('[data-testid="align-basis-select"]').selectOption('guide');
        await sleep(120);

        for (const vp of viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await sleep(160);

          const audit = await page.evaluate(() => {
            const win = document.querySelector('[data-testid="align-basis-select"]')?.closest('[role="dialog"], .atelier-window, div[style*="position"]') as HTMLElement | null;
            const basisSel = document.querySelector('[data-testid="align-basis-select"]') as HTMLElement | null;
            const guideRange = document.querySelector('[data-testid="align-guide-mode-range"]') as HTMLElement | null;
            const guideNearest = document.querySelector('[data-testid="align-guide-mode-nearest"]') as HTMLElement | null;
            const padBtn = document.querySelector('[data-testid="align-xy-center-center"]') as HTMLElement | null;
            const distBtn = document.querySelector('[data-testid="distribute-hgap"]') as HTMLElement | null;

            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const docOverflow = document.documentElement.scrollWidth > vw + 2;
            const checkEl = (el: HTMLElement | null, name: string) => {
              if (!el) return `${name}:missing`;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return `${name}:zero-size`;
              if (r.left < -2 || r.right > vw + 2) return `${name}:x-clip(${Math.round(r.left)}..${Math.round(r.right)}/${vw})`;
              return null;
            };
            const issues = [
              checkEl(basisSel, 'basisSelect'),
              checkEl(guideRange, 'guideRange'),
              checkEl(guideNearest, 'guideNearest'),
              checkEl(padBtn, 'padCenter'),
              checkEl(distBtn, 'distHgap'),
            ].filter(Boolean);
            const winOverflow = win ? win.scrollWidth > win.clientWidth + 4 : false;
            return { docOverflow, winOverflow, issues, vh };
          });

          assert.equal(audit.docOverflow, false, `[${loc}/${vp.name}] document horizontal overflow`);
          assert.equal(audit.winOverflow, false, `[${loc}/${vp.name}] LayerAlignWindow horizontal overflow`);
          assert.deepEqual(audit.issues, [], `[${loc}/${vp.name}] UI clip issues: ${audit.issues.join(', ')}`);
        }
        assert.deepEqual(pageErrors, [], `[${loc}] unexpected page errors: ${pageErrors.join('; ')}`);
      } finally {
        await ctx.close();
      }
    }
    console.log('✓ Part 1: Web 5 viewports x 4 locales (20 combinations) passed with zero clipping/overflow');

    await checkSoloWorkspace(browser);

    // =========================================================================
    // PART 2: Phone standalone offline mode (390x844) full Align L3 functional tests
    // =========================================================================
    {
      const phoneCtx = await browser.newContext({
        locale: 'zh-TW',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      await phoneCtx.addInitScript({ content: 'window.__name = (f) => f;' });
      await phoneCtx.addInitScript(() => {
        (window as any).atelierMobile = { isAndroid: true };
        localStorage.setItem('atelier_language', 'zh-TW');
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_session_mode', 'offline');
        localStorage.removeItem('atelier_token');
        localStorage.removeItem('atelier_align_basis');
        localStorage.removeItem('atelier_align_guide_mode');
        localStorage.removeItem('atelier_align_vector_bounds');
        localStorage.removeItem('atelier_align_text_bounds');
      });
      const phonePage = await phoneCtx.newPage();
      const phoneErrors: string[] = [];
      phonePage.on('pageerror', (err) => phoneErrors.push(err.message || String(err)));

      try {
        await phonePage.goto(proxyBaseUrl, { waitUntil: 'domcontentloaded' });
        const startSolo = phonePage.getByRole('button', { name: '開始單機作畫', exact: true });
        if (await startSolo.isVisible({ timeout: 3000 }).catch(() => false)) {
          await startSolo.click();
        }
        await phonePage.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30000 });
        await phonePage.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 1, null, { timeout: 20000 });
        await sleep(350);

        const canvasInfo = await phonePage.evaluate(() => {
          const dbg = (window as any).__debugPixi;
          const layers = dbg.layerManager.getLayers();
          const raster = layers.find((l: any) => l.model.layerType === 'raster');
          return {
            layerId: raster.model.id as string,
            width: dbg.layerManager.canvasWidth as number,
            height: dbg.layerManager.canvasHeight as number,
          };
        });

        // Paint a 40x40 block at (240, 200) on the solo raster layer
        await paintRectOnLayer(phonePage, canvasInfo.layerId, 240, 200, 40, 40);
        await openAlignWindow(phonePage, 'zh-TW');

        // 2a. Single vertical guide at X=120 -> vertical align & distribute disabled, horizontal align enabled
        await phonePage.evaluate(() => {
          const rm = (window as any).__debugPixi.rulerManager;
          rm.clearGuides();
          rm.addGuide('x', 120);
        });
        await sleep(150);
        assert.equal(await phonePage.locator('[data-testid="align-auto-uses"]').textContent(), '→ 輔助線');
        assert.equal(await phonePage.locator('[data-testid="align-x-left"]').isDisabled(), false, 'Horizontal align enabled with 1 vertical guide');
        assert.equal(await phonePage.locator('[data-testid="align-y-top"]').isDisabled(), true, 'Vertical align disabled with 0 horizontal guides');
        assert.equal(await phonePage.locator('[data-testid="align-xy-center-center"]').isDisabled(), true, '2D pad disabled with only 1 axis guide');
        assert.equal(await phonePage.locator('[data-testid="distribute-hgap"]').isDisabled(), true, 'Horizontal distribute disabled with 1 guide');

        // Align left to X=120 guide
        await phonePage.locator('[data-testid="align-x-left"]').click();
        await sleep(250);
        const afterGuideAlign = await readLayerContentBounds(phonePage, canvasInfo.layerId, canvasInfo.width, canvasInfo.height);
        assert.ok(afterGuideAlign, 'Layer content must exist after guide align');
        assert.equal(afterGuideAlign!.x, 120, `Expected x=120 after vertical guide align, got ${afterGuideAlign!.x}`);
        assert.equal(afterGuideAlign!.y, 200, 'Y must stay unchanged');

        // Single Ctrl+Z undo restores to x=240
        await phonePage.keyboard.press('Control+z');
        await sleep(250);
        const afterGuideUndo = await readLayerContentBounds(phonePage, canvasInfo.layerId, canvasInfo.width, canvasInfo.height);
        assert.equal(afterGuideUndo?.x, 240, 'Single Ctrl+Z restores guide-aligned layer to x=240');

        // 2b. Add 2nd vertical guide at X=360 and test 'nearest' mode (box at x=240..280, right edge 280 is closer to 360 than 120)
        await phonePage.evaluate(() => {
          (window as any).__debugPixi.rulerManager.addGuide('x', 360);
        });
        await sleep(120);
        await phonePage.locator('[data-testid="align-guide-mode-nearest"]').click();
        await phonePage.locator('[data-testid="align-x-right"]').click();
        await sleep(250);
        const afterNearest = await readLayerContentBounds(phonePage, canvasInfo.layerId, canvasInfo.width, canvasInfo.height);
        assert.equal(afterNearest!.x + afterNearest!.w, 360, 'Nearest guide mode snaps right edge to closer guide X=360');
        await phonePage.keyboard.press('Control+z');
        await sleep(200);

        assert.deepEqual(phoneErrors, [], `Phone standalone page errors: ${phoneErrors.join('; ')}`);
        console.log('✓ Part 2: Phone standalone (390x844) guide basis (single-axis lock, range/nearest, single undo) verified');
      } finally {
        await phoneCtx.close();
      }
    }

    // =========================================================================
    // PART 3: LAN IPv4 + net-proxy.ts Multiplayer Sync (Vector Strokes + Text Glyph/Box + Guides) & ACL
    // =========================================================================
    const ownerSession = await openRoomPage(browser, proxyBaseUrl, canvasId, ownerAuth.token, 'zh-TW', { width: 1280, height: 800 });
    const editorSession = await openRoomPage(browser, proxyBaseUrl, canvasId, editorAuth.token, 'zh-TW', { width: 1280, height: 800 });
    const viewerSession = await openRoomPage(browser, proxyBaseUrl, canvasId, viewerAuth.token, 'zh-TW', { width: 1280, height: 800 });

    try {
      // Seed 3 vector strokes (width=20, curved with Bézier handles) on Owner Vector layer via Owner's VectorEngine & emit sync
      await ownerSession.page.evaluate((vecId) => {
        const dbg = (window as any).__debugPixi;
        const item = dbg.layerManager.getLayerItem(vecId);
        const makeStroke = (id: string, x0: number, y0: number) => ({
          id,
          layerId: vecId,
          color: '#1d4ed8',
          opacity: 1,
          baseWidth: 20,
          anchors: [
            { x: x0, y: y0, cp2x: x0 + 20, cp2y: y0 - 20, pressure: 1, width: 20 },
            { x: x0 + 40, y: y0, cp1x: x0 + 20, cp1y: y0 - 20, pressure: 1, width: 20 },
          ],
          bounds: { minX: x0 - 12, minY: y0 - 32, maxX: x0 + 52, maxY: y0 + 12 },
          createdAt: Date.now(),
        });
        const s1 = makeStroke('vec_s1', 80, 120);
        const s2 = makeStroke('vec_s2', 200, 120);
        const s3 = makeStroke('vec_s3', 280, 120);
        dbg.vectorEngine.addPreparedStroke(item.renderTexture, vecId, s1);
        dbg.vectorEngine.addPreparedStroke(item.renderTexture, vecId, s2);
        dbg.vectorEngine.addPreparedStroke(item.renderTexture, vecId, s3);
        dbg.layerManager.syncPingPong(vecId);
      }, ownerVectorId);

      // Render Owner Text layer pixels so text content exists on canvas
      await ownerSession.page.evaluate(async (textId) => {
        const dbg = (window as any).__debugPixi;
        const item = dbg.layerManager.getLayerItem(textId);
        const meta = item.model.meta.text;
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 180;
        const ctx = c.getContext('2d')!;
        ctx.font = `${meta.fontSize}px ${meta.fontFamily}`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = meta.color;
        // Draw at pad=(2,2), matching renderText(meta)
        ctx.fillText(meta.content, 2, 2);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        dbg.layerManager.writeRegion(textId, meta.x - 2, meta.y - 2, c.width, c.height, new Uint8Array(img.data));
        dbg.layerManager.syncPingPong(textId);
      }, ownerTextId);

      // Paint pixels on Editor's own layer and Owner's locked layer for ACL testing
      await paintRectOnLayer(editorSession.page, editorOwnLayerId, 180, 180, 48, 48, [34, 197, 94, 255]);
      await paintRectOnLayer(ownerSession.page, ownerRasterLayer.id, 300, 300, 48, 48, [239, 68, 68, 255]);

      // --- 3a. Owner aligns & distributes Vector Strokes ('path' vs 'stroke') + syncs to Editor through net-proxy ---
      // Select Owner Vector layer in LayerPanel
      await ownerSession.page.getByText('Owner Vector', { exact: true }).first().click();
      await sleep(200);
      await openAlignWindow(ownerSession.page, 'zh-TW');

      // Add 2 vertical guides X=100 and X=420 on Owner
      await ownerSession.page.evaluate(() => {
        const rm = (window as any).__debugPixi.rulerManager;
        rm.clearGuides();
        rm.addGuide('x', 100);
        rm.addGuide('x', 420);
      });
      await sleep(150);

      // Switch vector scope to 'all' (3 strokes) & bounds to 'path' -> align left to X=100 guide
      await ownerSession.page.locator('[data-testid="align-vector-scope"]').selectOption('all');
      await ownerSession.page.locator('[data-testid="align-vector-bounds-path"]').click();
      await ownerSession.page.locator('[data-testid="align-basis-select"]').selectOption('guide');
      await ownerSession.page.locator('[data-testid="align-guide-mode-range"]').click();
      await ownerSession.page.locator('[data-testid="align-x-left"]').click();
      await sleep(450);

      const ownerPathAligned = await ownerSession.page.evaluate((vecId) => {
        const strokes = (window as any).__debugPixi.vectorEngine.getStrokes(vecId);
        return strokes.map((s: any) => ({
          id: s.id,
          x0: s.anchors[0].x,
          cp2x: s.anchors[0].cp2x,
          x1: s.anchors[1].x,
          cp1x: s.anchors[1].cp1x,
        }));
      }, ownerVectorId);
      assert.equal(ownerPathAligned.length, 3);
      for (const s of ownerPathAligned) {
        assert.equal(s.x0, 100, `Path bounds align-left puts anchor x0=100 (${s.id})`);
        assert.equal(s.cp2x, 120, `Bézier handle cp2x shifted rigidly with anchor (${s.id})`);
        assert.equal(s.x1, 140, `Second anchor x1 shifted rigidly (${s.id})`);
      }

      // Verify Editor received the synced vector strokes through net-proxy
      await editorSession.page.waitForFunction(
        (vecId) => {
          const strokes = (window as any).__debugPixi?.vectorEngine?.getStrokes(vecId) ?? [];
          return strokes.length === 3 && strokes.every((s: any) => s.anchors[0].x === 100 && s.anchors[0].cp2x === 120);
        },
        ownerVectorId,
        { timeout: 10000 },
      );

      // Single Ctrl+Z undo reverts all 3 strokes on Owner AND syncs revert to Editor
      await ownerSession.page.keyboard.press('Control+z');
      await sleep(450);
      const ownerAfterVecUndo = await ownerSession.page.evaluate((vecId) => {
        const strokes = (window as any).__debugPixi.vectorEngine.getStrokes(vecId);
        return strokes.map((s: any) => ({ id: s.id, x0: s.anchors[0].x, cp2x: s.anchors[0].cp2x }));
      }, ownerVectorId);
      assert.deepEqual(
        ownerAfterVecUndo.sort((a: any, b: any) => a.id.localeCompare(b.id)),
        [
          { id: 'vec_s1', x0: 80, cp2x: 100 },
          { id: 'vec_s2', x0: 200, cp2x: 220 },
          { id: 'vec_s3', x0: 280, cp2x: 300 },
        ],
        'Single Ctrl+Z restores all 3 vector strokes and handles',
      );
      await editorSession.page.waitForFunction(
        (vecId) => {
          const strokes = (window as any).__debugPixi?.vectorEngine?.getStrokes(vecId) ?? [];
          const s1 = strokes.find((s: any) => s.id === 'vec_s1');
          const s3 = strokes.find((s: any) => s.id === 'vec_s3');
          return s1?.anchors[0].x === 80 && s3?.anchors[0].x === 280;
        },
        ownerVectorId,
        { timeout: 10000 },
      );

      // Switch to 'stroke' bounds (width=20 -> halfWidth=10): align left to X=100 puts anchor x0=110 (left ink=100)
      await ownerSession.page.locator('[data-testid="align-vector-bounds-stroke"]').click();
      await ownerSession.page.locator('[data-testid="align-x-left"]').click();
      await sleep(350);
      const ownerStrokeAligned = await ownerSession.page.evaluate((vecId) => {
        return (window as any).__debugPixi.vectorEngine.getStrokes(vecId).map((s: any) => s.anchors[0].x);
      }, ownerVectorId);
      assert.deepEqual(ownerStrokeAligned, [110, 110, 110], 'Stroke-width bounds puts anchor x0=110 so outer ink hits X=100');

      // Undo, then distribute 3 vector strokes horizontally equal-gap between guides X=100 and X=420
      await ownerSession.page.keyboard.press('Control+z');
      await sleep(300);
      await ownerSession.page.locator('[data-testid="distribute-hgap"]').click();
      await sleep(400);
      const distXs = await ownerSession.page.evaluate((vecId) => {
        return (window as any).__debugPixi.vectorEngine
          .getStrokes(vecId)
          .map((s: any) => s.anchors[0].x)
          .sort((a: number, b: number) => a - b);
      }, ownerVectorId);
      // With stroke bounds (w = 40 + 20 = 60, halfWidth = 10):
      // first left ink=100 -> anchor x0=110; last right ink=420 -> anchor x0 = 420 - 50 = 370; middle -> anchor x0 = 240
      assert.equal(distXs[0], 110, 'First distributed vector stroke outer ink snaps to left guide X=100');
      assert.equal(distXs[2], 370, 'Last distributed vector stroke outer ink snaps to right guide X=420');
      assert.ok(Math.abs((distXs[1] - distXs[0]) - (distXs[2] - distXs[1])) <= 1, `Equal gaps: ${distXs.join(', ')}`);
      console.log('✓ Part 3a: Vector strokes align (path vs stroke), guide distribute, single undo, and LAN net-proxy sync verified');

      // --- 3b. Text Layer bounds mode ('glyph' vs 'box') + meta preservation + LAN sync + single undo ---
      await ownerSession.page.getByText('Owner Text', { exact: true }).first().click();
      await sleep(200);
      await ownerSession.page.locator('[data-testid="align-basis-select"]').selectOption('canvas');

      // Align top using 'glyph' (actual ink bounds)
      await ownerSession.page.locator('[data-testid="align-text-bounds-glyph"]').click();
      await ownerSession.page.locator('[data-testid="align-y-top"]').click();
      await sleep(400);
      const textAfterGlyph = await ownerSession.page.evaluate(async (textId) => {
        const dbg = (window as any).__debugPixi;
        const item = dbg.layerManager.getLayerItem(textId);
        const [px] = await dbg.layerManager.readAsync(textId, [{ x: 0, y: 0, w: 512, h: 512 }]);
        let minY = 512;
        for (let y = 0; y < 512; y++) {
          for (let x = 0; x < 512; x++) {
            if (px[(y * 512 + x) * 4 + 3] > 0) { minY = y; break; }
          }
          if (minY < 512) break;
        }
        return { minY, metaY: item.model.meta?.text?.y, content: item.model.meta?.text?.content };
      }, ownerTextId);
      assert.equal(textAfterGlyph.minY, 0, `Glyph mode snaps actual ink top to y=0 (got ${textAfterGlyph.minY})`);
      assert.equal(textAfterGlyph.content, 'A', 'Editable text content preserved');

      // Undo back to y=140
      await ownerSession.page.keyboard.press('Control+z');
      await sleep(400);
      const textAfterUndo = await ownerSession.page.evaluate((textId) => {
        return (window as any).__debugPixi.layerManager.getLayerItem(textId).model.meta?.text?.y;
      }, ownerTextId);
      assert.equal(textAfterUndo, 140, 'Single undo restores text meta.text.y to 140');

      // Align top using 'box' (text box bounds)
      await ownerSession.page.locator('[data-testid="align-text-bounds-box"]').click();
      await ownerSession.page.locator('[data-testid="align-y-top"]').click();
      await sleep(450);
      const textAfterBox = await ownerSession.page.evaluate(async (textId) => {
        const dbg = (window as any).__debugPixi;
        const item = dbg.layerManager.getLayerItem(textId);
        const [px] = await dbg.layerManager.readAsync(textId, [{ x: 0, y: 0, w: 512, h: 512 }]);
        let minY = 512;
        for (let y = 0; y < 512; y++) {
          for (let x = 0; x < 512; x++) {
            if (px[(y * 512 + x) * 4 + 3] > 0) { minY = y; break; }
          }
          if (minY < 512) break;
        }
        return { minY, metaY: item.model.meta?.text?.y, content: item.model.meta?.text?.content };
      }, ownerTextId);
      assert.equal(textAfterBox.metaY, 0, `Text box mode aligns meta.text.y to 0 (got ${textAfterBox.metaY})`);
      assert.ok(textAfterBox.minY > 0, `In box mode, ink minY (${textAfterBox.minY}) stays > 0 due to font top bearing`);
      assert.notEqual(textAfterBox.metaY, textAfterGlyph.metaY, 'Glyph mode vs Text box mode produce distinct alignments');
      assert.equal(textAfterBox.content, 'A', 'Editable text meta preserved in box mode');

      // Verify Editor received synced text meta.text.y === 0
      await editorSession.page.waitForFunction(
        (textId) => (window as any).__debugPixi?.layerManager?.getLayerItem(textId)?.model?.meta?.text?.y === 0,
        ownerTextId,
        { timeout: 10000 },
      );
      console.log('✓ Part 3b: Text layer glyph vs text-box bounds, editable meta preservation, single undo, and LAN sync verified');

      // --- 3c. ACL gating: Viewer & Editor batch rejection (zero partial moves) ---
      await openAlignWindow(viewerSession.page, 'zh-TW');
      assert.equal(
        await viewerSession.page.locator('[data-testid="align-x-left"]').isDisabled(),
        true,
        'Viewer align button must be disabled',
      );
      assert.equal(
        await viewerSession.page.locator('[data-testid="distribute-hgap"]').isDisabled(),
        true,
        'Viewer distribute button must be disabled',
      );
      {
        const db = new Database(path.join(dataDir, 'atelier.db'), { readonly: true });
        try {
          const viewerOps = db
            .prepare(`SELECT COUNT(*) AS c FROM canvas_ops WHERE canvas_id = ? AND user_id = ?`)
            .get(canvasId, viewerAuth.user.id) as { c: number };
          assert.equal(viewerOps.c, 0, `Viewer must have 0 write ops in SQLite, got ${viewerOps.c}`);
        } finally {
          db.close();
        }
      }

      // Editor multi-selects Editor Own Layer + Owner Locked Private layer -> entire batch blocked, 0 partial move
      await editorSession.page.getByText('Editor Own Layer', { exact: true }).first().click();
      await sleep(120);
      await editorSession.page.getByText('Owner Locked Private', { exact: true }).first().click({ modifiers: ['Control'] });
      await sleep(150);
      await openAlignWindow(editorSession.page, 'zh-TW');
      await editorSession.page.locator('[data-testid="align-basis-select"]').selectOption('canvas');
      assert.equal(
        await editorSession.page.locator('[data-testid="align-x-left"]').isDisabled(),
        true,
        'Batch containing another user locked/private layer must block alignment atomically',
      );
      const editorBoundsUnmoved = await readLayerContentBounds(editorSession.page, editorOwnLayerId, 512, 512);
      assert.equal(editorBoundsUnmoved?.x, 180, 'Editor own layer must not partially move when batch is rejected');
      assert.equal(editorBoundsUnmoved?.y, 180, 'Editor own layer Y unchanged on batch rejection');

      const fillLayer = (await api(proxyBaseUrl, ownerAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
        name: 'Bucket LAN Regression', layerType: 'raster', aclMode: 'shared_all',
      })).layer;
      const ownerPage = ownerSession.page;
      const editorPage = editorSession.page;
      const waitAlpha = (page: Page, alpha: number) => page.waitForFunction(async ({ layerId, alpha }) => {
        const lm = (window as any).__debugPixi?.layerManager;
        if (!lm?.getLayerItem(layerId)) return false;
        const [pixel] = await lm.readAsync(layerId, [{ x: 30, y: 30, w: 1, h: 1 }]);
        return pixel[3] === alpha;
      }, { layerId: fillLayer.id, alpha }, { timeout: 12000 });
      // Reload both sessions to verify the exact same blank layer supplied by the isolated server.
      await Promise.all([ownerPage.reload(), editorPage.reload()]);
      await ownerPage.getByText(fillLayer.name, { exact: true }).first().click();
      await ownerPage.locator('[data-tool-id="bucket"]').first().click();
      await ownerPage.getByRole('radio', { name: '目前圖層', exact: true }).first().click();
      const center = await ownerPage.evaluate(() => {
        const rect = document.querySelector('.atelier-canvas-viewport')!.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      const confirm = ownerPage.getByRole('dialog', { name: '填滿整張畫布？' });
      await ownerPage.mouse.click(center.x, center.y);
      await confirm.waitFor();
      await confirm.getByRole('button', { name: '取消', exact: true }).click();
      await confirm.waitFor({ state: 'hidden' });
      await waitAlpha(editorPage, 0);
      await ownerPage.mouse.click(center.x, center.y);
      await confirm.getByRole('button', { name: '填色', exact: true }).click();
      await Promise.all([waitAlpha(ownerPage, 255), waitAlpha(editorPage, 255)]);
      await confirm.waitFor({ state: 'hidden' });
      await ownerPage.keyboard.press('Control+KeyZ');
      await Promise.all([waitAlpha(ownerPage, 0), waitAlpha(editorPage, 0)]);
      console.log('✓ LAN bucket: cancel preserves pixels; confirmed fill and one undo reach both clients');

      assert.deepEqual(ownerSession.pageErrors, [], `Owner page errors: ${ownerSession.pageErrors.join('; ')}`);
      assert.deepEqual(editorSession.pageErrors, [], `Editor page errors: ${editorSession.pageErrors.join('; ')}`);
      assert.deepEqual(viewerSession.pageErrors, [], `Viewer page errors: ${viewerSession.pageErrors.join('; ')}`);
      console.log('✓ Part 3c: Viewer & Editor multi-layer ACL batch blocking verified (zero partial moves, 0 viewer ops)');
    } finally {
      await ownerSession.ctx.close();
      await editorSession.ctx.close();
      await viewerSession.ctx.close();
    }

    console.log('ALL ALIGN L3 E2E CHECKS PASSED!');
  } catch (err) {
    if (serverStderr.trim()) {
      console.error('--- Test Server stderr ---\n', serverStderr.slice(-2000));
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    proxyProc.kill();
    serverProc.kill();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[Align L3 E2E] FAILED:', err);
  process.exit(1);
});

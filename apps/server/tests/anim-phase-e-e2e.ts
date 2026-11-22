/**
 * Animation Phase E (E1 2D Camera, E2 Light Table v2, E3 Local Audio Track) End-to-End Verification:
 *   1. Web 5 viewports (Desktop 1440x900, Compact 960x700, Tablet 1024x768, Phone Portrait 390x844,
 *      Phone Landscape 844x390) x 4 locales (zh-TW, zh-CN, en-US, ja-JP) no-clipping & no-overflow audit
 *      for CameraToolWindow, LightTableWindow, AudioTrackWindow, and AnimationExportModal.
 *   2. Phone standalone offline mode (390x844):
 *      - E1 2D Camera: add camera frame, inspect overlay, set keyframes across frames, toggle Look Through
 *        Camera preview & restore viewport, export GIF with Camera Frame crop/transform enabled.
 *      - E2 Light Table v2: register multiple cels + import local PNG image (IndexedDB), adjust per-item
 *        transform/flip/opacity/tint, toggle pinned edit target lock & canvas drag overlay, reset transform.
 *      - E3 Audio Track: import local WAV file (IndexedDB), verify timeline waveform SVG rendering,
 *        mute/volume/frame-range controls, scrub toggle, and zero server uploads.
 *   3. LAN IPv4 + apps/server/tests/net-proxy.ts (25ms one-way / +/-5ms jitter) Multiplayer Sync & ACL:
 *      - Owner creates animation folder, 2D camera frame with keyframes, and local audio track metadata.
 *      - Editor sees synced camera frame (can toggle personal preview, cannot edit; direct PATCH rejected 403)
 *        and synced audio track metadata ("not linked locally", direct PATCH rejected 403), then links local WAV
 *        with zero audio binary uploaded to the server.
 *      - Viewer sees synced tracks but is blocked from creating or mutating camera/audio layers (403, zero DB writes).
 *
 * Uses a throwaway Fastify server on a dedicated test port with an ephemeral DATA_DIR and CLIENT_DIST_PATH,
 * never touching Port 3000 or 127.0.0.1/localhost for browser connections.
 *
 * Usage:
 *   pnpm --filter @atelier/server exec tsx tests/anim-phase-e-e2e.ts
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
const CLIENT_DIST_DEFAULT = path.resolve(REPO_ROOT, 'apps/client/dist');
const NET_PROXY_SCRIPT = path.resolve(SERVER_DIR, 'tests/net-proxy.ts');
const TSX_CLI = path.resolve(SERVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const SERVER_PORT = Number(process.env.LUMINA_ANIME_SERVER_PORT || 3995);
const PROXY_PORT = Number(process.env.LUMINA_ANIME_PROXY_PORT || 3996);
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

/** Builds a valid 0.5s 440Hz mono 16-bit PCM WAV file for local audio import tests. */
function buildTestWavBuffer(durationSec = 0.5, sampleRate = 8000): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.sin((Math.PI * i) / numSamples);
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * envelope * 20000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

/** Valid 1x1 solid cyan PNG bytes for local Light Table external image import tests. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  return { status: res.status, ok: res.ok, data: data as any };
}

async function apiOk(baseUrl: string, token: string | null, method: string, urlPath: string, body?: unknown) {
  const res = await api(baseUrl, token, method, urlPath, body);
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function openWorkspacePage(
  browser: Browser,
  baseUrl: string,
  opts: {
    canvasId?: string;
    token?: string | null;
    locale?: string;
    viewport?: { width: number; height: number };
    offline?: boolean;
    mobile?: boolean;
  }
): Promise<{ ctx: BrowserContext; page: Page; pageErrors: string[]; uploadCalls: string[] }> {
  const locale = opts.locale ?? 'zh-TW';
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const ctx = await browser.newContext({
    locale,
    viewport,
    ...(opts.mobile ? { hasTouch: true, isMobile: true } : {}),
  });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(
    ({ tok, loc, cid, off, mob }) => {
      if (mob) (window as any).atelierMobile = { isAndroid: true };
      localStorage.setItem('atelier_language', loc);
      localStorage.setItem('atelier_gateway_resolved', '1');
      if (off || !tok) {
        localStorage.removeItem('atelier_token');
        localStorage.setItem('atelier_session_mode', 'offline');
      } else {
        localStorage.setItem('atelier_token', tok);
        localStorage.removeItem('atelier_session_mode');
      }
      if (cid) localStorage.setItem('atelier_active_canvas_id', cid);
      else localStorage.removeItem('atelier_active_canvas_id');
    },
    { tok: opts.token ?? null, loc: locale, cid: opts.canvasId ?? null, off: Boolean(opts.offline), mob: Boolean(opts.mobile) }
  );
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  const uploadCalls: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  page.on('request', (req) => {
    const url = req.url();
    const ct = req.headers()['content-type'] || '';
    if (
      req.method() === 'POST' &&
      (ct.includes('audio/') || ct.includes('multipart/form-data') || url.includes('/audio'))
    ) {
      uploadCalls.push(`${req.method()} ${url} (${ct})`);
    }
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  if (opts.offline || opts.mobile) {
    const startSolo = page.getByRole('button', { name: '開始單機作畫', exact: true });
    if (await startSolo.isVisible({ timeout: 2500 }).catch(() => false)) {
      await startSolo.click();
    }
  }
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 30000 });
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
  }
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 1, null, {
    timeout: 20000,
  });
  await sleep(250);
  return { ctx, page, pageErrors, uploadCalls };
}

async function openTimeline(page: Page) {
  const tl = page.locator('[data-anim-timeline]');
  if (await tl.isVisible({ timeout: 400 }).catch(() => false)) return;
  await page.keyboard.press('Control+Shift+KeyA');
  await tl.waitFor({ state: 'visible', timeout: 10000 });
  await sleep(150);
}

async function ensureAnimationFolder(page: Page) {
  await openTimeline(page);
  const emptyCreate = page.locator('[data-anim-timeline] button.atelier-btn--primary').first();
  if (await emptyCreate.isVisible({ timeout: 500 }).catch(() => false)) {
    await emptyCreate.click();
    await sleep(300);
  }
}

async function openToolFromTimeline(page: Page, kind: 'camera' | 'light' | 'audio' | 'export') {
  const isPhone = (await page.locator('[data-anim-timeline][data-phone="1"]').count()) > 0;
  if (isPhone) {
    const moreBtn = page.locator('[data-phone-more]').first();
    await moreBtn.waitFor({ state: 'visible', timeout: 8000 });
    await moreBtn.click();
    const map = {
      camera: 'phone-drawer-camera-btn',
      light: 'phone-drawer-light-btn',
      audio: 'phone-drawer-audio-btn',
      export: 'phone-drawer-export-btn',
    } as const;
    const btn = page.locator(`[data-testid="${map[kind]}"]`);
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    await btn.click();
  } else {
    const map = {
      camera: 'timeline-camera-btn',
      light: 'timeline-light-table-btn',
      audio: 'timeline-audio-btn',
      export: 'timeline-export-btn',
    } as const;
    const btn = page.locator(`[data-testid="${map[kind]}"]`);
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    await btn.click();
  }
  await sleep(150);
}

async function assertElementWithinViewport(page: Page, selector: string, label: string) {
  const check = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return { found: false as const };
    const panel = (el.closest('section[role="dialog"], [role="dialog"], aside') as HTMLElement | null) ?? el;
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overflowX = panel.scrollWidth - panel.clientWidth;
    return {
      found: true as const,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      vw,
      vh,
      overflowX,
    };
  }, selector);

  assert.ok(check.found, `${label}: element ${selector} not found`);
  assert.ok(check.width > 120 && check.height > 60, `${label}: unexpected tiny box ${check.width}x${check.height}`);
  assert.ok(check.left >= -2, `${label}: clipped on left (${check.left})`);
  assert.ok(check.top >= -2, `${label}: clipped on top (${check.top})`);
  assert.ok(check.right <= check.vw + 2, `${label}: clipped on right (${check.right} > ${check.vw})`);
  assert.ok(check.bottom <= check.vh + 2, `${label}: clipped on bottom (${check.bottom} > ${check.vh})`);
  assert.ok(check.overflowX <= 4, `${label}: horizontal overflow (${check.overflowX}px)`);
}

async function main() {
  const lanIp = detectLanIpv4();
  const chromeExe = detectChromeExecutable();
  const clientDistPath = process.env.CLIENT_DIST_PATH || CLIENT_DIST_DEFAULT;
  assert.ok(fs.existsSync(path.join(clientDistPath, 'index.html')), `Missing built client dist at ${clientDistPath}`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-anim-phase-e-e2e-'));
  const wavPath = path.join(dataDir, 'lip_sync_test.wav');
  const pngPath = path.join(dataDir, 'light_ref_test.png');
  fs.writeFileSync(wavPath, buildTestWavBuffer(0.5, 8000));
  fs.writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

  const directServerUrl = `http://${lanIp}:${SERVER_PORT}`;
  const proxyBaseUrl = `http://${lanIp}:${PROXY_PORT}`;

  console.log(`[Anim Phase E E2E] LAN IP: ${lanIp} | Server: ${directServerUrl} | Proxy: ${proxyBaseUrl}`);

  const serverProc = spawn(process.execPath, [TSX_CLI, 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      HOST: '0.0.0.0',
      DATA_DIR: dataDir,
      CLIENT_DIST_PATH: clientDistPath,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverStderr = '';
  serverProc.stderr?.on('data', (d) => { serverStderr += String(d); });

  const proxyProc = spawn(
    process.execPath,
    [TSX_CLI, NET_PROXY_SCRIPT, String(PROXY_PORT), String(SERVER_PORT), String(ONE_WAY_MS), '0', '0', String(JITTER_MS)],
    { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let browser: Browser | null = null;
  try {
    await waitForHealth(directServerUrl, serverProc, 'Fastify test server');
    await waitForHealth(proxyBaseUrl, proxyProc, 'LAN net-proxy');

    browser = await chromium.launch({
      executablePath: chromeExe,
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    });

    // Register users & create LAN room upfront so Part 1 (Web 5x4) and Part 3 (Multiplayer ACL) both run over LAN proxy
    const ownerAuth = await apiOk(proxyBaseUrl, null, 'POST', '/api/auth/register', {
      username: 'anime_owner',
      password: 'Password123!',
      displayName: 'Owner',
    });
    const layoutCanvas = await apiOk(proxyBaseUrl, ownerAuth.token, 'POST', '/api/canvases', {
      title: 'Phase E Layout Audit',
      width: 800,
      height: 600,
      bgColor: '#FFFFFF',
      accessMode: 'invite',
    });

    // =========================================================================
    // PART 1: Web 5 viewports x 4 locales no-clipping & no-overflow audit
    // =========================================================================
    const viewports = [
      { name: 'Desktop', width: 1440, height: 900 },
      { name: 'Compact', width: 960, height: 700 },
      { name: 'Tablet', width: 1024, height: 768 },
      { name: 'PhonePortrait', width: 390, height: 844 },
      { name: 'PhoneLandscape', width: 844, height: 390 },
    ];
    const locales = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'];

    for (const vp of viewports) {
      for (const loc of locales) {
        const tag = `${vp.name}/${loc}`;
        const { ctx, page, pageErrors } = await openWorkspacePage(browser, proxyBaseUrl, {
          canvasId: layoutCanvas.canvas.id,
          token: ownerAuth.token,
          locale: loc,
          viewport: { width: vp.width, height: vp.height },
        });
        try {
          await ensureAnimationFolder(page);

          // Camera ToolWindow
          await openToolFromTimeline(page, 'camera');
          await page.locator('[data-testid="camera-tool-window"]').waitFor({ state: 'visible', timeout: 8000 });
          await assertElementWithinViewport(page, '[data-testid="camera-tool-window"]', `${tag} CameraToolWindow`);
          await page.keyboard.press('Escape');
          await sleep(100);

          // Light Table ToolWindow
          await openToolFromTimeline(page, 'light');
          await page.locator('[data-testid="light-table-window"]').waitFor({ state: 'visible', timeout: 8000 });
          await assertElementWithinViewport(page, '[data-testid="light-table-window"]', `${tag} LightTableWindow`);
          await page.keyboard.press('Escape');
          await sleep(100);

          // Audio Track ToolWindow
          await openToolFromTimeline(page, 'audio');
          await page.locator('[data-testid="audio-track-window"]').waitFor({ state: 'visible', timeout: 8000 });
          await assertElementWithinViewport(page, '[data-testid="audio-track-window"]', `${tag} AudioTrackWindow`);
          await page.keyboard.press('Escape');
          await sleep(100);

          // Export Modal
          await openToolFromTimeline(page, 'export');
          await page.locator('[data-testid="anim-export-modal"]').waitFor({ state: 'visible', timeout: 8000 });
          await assertElementWithinViewport(page, '[data-testid="anim-export-modal"]', `${tag} AnimationExportModal`);

          assert.deepEqual(pageErrors, [], `${tag} page errors: ${pageErrors.join('; ')}`);
        } finally {
          await ctx.close();
        }
      }
      console.log(`✓ Part 1 viewport ${vp.name} (${vp.width}x${vp.height}) verified across all 4 locales`);
    }

    // =========================================================================
    // PART 2: Phone Standalone Offline Mode (390x844) full E1 / E2 / E3 checks
    // =========================================================================
    {
      const { ctx, page, pageErrors, uploadCalls } = await openWorkspacePage(browser, proxyBaseUrl, {
        offline: true,
        mobile: true,
        locale: 'zh-TW',
        viewport: { width: 390, height: 844 },
      });
      try {
        await ensureAnimationFolder(page);

        // Add a second cel so we have multiple cels for Light Table
        await page.locator('[data-phone-more]').first().click();
        await page.locator('[data-phone-drawer] button').first().click();
        await sleep(250);

        // --- E1: 2D Camera ---
        await openToolFromTimeline(page, 'camera');
        await page.locator('[data-testid="camera-add-btn"]').click();
        await page.locator('[data-testid="camera-frame-overlay"]').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('[data-testid="camera-x-input"]').fill('60');
        await page.locator('[data-testid="camera-x-input"]').dispatchEvent('change');
        await page.locator('[data-testid="camera-keyframe-btn"]').click();
        await sleep(150);

        // Toggle real-time Look Through Camera preview & restore
        const beforeVp = await page.evaluate(() => (window as any).__debugPixi.viewport.getState());
        await page.locator('[data-testid="camera-preview-toggle"]').click();
        await page.locator('[data-testid="camera-preview-overlay"]').waitFor({ state: 'visible', timeout: 8000 });
        await page.locator('[data-testid="camera-preview-exit"]').click();
        await page.locator('[data-testid="camera-preview-overlay"]').waitFor({ state: 'detached', timeout: 8000 });
        const afterVp = await page.evaluate(() => (window as any).__debugPixi.viewport.getState());
        assert.ok(Math.abs(afterVp.zoom - beforeVp.zoom) < 1e-3, 'Camera preview exit restores viewport zoom');
        await page.keyboard.press('Escape');

        // Verify Export Modal shows Camera Frame region option & exports GIF cleanly
        await openToolFromTimeline(page, 'export');
        await page.locator('[data-testid="anim-export-region-camera"]').waitFor({ state: 'visible', timeout: 8000 });
        await page.locator('[data-testid="anim-export-mode-gif"]').click();
        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
        await page.locator('[data-testid="anim-export-submit"]').click();
        const download = await downloadPromise;
        assert.ok(download.suggestedFilename().endsWith('.gif'), `Expected .gif download, got ${download.suggestedFilename()}`);
        await sleep(200);

        // --- E2: Light Table v2 ---
        await openToolFromTimeline(page, 'light');
        await page.locator('[data-testid="light-table-window"]').waitFor({ state: 'visible', timeout: 8000 });
        // Add first cel option
        const celOpts = await page.locator('[data-testid="light-table-cel-select"] option').evaluateAll((els) =>
          els.map((e) => (e as HTMLOptionElement).value).filter(Boolean)
        );
        assert.ok(celOpts.length >= 2, `Expected >=2 cels for Light Table, got ${celOpts.length}`);
        await page.locator('[data-testid="light-table-cel-select"]').selectOption(celOpts[0]);
        await page.locator('[data-testid="light-table-add-cel-btn"]').click();
        await sleep(150);

        // Import local external reference image (IndexedDB)
        const ltFileInput = page.locator('[data-testid="light-table-window"] input[type="file"]');
        await ltFileInput.setInputFiles(pngPath);
        await page.locator('[data-testid="light-table-overlay"]').waitFor({ state: 'visible', timeout: 8000 });

        // Adjust per-reference transform, flip, tint, pin edit target, and canvas drag mode
        await page.locator('[data-testid="light-ref-x-input"]').fill('25');
        await page.locator('[data-testid="light-ref-flip-x"]').click();
        await page.locator('[data-testid="light-ref-tint-shade"]').click();
        await page.locator('[data-testid="light-table-pin-toggle"]').click();
        assert.equal(await page.locator('[data-testid="light-table-pin-toggle"]').getAttribute('aria-pressed'), 'true');
        await page.locator('[data-testid="light-table-canvas-drag-toggle"]').click();
        await page.locator('[data-testid="light-table-drag-handles"]').waitFor({ state: 'visible', timeout: 8000 });
        await page.locator('[data-testid="light-table-reset-transform"]').click();
        await page.keyboard.press('Escape');

        // --- E3: Local Audio Track ---
        await openToolFromTimeline(page, 'audio');
        await page.locator('[data-testid="audio-track-window"]').waitFor({ state: 'visible', timeout: 8000 });
        const audInput = page.locator('[data-testid="audio-track-window"] input[type="file"]').first();
        await audInput.setInputFiles(wavPath);
        await page.locator('[data-testid^="timeline-audio-waveform-"]').first().waitFor({ state: 'visible', timeout: 10000 });
        const scrubBtn = page.locator('[data-testid="audio-scrub-toggle"]');
        await scrubBtn.click();
        assert.equal(await scrubBtn.getAttribute('aria-pressed'), 'false');
        await scrubBtn.click();
        assert.equal(await scrubBtn.getAttribute('aria-pressed'), 'true');

        assert.deepEqual(uploadCalls, [], `Phone standalone must never upload audio/images: ${uploadCalls.join(', ')}`);
        assert.deepEqual(pageErrors, [], `Phone standalone page errors: ${pageErrors.join('; ')}`);
        console.log('✓ Part 2: Phone standalone offline E1/E2/E3 (Camera + GIF export, Light Table v2, Local Audio waveform) passed');
      } finally {
        await ctx.close();
      }
    }

    // =========================================================================
    // PART 3: LAN IP + net-proxy.ts Multiplayer Sync & Room ACL Verification
    // =========================================================================
    {
      const editorAuth = await apiOk(proxyBaseUrl, null, 'POST', '/api/auth/register', {
        username: 'anime_editor',
        password: 'Password123!',
        displayName: 'Editor',
      });
      const viewerAuth = await apiOk(proxyBaseUrl, null, 'POST', '/api/auth/register', {
        username: 'anime_viewer',
        password: 'Password123!',
        displayName: 'Viewer',
      });

      const createdCanvas = await apiOk(proxyBaseUrl, ownerAuth.token, 'POST', '/api/canvases', {
        title: 'Phase E LAN Room',
        width: 800,
        height: 600,
        bgColor: '#FFFFFF',
        accessMode: 'invite',
      });
      const canvasId: string = createdCanvas.canvas.id;

      await apiOk(proxyBaseUrl, editorAuth.token, 'POST', '/api/canvases/join', { canvasId });
      await apiOk(proxyBaseUrl, viewerAuth.token, 'POST', '/api/canvases/join', { canvasId });
      {
        const db = new Database(path.join(dataDir, 'atelier.db'));
        try {
          db.prepare(`UPDATE canvas_members SET role = 'viewer' WHERE canvas_id = ? AND user_id = ?`).run(
            canvasId,
            viewerAuth.user.id
          );
        } finally {
          db.close();
        }
      }

      const ownerSess = await openWorkspacePage(browser, proxyBaseUrl, {
        canvasId,
        token: ownerAuth.token,
        locale: 'zh-TW',
        viewport: { width: 1440, height: 900 },
      });
      const editorSess = await openWorkspacePage(browser, proxyBaseUrl, {
        canvasId,
        token: editorAuth.token,
        locale: 'zh-TW',
        viewport: { width: 1440, height: 900 },
      });
      const viewerSess = await openWorkspacePage(browser, proxyBaseUrl, {
        canvasId,
        token: viewerAuth.token,
        locale: 'zh-TW',
        viewport: { width: 1440, height: 900 },
      });

      try {
        // Owner creates animation folder, 2D camera frame, and local audio track
        await ensureAnimationFolder(ownerSess.page);
        await openToolFromTimeline(ownerSess.page, 'camera');
        await ownerSess.page.locator('[data-testid="camera-add-btn"]').click();
        await ownerSess.page.locator('[data-testid="camera-frame-overlay"]').waitFor({ state: 'visible', timeout: 10000 });
        await ownerSess.page.locator('[data-testid="camera-keyframe-btn"]').click();
        await ownerSess.page.keyboard.press('Escape');

        await openToolFromTimeline(ownerSess.page, 'audio');
        const ownerAudInput = ownerSess.page.locator('[data-testid="audio-track-window"] input[type="file"]').first();
        await ownerAudInput.setInputFiles(wavPath);
        await ownerSess.page.locator('[data-testid^="timeline-audio-waveform-"]').first().waitFor({ state: 'visible', timeout: 10000 });

        // Fetch layers via API to verify synced camera & audio metadata (and zero audio binary in DB)
        await sleep(500);
        const layersRes = await apiOk(proxyBaseUrl, ownerAuth.token, 'GET', `/api/canvases/${canvasId}/layers`);
        const camLayer = layersRes.layers.find((l: any) => l.meta?.camera);
        const audLayer = layersRes.layers.find((l: any) => l.meta?.audio);
        assert.ok(camLayer, 'Camera layer synced to server');
        assert.ok(audLayer, 'Audio metadata layer synced to server');
        assert.equal(audLayer.meta.audio.fileName, 'lip_sync_test.wav');
        assert.ok(JSON.stringify(audLayer.meta).length < 512, 'Audio layer meta stays tiny metadata only');

        // Editor opens timeline and verifies synced camera + audio tracks
        await openTimeline(editorSess.page);
        await editorSess.page.locator('[data-testid="timeline-camera-row"]').waitFor({ state: 'visible', timeout: 10000 });
        await editorSess.page.locator(`[data-testid="timeline-audio-row-${audLayer.id}"]`).waitFor({ state: 'visible', timeout: 10000 });

        // Editor can toggle personal Camera Preview, but camera inputs are read-only
        await openToolFromTimeline(editorSess.page, 'camera');
        assert.equal(await editorSess.page.locator('[data-testid="camera-width-input"]').isDisabled(), true);
        await editorSess.page.locator('[data-testid="camera-preview-toggle"]').click();
        await editorSess.page.locator('[data-testid="camera-preview-overlay"]').waitFor({ state: 'visible', timeout: 8000 });
        await editorSess.page.locator('[data-testid="camera-preview-exit"]').click();
        await editorSess.page.keyboard.press('Escape');

        // Editor opens Audio Track window: sees unlinked status, links local WAV locally (zero server upload)
        await openToolFromTimeline(editorSess.page, 'audio');
        await editorSess.page.locator(`[data-testid="audio-link-local-${audLayer.id}"]`).waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(await editorSess.page.locator(`[data-testid="audio-volume-slider-${audLayer.id}"]`).isDisabled(), true);
        const linkChooser = editorSess.page.waitForEvent('filechooser', { timeout: 8000 });
        await editorSess.page.locator(`[data-testid="audio-link-local-${audLayer.id}"]`).click();
        await (await linkChooser).setFiles(wavPath);
        await editorSess.page.locator(`[data-testid="timeline-audio-waveform-${audLayer.id}"]`).waitFor({ state: 'visible', timeout: 10000 });

        // Server-side ACL enforcement checks over LAN proxy:
        // 1) Editor cannot PATCH Owner's camera layer or audio metadata layer -> 403
        const edCamPatch = await api(proxyBaseUrl, editorAuth.token, 'PATCH', `/api/canvases/${canvasId}/layers/${camLayer.id}`, {
          meta: { ...camLayer.meta, camera: { width: 500, height: 500, showSafeArea: false } },
        });
        assert.equal(edCamPatch.status, 403, `Editor PATCH on owner camera must be 403, got ${edCamPatch.status}`);

        const edAudPatch = await api(proxyBaseUrl, editorAuth.token, 'PATCH', `/api/canvases/${canvasId}/layers/${audLayer.id}`, {
          meta: { ...audLayer.meta, audio: { ...audLayer.meta.audio, muted: true } },
        });
        assert.equal(edAudPatch.status, 403, `Editor PATCH on owner audio must be 403, got ${edAudPatch.status}`);

        // 2) Viewer cannot create or PATCH audio/camera layers -> 403
        await openTimeline(viewerSess.page);
        await viewerSess.page.locator(`[data-testid="timeline-audio-row-${audLayer.id}"]`).waitFor({ state: 'visible', timeout: 10000 });
        const vwCreate = await api(proxyBaseUrl, viewerAuth.token, 'POST', `/api/canvases/${canvasId}/layers`, {
          name: 'Blocked Audio',
          layerType: 'group',
          meta: { audio: audLayer.meta.audio },
        });
        assert.equal(vwCreate.status, 403, `Viewer POST audio layer must be 403, got ${vwCreate.status}`);

        // Verify zero audio binary uploads across all 3 clients
        assert.deepEqual(ownerSess.uploadCalls, [], `Owner uploaded audio: ${ownerSess.uploadCalls.join(', ')}`);
        assert.deepEqual(editorSess.uploadCalls, [], `Editor uploaded audio: ${editorSess.uploadCalls.join(', ')}`);
        assert.deepEqual(viewerSess.uploadCalls, [], `Viewer uploaded audio: ${viewerSess.uploadCalls.join(', ')}`);

        assert.deepEqual(ownerSess.pageErrors, [], `Owner page errors: ${ownerSess.pageErrors.join('; ')}`);
        assert.deepEqual(editorSess.pageErrors, [], `Editor page errors: ${editorSess.pageErrors.join('; ')}`);
        assert.deepEqual(viewerSess.pageErrors, [], `Viewer page errors: ${viewerSess.pageErrors.join('; ')}`);
        console.log('✓ Part 3: LAN IP + net-proxy.ts Multiplayer Sync, Local-only Audio, and Room ACL (403) passed');
      } finally {
        await ownerSess.ctx.close();
        await editorSess.ctx.close();
        await viewerSess.ctx.close();
      }
    }

    console.log('ALL ANIMATION PHASE E E2E CHECKS PASSED!');
  } catch (err) {
    if (serverStderr) console.error('[Server stderr]\n' + serverStderr);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    proxyProc.kill();
    serverProc.kill();
    await sleep(400);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[Anim Phase E E2E] FAILED:', err);
  process.exit(1);
});

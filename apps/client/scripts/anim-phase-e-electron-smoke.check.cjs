/**
 * Isolated Electron Desktop Smoke Verification for Animation Phase E (E1 Camera, E2 Light Table v2, E3 Local Audio).
 *
 * Strictly uses a fresh temporary directory for APPDATA, LOCALAPPDATA, and --user-data-dir
 * so the user's running desktop app and Port 3000 Fastify server are never touched.
 *
 * Usage:
 *   node apps/client/scripts/anim-phase-e-electron-smoke.check.cjs
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildTestWavBuffer(durationSec = 0.4, sampleRate = 8000) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 18000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  await page.waitForFunction(() => window.__debugPixi?.layerManager?.getLayers().length >= 1, null, { timeout: 20000 });
  await sleep(300);
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-anim-phase-e-electron-'));
  const wavPath = path.join(userDataDir, 'electron_test.wav');
  const pngPath = path.join(userDataDir, 'electron_ref.png');
  fs.writeFileSync(wavPath, buildTestWavBuffer());
  fs.writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
  console.log(`[Electron Anim Phase E Smoke] Isolated userDataDir: ${userDataDir}`);

  let app = null;
  try {
    const session = await launchIsolated(userDataDir);
    app = session.app;
    const { page, pageErrors } = session;

    await enterOfflineCanvas(page);
    console.log('✓ Step 1: Isolated Electron launched and entered solo offline canvas');

    // Open animation timeline and create animation folder
    await page.keyboard.press('Control+Shift+KeyA');
    await page.locator('[data-anim-timeline]').waitFor({ state: 'visible', timeout: 10000 });
    const createBtn = page.locator('[data-anim-timeline] button.atelier-btn--primary').first();
    if (await createBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await createBtn.click();
      await sleep(300);
    }

    // E1: Camera Frame + Keyframe + Preview + Export Region
    await page.locator('[data-testid="timeline-camera-btn"]').click();
    await page.locator('[data-testid="camera-add-btn"]').click();
    await page.locator('[data-testid="camera-frame-overlay"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="camera-keyframe-btn"]').click();
    await page.locator('[data-testid="camera-preview-toggle"]').click();
    await page.locator('[data-testid="camera-preview-overlay"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="camera-preview-exit"]').click();
    await page.locator('[data-testid="camera-preview-overlay"]').waitFor({ state: 'detached', timeout: 8000 });
    await page.keyboard.press('Escape');

    await page.locator('[data-testid="timeline-export-btn"]').click();
    await page.locator('[data-testid="anim-export-region-camera"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.keyboard.press('Escape');
    console.log('✓ Step 2: E1 2D Camera overlay, keyframe, preview toggle, and export region verified');

    // E2: Light Table v2 ToolWindow + external image + per-item transform + pin lock
    await page.locator('[data-testid="timeline-light-table-btn"]').click();
    await page.locator('[data-testid="light-table-window"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="light-table-window"] input[type="file"]').setInputFiles(pngPath);
    await page.locator('[data-testid="light-table-overlay"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="light-ref-flip-x"]').click();
    await page.locator('[data-testid="light-table-pin-toggle"]').click();
    assert.equal(await page.locator('[data-testid="light-table-pin-toggle"]').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    console.log('✓ Step 3: E2 Light Table v2 ToolWindow, local image import, transform, and pin lock verified');

    // E3: Local Audio Track + Timeline waveform
    await page.locator('[data-testid="timeline-audio-btn"]').click();
    await page.locator('[data-testid="audio-track-window"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="audio-track-window"] input[type="file"]').first().setInputFiles(wavPath);
    await page.locator('[data-testid^="timeline-audio-waveform-"]').first().waitFor({ state: 'visible', timeout: 10000 });
    console.log('✓ Step 4: E3 Local Audio Track IndexedDB import and timeline waveform verified');

    assert.deepEqual(pageErrors, [], `Electron page errors: ${pageErrors.join('; ')}`);
    console.log('ALL ISOLATED ELECTRON ANIMATION PHASE E SMOKE CHECKS PASSED!');
  } finally {
    if (app) await app.close().catch(() => {});
    await sleep(400);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[Electron Anim Phase E Smoke] FAILED:', err);
  process.exit(1);
});

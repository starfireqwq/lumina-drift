/**
 * Isolated Electron Desktop Smoke Verification for Brush Engine v2.
 * Strictly uses a fresh temporary directory for APPDATA, LOCALAPPDATA, and --user-data-dir.
 *
 * Usage:
 *   node apps/client/scripts/brush-engine-v2-electron-smoke.check.cjs
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

async function main() {
  assert.ok(fs.existsSync(electronExe), `Missing Electron binary: ${electronExe}`);
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-brush-v2-electron-'));
  console.log(`[Brush v2 Electron] Isolated userDataDir: ${userDataDir}`);

  let app = null;
  try {
    app = await electron.launch({
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

    // Enter solo offline canvas
    const soloTab = page.getByRole('button', { name: /單人離線作畫/ });
    if (await soloTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await soloTab.click();
    }
    const startBtn = page.getByRole('button', { name: '開始單機作畫', exact: true });
    if (await startBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await startBtn.click();
    }
    await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });

    // Open BrushSettingsModal & interact with Brush Engine v2 controls
    await page.locator('button[title="筆刷詳細設定"]').first().click();
    await page.getByTestId('brush-engine-panel').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('dyn-opacity-pressure').click();
    await page.getByTestId('mix-mode-dilute').click();
    await page.getByTestId('brush-wet-edges').check();
    await page.getByTestId('dyn-fgbg-pressure').click();
    await new Promise((r) => setTimeout(r, 200));

    const previewSrc = await page.locator('[aria-label="筆劃預覽"] img').getAttribute('src');
    assert.ok(previewSrc && previewSrc.startsWith('data:image/png'), 'Electron stroke preview rendered');
    await page.getByRole('button', { name: '完成' }).click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));

    // Draw a stroke on canvas and verify non-empty pixels
    await page.evaluate(async () => {
      const dbg = window.__debugPixi;
      const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
      const canvas = dbg.app.canvas;
      const rect = canvas.getBoundingClientRect();
      const s1 = dbg.viewport.canvasToScreen(120, 120);
      const s2 = dbg.viewport.canvasToScreen(320, 220);
      surface.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, button: 0,
        clientX: rect.left + s1.x, clientY: rect.top + s1.y, buttons: 1, pressure: 0.7,
      }));
      for (let i = 1; i <= 14; i++) {
        const t = i / 14;
        const sc = dbg.viewport.canvasToScreen(120 + 200 * t, 120 + 100 * t);
        surface.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, button: -1,
          clientX: rect.left + sc.x, clientY: rect.top + sc.y, buttons: 1, pressure: 0.7,
        }));
        await new Promise((r) => setTimeout(r, 12));
      }
      surface.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, button: 0,
        clientX: rect.left + s2.x, clientY: rect.top + s2.y, buttons: 0, pressure: 0,
      }));
      await new Promise((r) => setTimeout(r, 300));
    });

    const nonZero = await page.evaluate(async () => {
      const dbg = window.__debugPixi;
      const layers = dbg.layerManager.getLayers().filter((l) => l.model?.isVisible && l.model?.layerType === 'raster');
      layers.sort((a, b) => (b.model?.sortOrder ?? 0) - (a.model?.sortOrder ?? 0));
      const active = layers[0];
      const [px] = await dbg.layerManager.readAsync(active.model.id, [{ x: 0, y: 0, w: 512, h: 512 }]);
      let count = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) count++;
      return count;
    });
    console.log(`[Brush v2 Electron] Stroke non-zero pixels: ${nonZero}`);
    assert.ok(nonZero > 50, `Expected non-zero stroke pixels in Electron, got ${nonZero}`);
    assert.deepEqual(pageErrors, [], `Unexpected Electron page errors: ${pageErrors.join(' | ')}`);
    console.log('[Brush v2 Electron] SMOKE TEST PASSED!');
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup on Windows
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

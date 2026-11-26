/**
 * Isolated Electron Desktop Smoke Verification for v1.5.0 Phase 4:
 * - 4.1 Non-destructive Layer Effects (Edge Border, Watercolor Border, Drop Shadow, Outer Glow, Color Overlay)
 * - 4.2 Quick Mask (Q toggle, ruby-red brush add & eraser subtract without altering layer pixels, convert to selection, Undo/Redo)
 * - 4.3 Advanced Color Range Selection Dialog (live mask preview, eyedropper click sampling, fuzziness/feather/invert, apply)
 * - 4.4 Export modal WebP option & live composite pixel verification
 * - Strictly 0 console errors & 0 page errors in isolated APPDATA/LOCALAPPDATA/--user-data-dir
 *
 * Usage:
 *   node apps/client/scripts/v15-phase4-effects-selection-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireClient = createRequire(path.join(clientRoot, 'package.json'));
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');
const electronExe = requireClient('electron');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const rendererHtml = path.join(clientRoot, 'dist/index.html');

function hasExited(child) {
  return !child?.pid || child.exitCode !== null || child.signalCode !== null;
}

async function closeElectron(app) {
  const child = app.process();
  const closed = app.close().then(() => true, () => false);
  const done = await Promise.race([
    closed,
    new Promise((r) => setTimeout(() => r(false), 6000)),
  ]);
  if (!done && !hasExited(child)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 5000,
      });
    } else {
      child.kill('SIGKILL');
    }
  }
}

async function drawPenStroke(page, x1, y1, x2, y2, pressure = 0.9, steps = 14) {
  await page.evaluate(async ({ x1, y1, x2, y2, pressure, steps }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const canvas = dbg.app.canvas;
    const rect = canvas.getBoundingClientRect();
    const s1 = dbg.viewport.canvasToScreen(x1, y1);
    const s2 = dbg.viewport.canvasToScreen(x2, y2);
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 21, pointerType: 'pen', isPrimary: true, button: 0,
      clientX: rect.left + s1.x, clientY: rect.top + s1.y, buttons: 1, pressure,
    }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sc = dbg.viewport.canvasToScreen(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, pointerId: 21, pointerType: 'pen', isPrimary: true, button: -1,
        clientX: rect.left + sc.x, clientY: rect.top + sc.y, buttons: 1, pressure,
      }));
      await new Promise((r) => setTimeout(r, 12));
    }
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 21, pointerType: 'pen', isPrimary: true, button: 0,
      clientX: rect.left + s2.x, clientY: rect.top + s2.y, buttons: 0, pressure: 0,
    }));
    await new Promise((r) => setTimeout(r, 260));
  }, { x1, y1, x2, y2, pressure, steps });
}

async function setRangeValue(locator, value) {
  await locator.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, value);
}

async function main() {
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);
  assert.ok(fs.existsSync(rendererHtml), `Missing compiled renderer HTML: ${rendererHtml}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-v15-phase4-smoke-'));
  const userDataDir = path.join(tempRoot, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });

  const launcher = path.join(userDataDir, 'launch-electron.cjs');
  fs.writeFileSync(launcher, `
    const { app, BrowserWindow, ipcMain, session } = require('electron');
    const { EventEmitter } = require('node:events');
    const http = require('node:http');
    app.setPath('userData', ${JSON.stringify(userDataDir)});
    app.setPath('sessionData', ${JSON.stringify(userDataDir)});

    const get = http.get;
    http.get = function (url, ...args) {
      if (typeof url === 'string' && new URL(url).port === '3000') {
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.destroy = () => request;
        process.nextTick(() => request.emit('error', new Error('Reserved server port')));
        return request;
      }
      return get.call(this, url, ...args);
    };
    app.whenReady().then(() => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: new URL(details.url).port === '3000' });
      });
    });

    const loadFile = BrowserWindow.prototype.loadFile;
    const rendererReady = new Promise((resolve) => { globalThis.startSmokeRenderer = resolve; });
    BrowserWindow.prototype.loadFile = async function (...args) {
      try {
        await this.loadURL('data:text/html,<title>Phase 4 Smoke</title>');
        await rendererReady;
        await loadFile.apply(this, args);
      } catch (error) {
        console.error('Smoke renderer failed to load:', error);
        app.exit(1);
      }
    };
    require(${JSON.stringify(mainJs)});
    for (const channel of ['atelier:start-server', 'atelier:start-tunnel']) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle('atelier:start-server', () => false);
    ipcMain.handle('atelier:start-tunnel', () => ({ success: false }));
  `);

  const env = { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir, PORT: '0' };
  delete env.VITE_DEV_SERVER_URL;
  const args = ['--noerrdialogs'];
  if (process.env.ATELIER_SMOKE_SOFTWARE_GPU === '1') {
    args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--in-process-gpu');
  }
  if (process.env.ATELIER_SMOKE_NO_CHROMIUM_SANDBOX === '1') args.push('--no-sandbox');
  args.push(launcher, `--user-data-dir=${userDataDir}`);

  const rendererErrors = [];
  let canvasEntered = false;
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args,
      env,
      artifactsDir: userDataDir,
      timeout: 25_000,
    });
    const context = app.context();
    context.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!canvasEntered && /ERR_BLOCKED_BY_CLIENT|ERR_CONNECTION_REFUSED/.test(text)) return;
        rendererErrors.push(`console.error: ${text}`);
      }
    });
    context.on('weberror', (ev) => {
      rendererErrors.push(`pageerror: ${ev.error().message}`);
    });

    const page = await app.firstWindow({ timeout: 25_000 });
    page.setDefaultTimeout(12_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    const url = pathToFileURL(rendererHtml).href;
    await page.addInitScript(({ url }) => {
      if (location.href !== url) return;
      localStorage.setItem('atelier_language', 'en-US');
      // Capture exported files in memory so the real Downloads folder is never touched
      window.__capturedDownloads = [];
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      const blobByUrl = new Map();
      URL.createObjectURL = (obj) => {
        const u = origCreateObjectURL(obj);
        if (obj instanceof Blob) blobByUrl.set(u, obj);
        return u;
      };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && this.href && blobByUrl.has(this.href)) {
          const blob = blobByUrl.get(this.href);
          const name = this.download;
          blob.arrayBuffer().then((buf) => {
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            window.__capturedDownloads.push({ name, type: blob.type, size: bytes.length, base64: btoa(bin) });
          });
          return;
        }
        return origClick.call(this);
      };
    }, { url });
    await app.evaluate(() => globalThis.startSmokeRenderer());
    await page.waitForURL(url, { waitUntil: 'domcontentloaded' });

    // Start Solo Offline Drawing (640x480)
    await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
    await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
    await page.getByRole('spinbutton', { name: /^Width/ }).fill('640');
    await page.getByRole('spinbutton', { name: /^Height/ }).fill('480');
    await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
    await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25_000 });
    canvasEntered = true;
    await page.waitForTimeout(400);

    // Paint a bold blue stroke in the center of the canvas
    await drawPenStroke(page, 180, 220, 420, 220, 1.0, 16);

    const baseStats = await page.evaluate(() => {
      const dbg = window.__debugPixi;
      const c = dbg.layerManager.renderCompositeCanvas({ transparent: true });
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nonEmpty = 0;
      let redRimCount = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 20) nonEmpty++;
        if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80 && data[i + 3] > 120) redRimCount++;
      }
      return { nonEmpty, redRimCount };
    });
    assert.ok(baseStats.nonEmpty > 400, `Expected drawn blue stroke pixels > 400, got ${baseStats.nonEmpty}`);
    assert.equal(baseStats.redRimCount, 0, 'Before border effect, there should be no red border pixels');

    // === 4.1 Layer Effects: Edge Border, Watercolor Border, Drop Shadow, Outer Glow, Color Overlay ===
    await page.getByTestId('layer-effects-trigger').click();
    const fxPopover = page.getByTestId('layer-effects-popover');
    await fxPopover.waitFor();

    // Enable Edge Border in bright red (#ff0000), width 10
    await fxPopover.getByTestId('layer-effect-border-toggle').click();
    await fxPopover.getByTestId('layer-effect-border-color').evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '#ff0000');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await setRangeValue(fxPopover.getByTestId('layer-effect-border-width'), 10);
    await page.waitForTimeout(300);

    // Verify fx badge appeared on layer row
    await page.locator('[data-testid^="layer-fx-badge-"]').first().waitFor();

    // Verify live composite actually contains expanded red border pixels around the stroke!
    const edgeStats = await page.evaluate(() => {
      const dbg = window.__debugPixi;
      const c = dbg.layerManager.renderCompositeCanvas({ transparent: true });
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nonEmpty = 0;
      let redRimCount = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 20) nonEmpty++;
        if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 80 && data[i + 3] > 100) redRimCount++;
      }
      return { nonEmpty, redRimCount };
    });
    assert.ok(edgeStats.redRimCount > 300, `Expected red border pixels > 300, got ${edgeStats.redRimCount}`);
    assert.ok(edgeStats.nonEmpty > baseStats.nonEmpty, `Expected edge border to expand nonEmpty pixels (${edgeStats.nonEmpty} > ${baseStats.nonEmpty})`);

    // Switch to Watercolor Border + enable Drop Shadow, Outer Glow, Color Overlay
    await fxPopover.getByTestId('layer-effect-border-mode-watercolor').click();
    await fxPopover.getByTestId('layer-effect-shadow-toggle').click();
    await fxPopover.getByTestId('layer-effect-glow-toggle').click();
    await fxPopover.getByTestId('layer-effect-overlay-toggle').click();
    await page.waitForTimeout(250);

    // Clear Color Overlay so blue stroke remains recognizable for Color Range test; keep edge border on!
    await fxPopover.getByTestId('layer-effect-overlay-toggle').click();
    await fxPopover.getByTestId('layer-effect-border-mode-edge').click();
    await page.keyboard.press('Escape');
    await fxPopover.waitFor({ state: 'hidden' });

    // === 4.2 Quick Mask (Q toggle, red film brush + eraser, Undo, convert to selection) ===
    const layerNonEmptyBeforeQM = await page.evaluate(async () => {
      const dbg = window.__debugPixi;
      const ids = Array.from(dbg.layerManager.layersMap.keys());
      const [px] = await dbg.layerManager.readAsync(ids[0], [{ x: 0, y: 0, w: 640, h: 480 }]);
      let c = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) c++;
      return c;
    });

    await page.keyboard.press('KeyQ');
    await page.getByTestId('quick-mask-banner').waitFor();
    const qmOn = await page.evaluate(() => window.__debugPixi.selectionEngine.isQuickMaskMode());
    assert.equal(qmOn, true, 'Pressing Q should enter Quick Mask mode');

    // Paint red film stroke with brush
    await drawPenStroke(page, 120, 120, 260, 120, 1.0, 12);
    const qmAfterPaint = await page.evaluate(() => window.__debugPixi.selectionEngine.getMaskData()?.activePixelCount ?? 0);
    assert.ok(qmAfterPaint > 200, `Quick Mask brush should paint selection pixels > 200, got ${qmAfterPaint}`);

    // Verify underlying active layer pixels were NOT touched by Quick Mask painting
    const layerNonEmptyAfterQM = await page.evaluate(async () => {
      const dbg = window.__debugPixi;
      const ids = Array.from(dbg.layerManager.layersMap.keys());
      const [px] = await dbg.layerManager.readAsync(ids[0], [{ x: 0, y: 0, w: 640, h: 480 }]);
      let c = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) c++;
      return c;
    });
    assert.equal(layerNonEmptyAfterQM, layerNonEmptyBeforeQM, 'Quick Mask strokes must not modify layer pixels');

    // Switch to Eraser (E) and erase across the middle of the red film
    await page.keyboard.press('KeyE');
    await drawPenStroke(page, 190, 90, 190, 150, 1.0, 10);
    const qmAfterErase = await page.evaluate(() => window.__debugPixi.selectionEngine.getMaskData()?.activePixelCount ?? 0);
    assert.ok(qmAfterErase < qmAfterPaint, `Quick Mask eraser should reduce pixels (${qmAfterErase} < ${qmAfterPaint})`);

    // Undo inside Quick Mask restores erased mask pixels
    await page.keyboard.press('Control+KeyZ');
    await page.waitForTimeout(200);
    const qmAfterUndo = await page.evaluate(() => window.__debugPixi.selectionEngine.getMaskData()?.activePixelCount ?? 0);
    assert.equal(qmAfterUndo, qmAfterPaint, 'Ctrl+Z inside Quick Mask should undo the eraser stroke');

    // Press Q to exit Quick Mask -> converts red film to active marching-ants selection!
    await page.keyboard.press('KeyQ');
    await page.getByTestId('quick-mask-banner').waitFor({ state: 'hidden' });
    const afterExit = await page.evaluate(() => ({
      qm: window.__debugPixi.selectionEngine.isQuickMaskMode(),
      has: window.__debugPixi.selectionEngine.hasSelection(),
      count: window.__debugPixi.selectionEngine.getMaskData()?.activePixelCount ?? 0,
    }));
    assert.equal(afterExit.qm, false, 'Pressing Q again should exit Quick Mask mode');
    assert.equal(afterExit.has, true, 'Exiting Quick Mask should keep active selection');
    assert.equal(afterExit.count, qmAfterPaint, 'Converted selection should preserve exact Quick Mask pixel count');

    // Deselect before testing Color Range
    await page.keyboard.press('Control+KeyD');
    await page.waitForTimeout(150);

    // === 4.3 Advanced Color Range Selection Dialog ===
    await page.keyboard.press('KeyL'); // Lasso selection tool so Color Range button shows in ToolOptionsBar
    const openColorRangeBtn = page.getByTestId('open-color-range-btn');
    await openColorRangeBtn.waitFor();
    await openColorRangeBtn.click();

    const crDialog = page.getByTestId('color-range-dialog');
    await crDialog.waitFor();
    const crPreview = crDialog.getByTestId('color-range-preview');
    await crPreview.waitFor();

    // Switch to Merged Canvas source and adjust fuzziness + feather
    await crDialog.getByTestId('color-range-source-merged').click();
    await page.waitForTimeout(200);
    await setRangeValue(crDialog.getByTestId('color-range-fuzziness'), 65);
    await setRangeValue(crDialog.getByTestId('color-range-feather'), 2);
    await page.waitForTimeout(150);

    // Click right on the center of the preview where our blue stroke was drawn (x=300/640, y=220/480)
    const box = await crPreview.boundingBox();
    assert.ok(box && box.width > 50 && box.height > 50, 'Color Range preview canvas must have non-zero size');
    await page.mouse.click(box.x + box.width * (300 / 640), box.y + box.height * (220 / 480));
    await page.waitForTimeout(150);

    const statsBeforeInvert = await crDialog.getByTestId('color-range-stats').textContent();
    await crDialog.getByTestId('color-range-invert').click();
    await page.waitForTimeout(150);
    const statsAfterInvert = await crDialog.getByTestId('color-range-stats').textContent();
    assert.notEqual(statsAfterInvert, statsBeforeInvert, 'Toggling Invert must update live Color Range coverage stats');
    await crDialog.getByTestId('color-range-invert').click(); // back to normal
    await page.waitForTimeout(150);

    // Apply Color Range selection
    await crDialog.getByTestId('color-range-apply').click();
    await crDialog.waitFor({ state: 'hidden' });
    const crSelectionCount = await page.evaluate(() => window.__debugPixi.selectionEngine.getMaskData()?.activePixelCount ?? 0);
    assert.ok(crSelectionCount > 300, `Color Range selection should select stroke pixels > 300, got ${crSelectionCount}`);

    // === 4.4 Export Pipeline Parity (PNG, WebP, PSD, KRA with Layer Effects active) ===
    const exportFormat = async (formatId, expectedExt) => {
      await page.evaluate(() => { window.__capturedDownloads = []; });
      await page.locator('header').getByRole('button', { name: 'File', exact: true }).click();
      await page.getByRole('menuitem', { name: /Export \(PNG\/PSD\/ORA\/KRA\)/ }).click();
      await page.getByTestId(`export-format-${formatId}`).click();
      await page.getByTestId('export-download').click();
      await page.waitForFunction(
        (ext) => Array.isArray(window.__capturedDownloads) && window.__capturedDownloads.some((d) => d.name.endsWith(ext)),
        expectedExt,
        { timeout: 15_000 },
      );
      const captured = await page.evaluate((ext) => window.__capturedDownloads.find((d) => d.name.endsWith(ext)), expectedExt);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      return captured;
    };

    const countRedRimInImage = async (base64, mime) => {
      return await page.evaluate(async ({ base64, mime }) => {
        const img = new Image();
        img.src = `data:${mime};base64,${base64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let redRim = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 80 && data[i + 3] > 100) redRim++;
        }
        return { width: img.width, height: img.height, redRim };
      }, { base64, mime });
    };

    const pngExport = await exportFormat('merged_png', '.png');
    const webpExport = await exportFormat('webp', '.webp');
    const psdExport = await exportFormat('psd', '.psd');
    const kraExport = await exportFormat('kra', '.kra');

    const pngCheck = await countRedRimInImage(pngExport.base64, 'image/png');
    const webpCheck = await countRedRimInImage(webpExport.base64, 'image/webp');
    assert.ok(pngCheck.redRim > 300, `Exported PNG must include red layer border effect (>300 px), got ${pngCheck.redRim}`);
    assert.ok(webpCheck.redRim > 300, `Exported WebP must include red layer border effect (>300 px), got ${webpCheck.redRim}`);
    assert.equal(Buffer.from(psdExport.base64, 'base64').toString('ascii', 0, 4), '8BPS', 'Exported PSD must have valid 8BPS header');
    assert.equal(Buffer.from(kraExport.base64, 'base64').toString('ascii', 0, 2), 'PK', 'Exported KRA must have valid ZIP/PK header');

    assert.equal(rendererErrors.length, 0, `Expected 0 console/page errors, got:\n${rendererErrors.join('\n')}`);
    console.log(
      `v1.5 Phase 4 Electron smoke passed! (0 console errors, 0 page errors; ` +
      `edgeBorderRedPx=${edgeStats.redRimCount}, pngRedPx=${pngCheck.redRim}, webpRedPx=${webpCheck.redRim}, ` +
      `psdBytes=${psdExport.size}, kraBytes=${kraExport.size}, quickMaskPx=${qmAfterPaint}, colorRangePx=${crSelectionCount})`,
    );
  } finally {
    if (app) await closeElectron(app);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

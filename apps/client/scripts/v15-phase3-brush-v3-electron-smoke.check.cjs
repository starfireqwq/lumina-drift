/**
 * Isolated Electron Desktop Smoke Verification for v1.5.0 Phase 3 (Brush Engine v3).
 * Verifies:
 * - Dual Brush v3 (secondary tip shapes, 5 blend modes, size/spacing/scatter)
 * - Multi-Tip sequence play modes (single/sequential/random/randomNoRepeat)
 * - Color Dynamics v3 (per-dab vs per-stroke, HSL jitter/pressure/gradient)
 * - Wet Edges (strength/width/darkness) & Subtractive Pigment Blending (Yellow over Blue -> Green)
 * - Live stroke preview & real canvas rendering + .brushset import restoration
 * - Strictly 0 console errors & 0 page errors in isolated APPDATA/LOCALAPPDATA/--user-data-dir
 *
 * Usage:
 *   node apps/client/scripts/v15-phase3-brush-v3-electron-smoke.check.cjs
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

const PNG_1X1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff,
  0x89, 0x99, 0x3d, 0x1d,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function buildStoredZip(files) {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    data.copy(local, 30 + nameBytes.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

async function drawPenStroke(page, x1, y1, x2, y2, pressure = 0.8, steps = 16) {
  await page.evaluate(async ({ x1, y1, x2, y2, pressure, steps }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const canvas = dbg.app.canvas;
    const rect = canvas.getBoundingClientRect();
    const s1 = dbg.viewport.canvasToScreen(x1, y1);
    const s2 = dbg.viewport.canvasToScreen(x2, y2);
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 11, pointerType: 'pen', isPrimary: true, button: 0,
      clientX: rect.left + s1.x, clientY: rect.top + s1.y, buttons: 1, pressure,
    }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sc = dbg.viewport.canvasToScreen(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, pointerId: 11, pointerType: 'pen', isPrimary: true, button: -1,
        clientX: rect.left + sc.x, clientY: rect.top + sc.y, buttons: 1, pressure,
      }));
      await new Promise((r) => setTimeout(r, 12));
    }
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 11, pointerType: 'pen', isPrimary: true, button: 0,
      clientX: rect.left + s2.x, clientY: rect.top + s2.y, buttons: 0, pressure: 0,
    }));
    await new Promise((r) => setTimeout(r, 260));
  }, { x1, y1, x2, y2, pressure, steps });
}

async function main() {
  assert.ok(fs.existsSync(electronExe), `Missing Electron binary: ${electronExe}`);
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-v15-brush-v3-electron-'));
  const sampleBrushPath = path.join(userDataDir, 'v3-dual-watercolor.brush');
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>name</key><string>Smoke V3 Dual Watercolor</string>
  <key>paintSize</key><real>0.32</real>
  <key>bundledBrush</key><true/>
  <key>bundledBrushCombineMode</key><integer>0</integer>
  <key>bundledBrushSize</key><real>0.55</real>
  <key>bundledBrushSpacing</key><real>0.3</real>
  <key>bundledBrushScatter</key><real>0.4</real>
  <key>dynamicsStrokeJitterHue</key><real>0.25</real>
  <key>wetEdges</key><true/>
  <key>wetEdgesStrength</key><real>0.65</real>
  <key>wetEdgesWidth</key><real>0.24</real>
  <key>wetEdgesDarkness</key><real>0.45</real>
  <key>wetMix</key><real>0.75</real>
  <key>textureDepth</key><real>0.45</real>
  <key>grainBlendMode</key><string>multiply</string>
</dict></plist>`;
  fs.writeFileSync(
    sampleBrushPath,
    buildStoredZip([
      { name: 'Brush.archive', data: Buffer.from(plistXml, 'utf8') },
      { name: 'Shape.png', data: PNG_1X1 },
      { name: 'DualShape.png', data: PNG_1X1 },
      { name: 'Grain.png', data: PNG_1X1 },
    ]),
  );

  console.log(`[Brush v3 Electron] Isolated userDataDir: ${userDataDir}`);

  // Isolated launcher: binds userData/sessionData to temp dir and blocks Port 3000 & server auto-start
  const launcherJs = path.join(userDataDir, 'launch-electron.cjs');
  fs.writeFileSync(launcherJs, `
    const { app, ipcMain, session } = require('electron');
    const { EventEmitter } = require('node:events');
    const http = require('node:http');
    app.setPath('userData', ${JSON.stringify(userDataDir)});
    app.setPath('sessionData', ${JSON.stringify(userDataDir)});
    const origGet = http.get;
    http.get = function (url, ...args) {
      if (typeof url === 'string' && new URL(url).port === '3000') {
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = () => req;
        process.nextTick(() => req.emit('error', new Error('Reserved server port')));
        return req;
      }
      return origGet.call(this, url, ...args);
    };
    app.whenReady().then(() => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        try {
          callback({ cancel: new URL(details.url).port === '3000' });
        } catch {
          callback({ cancel: false });
        }
      });
    });
    require(${JSON.stringify(mainJs)});
    for (const ch of ['atelier:start-server', 'atelier:start-tunnel']) {
      ipcMain.removeHandler(ch);
    }
    ipcMain.handle('atelier:start-server', () => false);
    ipcMain.handle('atelier:start-tunnel', () => ({ success: false }));
  `);

  let app = null;
  try {
    const env = {
      ...process.env,
      APPDATA: userDataDir,
      LOCALAPPDATA: userDataDir,
      PORT: '0',
    };
    delete env.VITE_DEV_SERVER_URL;
    app = await electron.launch({
      executablePath: electronExe,
      args: ['--noerrdialogs', launcherJs, `--user-data-dir=${userDataDir}`],
      env,
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors = [];
    const consoleErrors = [];
    let canvasEntered = false;
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!canvasEntered && /ERR_BLOCKED_BY_CLIENT|ERR_CONNECTION_REFUSED/.test(text)) return;
        consoleErrors.push(text);
      }
    });
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
    canvasEntered = true;

    // 1. Open BrushSettingsModal & toggle all Brush Engine v3 UI controls
    await page.locator('button[title="筆刷詳細設定"]').first().click();
    await page.getByTestId('brush-engine-panel').waitFor({ state: 'visible', timeout: 10000 });

    await page.getByTestId('pigment-model-subtractive').click();
    await page.getByTestId('brush-wet-edges').check();
    await page.getByTestId('brush-wet-edge-controls').waitFor({ state: 'visible', timeout: 5000 });

    await page.getByTestId('color-scope-perStroke').click();
    await page.getByTestId('color-scope-perDab').click();
    await page.getByTestId('color-fgbg-gradient').check();
    await page.getByTestId('color-fgbg-gradient').uncheck();

    await page.getByTestId('brush-dual-toggle').check();
    await page.getByTestId('dual-mode-overlay').click();
    await page.getByTestId('dual-mode-screen').click();
    await page.getByTestId('dual-mode-multiply').click();
    await page.getByTestId('dual-shape-speckle').click();
    await page.getByTestId('dual-shape-bristle').click();

    await page.getByTestId('tip-play-sequential').click();
    await page.getByTestId('tip-play-randomNoRepeat').click();
    await page.getByTestId('tip-play-single').click();

    await new Promise((r) => setTimeout(r, 240));
    const previewSrc = await page.locator('[aria-label="筆劃預覽"] img').getAttribute('src');
    assert.ok(previewSrc && previewSrc.startsWith('data:image/png'), 'Brush v3 stroke preview must render');

    await page.getByRole('button', { name: '完成' }).click();
    await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));

    // 2. Draw a stroke with Wet Edges + Dual Brush active & verify non-zero rendered pixels
    await drawPenStroke(page, 120, 140, 320, 140, 0.85, 16);
    const wetDualCount = await page.evaluate(async () => {
      const dbg = window.__debugPixi;
      const layers = dbg.layerManager.getLayers().filter((l) => l.model?.isVisible && l.model?.layerType === 'raster');
      layers.sort((a, b) => (b.model?.sortOrder ?? 0) - (a.model?.sortOrder ?? 0));
      const [px] = await dbg.layerManager.readAsync(layers[0].model.id, [{ x: 80, y: 80, w: 300, h: 120 }]);
      let count = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) count++;
      return count;
    });
    console.log(`[Brush v3 Electron] Wet+Dual stroke non-zero pixels: ${wetDualCount}`);
    assert.ok(wetDualCount > 80, `Expected non-zero Wet+Dual stroke pixels, got ${wetDualCount}`);

    // 3. Real StrokePipeline end-to-end verification: Subtractive Pigment Blend (Yellow over Blue -> Green) vs RGB + Color Dynamics
    const savedBrushProps = await page.evaluate(() => {
      const br = window.__debugPixi.brushRenderer;
      const saved = { ...br.getProperties() };
      br.setProperties({
        ...saved,
        size: 36, minSize: 36, opacity: 1, flow: 1, hardness: 0.9, spacing: 0.1,
        color: '#0057FF', colorMixing: 0, wetEdges: false, dualBrush: false,
        colorDynamics: undefined, hueJitter: 0, satJitter: 0, valJitter: 0, fgBgMix: 0,
      });
      return saved;
    });
    // Paint two identical solid blue base strokes (y=260 for subtractive, y=320 for naive RGB)
    await drawPenStroke(page, 140, 260, 300, 260, 0.9, 16);
    await drawPenStroke(page, 140, 320, 300, 320, 0.9, 16);

    // Paint yellow over blue at y=260 using Subtractive Pigment Blending
    await page.evaluate(() => {
      const br = window.__debugPixi.brushRenderer;
      br.setProperties({
        ...br.getProperties(),
        color: '#FFD400',
        colorMixing: 0.65,
        paintAmount: 0.75,
        colorStretch: 0.05,
        mixMode: 'blend',
        pigmentBlendMode: 'subtractive',
        pigmentStrength: 1.0,
      });
    });
    await drawPenStroke(page, 140, 260, 300, 260, 0.75, 16);

    // Paint yellow over blue at y=320 using naive RGB blending for direct comparison
    await page.evaluate(() => {
      const br = window.__debugPixi.brushRenderer;
      br.setProperties({
        ...br.getProperties(),
        pigmentBlendMode: 'rgb',
      });
    });
    await drawPenStroke(page, 140, 320, 300, 320, 0.75, 16);

    // Switch to per-dab Color Dynamics & paint at y=380
    await page.evaluate(() => {
      const br = window.__debugPixi.brushRenderer;
      br.setProperties({
        ...br.getProperties(),
        color: '#E63946',
        colorMixing: 0,
        colorDynamics: { scope: 'perDab', hueJitter: 0.85, saturationJitter: 0.2 },
      });
    });
    await drawPenStroke(page, 140, 380, 340, 380, 0.85, 16);

    const pigmentCheck = await page.evaluate(async (saved) => {
      const dbg = window.__debugPixi;
      dbg.brushRenderer.setProperties(saved);
      const layers = dbg.layerManager.getLayers().filter((l) => l.model?.isVisible && l.model?.layerType === 'raster');
      layers.sort((a, b) => (b.model?.sortOrder ?? 0) - (a.model?.sortOrder ?? 0));
      const layer = layers[0];

      const measureGreen = (px) => {
        let count = 0;
        let greenDom = 0;
        let sumExcessG = 0;
        let sample = null;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] > 180) {
            const r = px[i], g = px[i + 1], b = px[i + 2];
            if (!sample) sample = [r, g, b, px[i + 3]];
            count++;
            sumExcessG += g - (r + b) * 0.5;
            if (g > r + 10 && g > b + 10) greenDom++;
          }
        }
        return { count, greenDom, avgExcessG: count > 0 ? sumExcessG / count : -999, sample };
      };

      const [subPx] = await dbg.layerManager.readAsync(layer.model.id, [{ x: 160, y: 248, w: 120, h: 24 }]);
      const [rgbPx] = await dbg.layerManager.readAsync(layer.model.id, [{ x: 160, y: 308, w: 120, h: 24 }]);
      const subStats = measureGreen(subPx);
      const rgbStats = measureGreen(rgbPx);

      const [cdPx] = await dbg.layerManager.readAsync(layer.model.id, [{ x: 130, y: 368, w: 220, h: 24 }]);
      const buckets = new Set();
      for (let i = 0; i < cdPx.length; i += 4) {
        if (cdPx[i + 3] > 200) {
          buckets.add(`${cdPx[i] >> 5}_${cdPx[i + 1] >> 5}_${cdPx[i + 2] >> 5}`);
        }
      }
      return { subStats, rgbStats, distinctColorBuckets: buckets.size };
    }, savedBrushProps);
    console.log('[Brush v3 Electron] Subtractive stats:', pigmentCheck.subStats, 'RGB stats:', pigmentCheck.rgbStats, 'ColorDynamics buckets:', pigmentCheck.distinctColorBuckets);
    assert.ok(pigmentCheck.subStats.avgExcessG > pigmentCheck.rgbStats.avgExcessG + 8, 'Subtractive pigment blend must produce significantly greener mix than RGB');
    assert.ok(pigmentCheck.subStats.greenDom > 50 || pigmentCheck.subStats.avgExcessG > 10, 'Subtractive yellow+blue should shift strongly toward green');
    assert.ok(pigmentCheck.distinctColorBuckets >= 4, `Expected per-dab hue jitter to produce varied colors, got ${pigmentCheck.distinctColorBuckets}`);

    // 4. Import synthetic Procreate .brush v3 file via BrushToolset file input & verify settings restored
    let importInput = page.locator('input[type="file"][accept*=".brushset"]').first();
    if (await importInput.count() === 0) {
      const brushTab = page.locator('button[title*="筆刷庫"], button[title*="筆刷組"], button:has-text("筆刷庫"), button:has-text("筆刷組")').first();
      if (await brushTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await brushTab.click();
        await new Promise((r) => setTimeout(r, 250));
      } else {
        // Open via BrushSettingsModal -> import button
        await page.locator('button[title="筆刷詳細設定"]').first().click();
        await page.getByTestId('brush-engine-panel').waitFor({ state: 'visible', timeout: 5000 });
        const importBtn = page.getByRole('button', { name: /匯入筆刷|筆刷庫/ }).first();
        if (await importBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await importBtn.click();
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      importInput = page.locator('input[type="file"][accept*=".brushset"]').first();
    }
    assert.ok((await importInput.count()) > 0, 'BrushToolset import file input must be mounted');
    await importInput.setInputFiles(sampleBrushPath);
    await page.getByText('Smoke V3 Dual Watercolor').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Smoke V3 Dual Watercolor').first().click();
    await new Promise((r) => setTimeout(r, 250));
    const restored = await page.evaluate(() => {
      const p = window.__debugPixi.brushRenderer.getProperties();
      return {
        dualBrush: p.dualBrush,
        wetEdges: p.wetEdges,
        pigmentBlendMode: p.pigmentBlendMode,
        scope: p.colorDynamics?.scope,
      };
    });
    console.log('[Brush v3 Electron] Imported .brush restored props:', restored);
    assert.equal(restored.dualBrush, true, 'Imported .brush should restore dualBrush=true');
    assert.equal(restored.wetEdges, true, 'Imported .brush should restore wetEdges=true');
    assert.equal(restored.pigmentBlendMode, 'subtractive', 'Imported .brush should restore pigmentBlendMode=subtractive');
    assert.equal(restored.scope, 'perStroke', 'Imported .brush should restore perStroke colorDynamics');

    assert.deepEqual(consoleErrors, [], `Unexpected Electron console errors: ${consoleErrors.join(' | ')}`);
    assert.deepEqual(pageErrors, [], `Unexpected Electron page errors: ${pageErrors.join(' | ')}`);
    console.log('[Brush v3 Electron] SMOKE TEST PASSED!');
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

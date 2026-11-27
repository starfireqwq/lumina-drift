/**
 * Isolated Electron Desktop Smoke Verification for v1.5.0 Phase 6:
 * - 6.1 Animation Timeline Audio Waveform Canvas (trim/volume/mute) + MP4/WebM Audio Mix Export
 * - 6.2 True CMYK 4-Channel TIFF & PSD Export + GCR/UCR Controls + Live TAC Over-Limit Warning
 * - 6.3 Large Canvas (4K 4096x4096) Tile GPU Texture LRU Pool, Budget Enforcement & Stats
 * - Strictly 0 console errors & 0 page errors in isolated APPDATA/LOCALAPPDATA/--user-data-dir
 *
 * Usage:
 *   node apps/client/scripts/v15-phase6-pro-perf-electron-smoke.check.cjs
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
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
    } else {
      child.kill('SIGKILL');
    }
  }
}

function buildTestWavBuffer(durationSec = 0.5, sampleRate = 16000) {
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
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 20000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

async function drawPenStroke(page, x1, y1, x2, y2, pressure = 1.0, steps = 14) {
  await page.evaluate(async ({ x1, y1, x2, y2, pressure, steps }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const canvas = dbg.app.canvas;
    const rect = canvas.getBoundingClientRect();
    const s1 = dbg.viewport.canvasToScreen(x1, y1);
    const s2 = dbg.viewport.canvasToScreen(x2, y2);
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 31, pointerType: 'pen', isPrimary: true, button: 0,
      clientX: rect.left + s1.x, clientY: rect.top + s1.y, buttons: 1, pressure,
    }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sc = dbg.viewport.canvasToScreen(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, pointerId: 31, pointerType: 'pen', isPrimary: true, button: -1,
        clientX: rect.left + sc.x, clientY: rect.top + sc.y, buttons: 1, pressure,
      }));
      await new Promise((r) => setTimeout(r, 12));
    }
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 31, pointerType: 'pen', isPrimary: true, button: 0,
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
  }, value);
}

function verifyTiffHeader(buf) {
  assert.equal(buf[0], 0x49, 'TIFF must be little-endian II');
  assert.equal(buf[1], 0x49);
  assert.equal(buf.readUInt16LE(2), 42, 'TIFF magic must be 42');
  const ifdOff = buf.readUInt32LE(4);
  const count = buf.readUInt16LE(ifdOff);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const base = ifdOff + 2 + i * 12;
    const tag = buf.readUInt16LE(base);
    const type = buf.readUInt16LE(base + 2);
    const val = type === 3 ? buf.readUInt16LE(base + 8) : buf.readUInt32LE(base + 8);
    tags[tag] = val;
  }
  assert.equal(tags[262], 5, 'TIFF PhotometricInterpretation must be 5 (CMYK)');
  assert.equal(tags[277], 4, 'TIFF SamplesPerPixel must be 4');
  assert.equal(tags[332], 1, 'TIFF InkSet must be 1 (CMYK)');
  return tags;
}

function verifyCmykPsdHeader(buf) {
  assert.equal(buf.toString('ascii', 0, 4), '8BPS', 'PSD signature must be 8BPS');
  assert.equal(buf.readUInt16BE(4), 1, 'PSD version must be 1');
  assert.equal(buf.readUInt16BE(12), 4, 'PSD channels must be 4 (CMYK)');
  assert.equal(buf.readUInt16BE(22), 8, 'PSD depth must be 8-bit');
  assert.equal(buf.readUInt16BE(24), 4, 'PSD ColorMode must be 4 (CMYK)');
  return {
    width: buf.readUInt32BE(18),
    height: buf.readUInt32BE(14),
    channels: buf.readUInt16BE(12),
    colorMode: buf.readUInt16BE(24),
  };
}

async function launchIsolatedSession(tempRoot, label, width, height) {
  const userDataDir = path.join(tempRoot, label);
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
        await this.loadURL('data:text/html,<title>Phase 6 Smoke</title>');
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
  const app = await electron.launch({
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
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  const url = pathToFileURL(rendererHtml).href;
  await page.addInitScript(({ url }) => {
    if (location.href !== url) return;
    localStorage.setItem('atelier_language', 'en-US');
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

  await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
  await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
  await page.getByRole('spinbutton', { name: /^Width/ }).fill(String(width));
  await page.getByRole('spinbutton', { name: /^Height/ }).fill(String(height));
  await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25_000 });
  canvasEntered = true;
  await page.waitForTimeout(350);

  return { app, page, rendererErrors, userDataDir };
}

async function main() {
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);
  assert.ok(fs.existsSync(rendererHtml), `Missing compiled renderer HTML: ${rendererHtml}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-v15-phase6-smoke-'));
  let app1 = null;
  let app2 = null;

  try {
    // ── Session 1 (640x480): 6.1 Audio Waveform & Video+Audio Mux + 6.2 True CMYK TIFF/PSD + TAC ──
    const s1 = await launchIsolatedSession(tempRoot, 'session-audio-cmyk', 640, 480);
    app1 = s1.app;
    const { page } = s1;

    // Paint bold deep-black tile + stroke so CMYK TAC warning can trigger reliably
    await page.evaluate(() => {
      const dbg = window.__debugPixi;
      const layer = dbg.layerManager.getLayers()[0];
      const layerId = layer?.model?.id || layer?.id;
      if (!layerId) return;
      const tilePx = new Uint8Array(256 * 256 * 4);
      for (let i = 0; i < 256 * 256; i++) {
        tilePx[i * 4] = 4;
        tilePx[i * 4 + 1] = 4;
        tilePx[i * 4 + 2] = 4;
        tilePx[i * 4 + 3] = 255;
      }
      dbg.layerManager.applyTiles(layerId, [
        { col: 0, row: 0, width: 256, height: 256, data: tilePx, compression: 'raw' },
      ]);
    });
    await drawPenStroke(page, 140, 200, 460, 200, 1.0, 12);

    // === 6.1: Animation Timeline Audio Waveform Canvas + Mute + Audio Mix Export ===
    const wavPath = path.join(s1.userDataDir, 'phase6_tone.wav');
    fs.writeFileSync(wavPath, buildTestWavBuffer(0.5, 16000));

    await page.keyboard.press('Control+Shift+KeyA');
    await page.locator('[data-anim-timeline]').waitFor({ state: 'visible', timeout: 10_000 });
    const createAnimBtn = page.locator('[data-anim-timeline] button.atelier-btn--primary').first();
    if (await createAnimBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
      await createAnimBtn.click();
      await page.waitForTimeout(300);
    }

    await page.locator('[data-testid="timeline-audio-btn"]').click();
    await page.locator('[data-testid="audio-track-window"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="audio-track-window"] input[type="file"]').first().setInputFiles(wavPath);
    const waveformCanvas = page.locator('canvas[data-testid^="timeline-audio-waveform-"]').first();
    await waveformCanvas.waitFor({ state: 'visible', timeout: 10_000 });

    const waveCheck = await waveformCanvas.evaluate((el) => {
      const ctx = el.getContext('2d');
      const data = ctx.getImageData(0, 0, el.width, el.height).data;
      let litPixels = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 20) litPixels++;
      }
      return {
        peakCount: Number(el.dataset.peakCount || 0),
        muted: el.dataset.muted,
        litPixels,
      };
    });
    assert.ok(waveCheck.peakCount >= 8, `Expected waveform bars >= 8, got ${waveCheck.peakCount}`);
    assert.ok(waveCheck.litPixels > 30, `Expected non-empty waveform canvas pixels, got ${waveCheck.litPixels}`);
    assert.equal(waveCheck.muted, 'false');

    // Toggle inline mute on timeline & verify canvas reflects muted state
    const muteBtn = page.locator('[data-testid^="timeline-audio-mute-"]').first();
    await muteBtn.click();
    await page.waitForTimeout(150);
    assert.equal(await waveformCanvas.getAttribute('data-muted'), 'true');
    await muteBtn.click();
    await page.waitForTimeout(150);
    assert.equal(await waveformCanvas.getAttribute('data-muted'), 'false');
    await page.keyboard.press('Escape'); // close AudioTrackWindow

    // Open Animation Export Modal & export WebM with Audio Mix enabled
    await page.evaluate(() => { window.__capturedDownloads = []; });
    await page.locator('[data-testid="timeline-export-btn"]').click();
    await page.locator('[data-testid="anim-export-include-audio"]').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await page.locator('[data-testid="anim-export-include-audio"]').isChecked(), true);
    const audioStatusText = await page.locator('[data-testid="anim-export-audio-status"]').textContent();
    assert.match(audioStatusText || '', /1 audio track/i);

    await page.locator('[data-testid="anim-export-container-webm"]').click();
    await page.locator('[data-testid="anim-export-submit"]').click();
    await page.waitForFunction(
      () => Array.isArray(window.__capturedDownloads) && window.__capturedDownloads.some((d) => /\.(webm|mp4)$/i.test(d.name)),
      null,
      { timeout: 20_000 }
    );
    const videoCaptured = await page.evaluate(() =>
      window.__capturedDownloads.find((d) => /\.(webm|mp4)$/i.test(d.name))
    );
    assert.ok(videoCaptured && videoCaptured.size > 512, `Expected exported video > 512 bytes, got ${videoCaptured?.size}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    console.log(`✓ 6.1 Audio waveform (${waveCheck.peakCount} bars, ${waveCheck.litPixels} px) & video+audio export (${videoCaptured.name}, ${videoCaptured.size} B) verified`);

    // === 6.2: True CMYK 4-Channel TIFF & PSD Export + GCR/UCR + TAC Over-Limit Warning ===
    await page.evaluate(() => { window.__capturedDownloads = []; });
    await page.locator('header').getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: /Export \(PNG\/PSD\/ORA\/KRA\)/ }).click();
    await page.getByTestId('export-format-cmyk_tiff').click();
    await page.getByTestId('export-cmyk-panel').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByTestId('export-cmyk-tac-preview-canvas').waitFor({ state: 'visible', timeout: 8000 });

    // Switch GCR -> UCR, lower black strength & TAC limit to verify over-limit warning triggers
    await page.getByTestId('export-cmyk-mode-ucr').click();
    await setRangeValue(page.getByTestId('export-cmyk-black-strength'), 10);
    await setRangeValue(page.getByTestId('export-cmyk-tac-limit'), 215);
    await page.waitForTimeout(200);
    const tacOver = await page.getByTestId('export-cmyk-tac-warning').getAttribute('data-over-limit');
    assert.equal(tacOver, 'true', 'Expected TAC warning to trigger over-limit state on dark strokes at 215% limit');

    // Switch back to GCR and export CMYK TIFF
    await page.getByTestId('export-cmyk-mode-gcr').click();
    await setRangeValue(page.getByTestId('export-cmyk-black-strength'), 70);
    await setRangeValue(page.getByTestId('export-cmyk-tac-limit'), 300);
    await page.getByTestId('export-download').click();
    await page.waitForFunction(
      () => Array.isArray(window.__capturedDownloads) && window.__capturedDownloads.some((d) => d.name.endsWith('_CMYK.tif')),
      null,
      { timeout: 15_000 }
    );
    const tiffCaptured = await page.evaluate(() =>
      window.__capturedDownloads.find((d) => d.name.endsWith('_CMYK.tif'))
    );
    const tiffBuf = Buffer.from(tiffCaptured.base64, 'base64');
    const tiffTags = verifyTiffHeader(tiffBuf);
    assert.equal(tiffTags[256], 640);
    assert.equal(tiffTags[257], 480);

    // Export CMYK PSD from same modal
    await page.getByTestId('export-format-cmyk_psd').click();
    await page.getByTestId('export-download').click();
    await page.waitForFunction(
      () => Array.isArray(window.__capturedDownloads) && window.__capturedDownloads.some((d) => d.name.endsWith('_CMYK.psd')),
      null,
      { timeout: 15_000 }
    );
    const psdCaptured = await page.evaluate(() =>
      window.__capturedDownloads.find((d) => d.name.endsWith('_CMYK.psd'))
    );
    const psdBuf = Buffer.from(psdCaptured.base64, 'base64');
    const psdHdr = verifyCmykPsdHeader(psdBuf);
    assert.equal(psdHdr.width, 640);
    assert.equal(psdHdr.height, 480);

    await page.keyboard.press('Escape');
    assert.equal(s1.rendererErrors.length, 0, `Session 1 errors:\n${s1.rendererErrors.join('\n')}`);
    console.log(`✓ 6.2 CMYK TIFF (${tiffBuf.length} B, Photometric=5/4ch) & CMYK PSD (${psdBuf.length} B, ColorMode=4/4ch) + TAC warning verified`);

    await closeElectron(app1);
    app1 = null;

    // ── Session 2 (4K 4096x4096): 6.3 Large Canvas Tile GPU Texture LRU Pool & Budget Enforcement ──
    const s2 = await launchIsolatedSession(tempRoot, 'session-4k-lru', 4096, 4096);
    app2 = s2.app;
    const page4k = s2.page;

    // Paint several wide strokes across distinct 256px tiles on the 4K canvas
    await drawPenStroke(page4k, 200, 200, 1800, 1800, 1.0, 16);
    await drawPenStroke(page4k, 2200, 300, 3800, 1900, 1.0, 16);
    await drawPenStroke(page4k, 400, 2400, 3400, 3600, 1.0, 16);

    const lruCheck = await page4k.evaluate(async () => {
      const dbg = window.__debugPixi;
      const lm = dbg.layerManager;
      const before = lm.getTextureStats();
      // Zoom into top-left corner so lower/right tiles become offscreen, then tighten LRU tile ceiling
      lm.setViewportBounds({ x0: 0, y0: 0, x1: 512, y1: 512 });
      lm.setGpuTileBudget({ maxTiles: 16, maxMegabytes: 8, maxPooledAtlasPages: 1 });
      lm.enforceTileLruBudgetNow(true);
      await new Promise((r) => setTimeout(r, 350));
      lm.enforceTileLruBudgetNow(true);
      await new Promise((r) => setTimeout(r, 350));
      const after = lm.getTextureStats();
      const pipeline = dbg.tileEngine?.getPipelineStats?.() ?? null;
      return { before, after, pipeline };
    });

    assert.ok(lruCheck.before.tiles > 16, `Expected >16 active GPU tiles on 4K canvas before eviction, got ${lruCheck.before.tiles}`);
    assert.ok(lruCheck.before.lruBudgetTiles <= 1280, `4K canvas default LRU tile budget should be <=1280, got ${lruCheck.before.lruBudgetTiles}`);
    assert.ok(lruCheck.after.lruEvictions > 0, `Expected LRU evictions > 0 after tightening 4K tile ceiling, got ${lruCheck.after.lruEvictions}`);
    assert.ok(lruCheck.after.tiles < lruCheck.before.tiles, `Expected GPU tiles to drop (${lruCheck.before.tiles} -> ${lruCheck.after.tiles})`);
    assert.ok(lruCheck.after.coldTiles > 0, `Expected evicted offscreen tiles to spill into coldTiles (${lruCheck.after.coldTiles})`);
    assert.equal(s2.rendererErrors.length, 0, `Session 2 (4K) errors:\n${s2.rendererErrors.join('\n')}`);
    console.log(
      `✓ 6.3 4K Tile GPU LRU verified (tiles ${lruCheck.before.tiles} -> ${lruCheck.after.tiles}, ` +
      `coldTiles=${lruCheck.after.coldTiles}, lruEvictions=${lruCheck.after.lruEvictions}, ` +
      `atlasPages=${lruCheck.after.atlasPages}, pooledPages=${lruCheck.after.atlasPooledPages}, ` +
      `pboHits=${lruCheck.pipeline?.pboPoolHits ?? 'n/a'})`
    );
    console.log('ALL v1.5 Phase 6 ISOLATED ELECTRON SMOKE CHECKS PASSED! (0 console errors, 0 page errors)');
  } finally {
    if (app1) await closeElectron(app1);
    if (app2) await closeElectron(app2);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Isolated Electron Desktop Smoke Verification for Phase 5:
 * - 5.1 Procreate-style QuickShape (Settings enable & delay ms, hold-to-snap line + drag adjust,
 *   circle snap, single-step Ctrl+Z undo)
 * - 5.2 Puppet Warp (Ctrl+Alt+P launch, auto-mesh on non-transparent layer pixels, add 2 pins,
 *   drag pin + adjust rotation & weight, Enter apply, single-step Ctrl+Z restore)
 * - 5.3 Wrap-Around Seamless Mode (Alt+W & toolbar toggle, 3x3 view state, cross-edge brush stroke
 *   seamlessly wrapping right->left, single-step Ctrl+Z clearing both edges)
 * - Isolated PORT=0 ephemeral multiplayer 2-client Electron verification:
 *   Artist A & Artist B join the same canvas; Artist A performs Puppet Warp & Wrap-Around
 *   cross-boundary drawing (+ Ctrl+Z), and Artist B's live canvas accurately reflects all results.
 *
 * Strictly uses fresh temporary directories for APPDATA, LOCALAPPDATA, --user-data-dir,
 * and an ephemeral PORT=0 server with isolated DATA_DIR/DATABASE_PATH.
 * Never touches Port 3000 or the user's running desktop app.
 *
 * Usage:
 *   node apps/client/scripts/phase5-tools-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');

const electronExe = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startTempServer(dataDir) {
  const appModuleUrl = pathToFileURL(path.join(serverRoot, 'src/app.ts')).href;
  const tsxImportUrl = pathToFileURL(requireServer.resolve('tsx')).href;
  const launcherPath = path.join(dataDir, 'launch-temp-server.mjs');
  fs.writeFileSync(launcherPath, `
    import { buildApp } from ${JSON.stringify(appModuleUrl)};
    const app = await buildApp();
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    console.log('TEST_SERVER_READY=' + addr);
    process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
  `, 'utf8');
  const proc = spawn(process.execPath, ['--import', tsxImportUrl, launcherPath], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATABASE_PATH: path.join(dataDir, 'phase5-smoke.db'),
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
      JWT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Temp server start timed out')), 25_000);
    let stderrBuf = '';
    proc.stdout.on('data', (chunk) => {
      const match = chunk.toString('utf8').match(/TEST_SERVER_READY=(http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Temp server exited early (${code}): ${stderrBuf.slice(-400)}`));
    });
  });

  return { proc, url };
}

async function launchIsolated(userDataDir) {
  assert.ok(fs.existsSync(electronExe), `Missing Electron binary: ${electronExe}`);
  assert.ok(fs.existsSync(mainJs), `Missing compiled Electron main: ${mainJs}`);
  const app = await electron.launch({
    executablePath: electronExe,
    args: [mainJs, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, APPDATA: userDataDir, LOCALAPPDATA: userDataDir },
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
  if (await soloTab.isVisible({ timeout: 3000 }).catch(() => false)) await soloTab.click();
  const startBtn = page.getByRole('button', { name: '開始單機作畫', exact: true });
  if (await startBtn.isVisible({ timeout: 5000 }).catch(() => false)) await startBtn.click();
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
  await page.waitForFunction(() => Boolean(window.__debugPixi?.layerManager && window.__debugPixi?.tileEngine), { timeout: 15000 });
}

async function getCanvasDims(page) {
  return page.evaluate(() => {
    const dbg = window.__debugPixi;
    return {
      width: dbg.tileEngine.canvasWidth ?? dbg.viewport.canvasWidth ?? 1920,
      height: dbg.tileEngine.canvasHeight ?? dbg.viewport.canvasHeight ?? 1080,
    };
  });
}

async function setBrushColorAndSize(page, hex, sizeSteps = 4) {
  const input = page.locator('input[maxlength="7"]').first();
  if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
    await input.fill(hex);
    await input.press('Enter').catch(() => {});
    await input.blur().catch(() => {});
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('KeyB');
  for (let i = 0; i < sizeSteps; i++) {
    await page.keyboard.press('BracketRight');
  }
  await sleep(150);
}

/** Counts opaque pixels (alpha >= minAlpha) in a canvas-coordinate rectangle on the composite layer texture (no background). */
async function countOpaquePixelsInRect(page, x, y, w, h, minAlpha = 30) {
  return page.evaluate(async ({ x, y, w, h, minAlpha }) => {
    const dbg = window.__debugPixi;
    const cw = dbg.tileEngine.canvasWidth ?? dbg.viewport.canvasWidth;
    const ch = dbg.tileEngine.canvasHeight ?? dbg.viewport.canvasHeight;
    const rx = Math.max(0, Math.min(cw - 1, Math.floor(x)));
    const ry = Math.max(0, Math.min(ch - 1, Math.floor(y)));
    const rw = Math.max(1, Math.min(cw - rx, Math.ceil(w)));
    const rh = Math.max(1, Math.min(ch - ry, Math.ceil(h)));
    const rt = dbg.layerManager.getCompositeTexture(false);
    const [pixels] = await dbg.tileEngine.readRegionsAsync(rt, [{ x: rx, y: ry, w: rw, h: rh }]);
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] >= minAlpha) count++;
    }
    return count;
  }, { x, y, w, h, minAlpha });
}

async function waitForOpaquePixels(page, x, y, w, h, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await countOpaquePixelsInRect(page, x, y, w, h);
    if (predicate(last)) return last;
    await sleep(180);
  }
  throw new Error(`Timed out waiting for pixel condition at (${x},${y},${w}x${h}); last count=${last}`);
}

/** Dispatches a multi-point pointer stroke on the canvas; optionally holds at the end and drags to adjust. */
async function drawPathOnCanvas(page, points, opts = {}) {
  const { holdMs = 0, adjustTo = null, stepDelayMs = 12, pointerId = 61 } = opts;
  await page.evaluate(async ({ points, holdMs, adjustTo, stepDelayMs, pointerId }) => {
    const dbg = window.__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
    const rect = dbg.app.canvas.getBoundingClientRect();
    const toClient = ([cx, cy]) => {
      const s = dbg.viewport.canvasToScreen(cx, cy);
      return { x: rect.left + s.x, y: rect.top + s.y };
    };
    const fire = (type, pt, buttons) => {
      const c = toClient(pt);
      surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: c.x,
        clientY: c.y,
        button: 0,
        buttons,
        pressure: buttons ? 0.85 : 0,
      }));
    };
    fire('pointerdown', points[0], 1);
    for (let i = 1; i < points.length; i++) {
      await new Promise((r) => setTimeout(r, stepDelayMs));
      fire('pointermove', points[i], 1);
    }
    if (holdMs > 0) {
      await new Promise((r) => setTimeout(r, holdMs));
    }
    if (adjustTo) {
      const last = points[points.length - 1];
      for (let s = 1; s <= 4; s++) {
        const t = s / 4;
        fire('pointermove', [last[0] + (adjustTo[0] - last[0]) * t, last[1] + (adjustTo[1] - last[1]) * t], 1);
        await new Promise((r) => setTimeout(r, 25));
      }
      fire('pointerup', adjustTo, 0);
    } else {
      fire('pointerup', points[points.length - 1], 0);
    }
  }, { points, holdMs, adjustTo, stepDelayMs, pointerId });
  await sleep(300);
}

async function canvasToClientPoint(page, cx, cy) {
  return page.evaluate(({ cx, cy }) => {
    const dbg = window.__debugPixi;
    const rect = dbg.app.canvas.getBoundingClientRect();
    const s = dbg.viewport.canvasToScreen(cx, cy);
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, { cx, cy });
}

async function runSoloVerification() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase5-solo-'));
  const userDataDir = path.join(tempRoot, 'electron-data');
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[Phase 5 Solo Electron] Isolated tempRoot: ${tempRoot}`);
  let app = null;
  try {
    const launched = await launchIsolated(userDataDir);
    app = launched.app;
    const { page, pageErrors } = launched;

    await enterOfflineCanvas(page);
    await sleep(350);
    const dims = await getCanvasDims(page);
    await setBrushColorAndSize(page, '#E11D48', 5);

    // =========================================================================
    // 1. 5.1 QuickShape: Settings customization, hold-to-snap line + drag adjust, circle, Ctrl+Z
    // =========================================================================
    await page.getByRole('button', { name: /設定|Settings/i }).first().click();
    const qsToggle = page.getByTestId('quickshape-enabled-toggle');
    await qsToggle.waitFor({ state: 'visible', timeout: 6000 });
    assert.equal(await qsToggle.isChecked(), true, 'QuickShape should be enabled by default');
    const qsDelay = page.getByTestId('quickshape-delay-input');
    await qsDelay.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '220');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(120);
    await page.keyboard.press('Escape');
    await qsToggle.waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => {
      const closeBtn = page.getByRole('button', { name: /關閉|Close|✕/i }).first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
    });
    await sleep(200);

    // Draw slightly wobbly horizontal line, hold 340ms to snap, verify badge appears, drag endpoint down, release
    const linePts = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const wobble = Math.sin(t * Math.PI * 2) * 3.5;
      linePts.push([260 + t * 300, 260 + wobble]);
    }
    await page.evaluate(async ({ linePts }) => {
      const dbg = window.__debugPixi;
      const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
      const rect = dbg.app.canvas.getBoundingClientRect();
      const fire = (type, [cx, cy], buttons) => {
        const s = dbg.viewport.canvasToScreen(cx, cy);
        surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 71, pointerType: 'mouse', isPrimary: true,
          clientX: rect.left + s.x, clientY: rect.top + s.y, button: 0, buttons, pressure: buttons ? 0.85 : 0,
        }));
      };
      fire('pointerdown', linePts[0], 1);
      for (let i = 1; i < linePts.length; i++) {
        await new Promise((r) => setTimeout(r, 12));
        fire('pointermove', linePts[i], 1);
      }
    }, { linePts });

    const qsBadge = page.getByTestId('quickshape-badge');
    await qsBadge.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await qsBadge.getAttribute('data-shape-kind'), 'line', 'Expected QuickShape to recognize line');

    // Drag adjusted endpoint down to (560, 420) and release
    await page.evaluate(async () => {
      const dbg = window.__debugPixi;
      const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
      const rect = dbg.app.canvas.getBoundingClientRect();
      const fire = (type, [cx, cy], buttons) => {
        const s = dbg.viewport.canvasToScreen(cx, cy);
        surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 71, pointerType: 'mouse', isPrimary: true,
          clientX: rect.left + s.x, clientY: rect.top + s.y, button: 0, buttons, pressure: buttons ? 0.85 : 0,
        }));
      };
      fire('pointermove', [560, 340], 1);
      await new Promise((r) => setTimeout(r, 30));
      fire('pointermove', [560, 420], 1);
      await new Promise((r) => setTimeout(r, 30));
      fire('pointerup', [560, 420], 0);
    });
    await qsBadge.waitFor({ state: 'hidden', timeout: 3000 });
    await sleep(350);

    // Midpoint of adjusted line from (260,260) to (560,420) is (410, 340)
    const adjustedLinePx = await countOpaquePixelsInRect(page, 390, 320, 40, 40);
    assert.ok(adjustedLinePx > 20, `Expected snapped & adjusted QuickShape line pixels near (410,340), got ${adjustedLinePx}`);

    // Ctrl+Z single-step undo must completely clear QuickShape line
    await page.keyboard.press('Control+KeyZ');
    await waitForOpaquePixels(page, 220, 220, 380, 240, (c) => c === 0, 5000);

    // Draw closed circle and hold to verify circle recognition + commit + Ctrl+Z
    const circlePts = [];
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      circlePts.push([460 + Math.cos(a) * 110, 420 + Math.sin(a) * 110]);
    }
    await page.evaluate(async ({ circlePts }) => {
      const dbg = window.__debugPixi;
      const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
      const rect = dbg.app.canvas.getBoundingClientRect();
      const fire = (type, [cx, cy], buttons) => {
        const s = dbg.viewport.canvasToScreen(cx, cy);
        surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 72, pointerType: 'mouse', isPrimary: true,
          clientX: rect.left + s.x, clientY: rect.top + s.y, button: 0, buttons, pressure: buttons ? 0.85 : 0,
        }));
      };
      fire('pointerdown', circlePts[0], 1);
      for (let i = 1; i < circlePts.length; i++) {
        await new Promise((r) => setTimeout(r, 10));
        fire('pointermove', circlePts[i], 1);
      }
    }, { circlePts });
    await qsBadge.waitFor({ state: 'visible', timeout: 3000 });
    const circleKind = await qsBadge.getAttribute('data-shape-kind');
    assert.ok(circleKind === 'circle' || circleKind === 'ellipse', `Expected circle/ellipse snap, got ${circleKind}`);
    await page.evaluate(({ pt }) => {
      const dbg = window.__debugPixi;
      const surface = document.querySelector('.atelier-canvas-viewport') || dbg.app.canvas;
      const rect = dbg.app.canvas.getBoundingClientRect();
      const s = dbg.viewport.canvasToScreen(pt[0], pt[1]);
      surface.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 72, pointerType: 'mouse', isPrimary: true,
        clientX: rect.left + s.x, clientY: rect.top + s.y, button: 0, buttons: 0, pressure: 0,
      }));
    }, { pt: circlePts[circlePts.length - 1] });
    await sleep(350);
    await page.keyboard.press('Control+KeyZ');
    await waitForOpaquePixels(page, 300, 260, 320, 320, (c) => c === 0, 5000);
    console.log('  ✓ 5.1 QuickShape verified (settings delay, line hold-snap + drag adjust, circle snap, Ctrl+Z restore)');

    // =========================================================================
    // 2. 5.2 Puppet Warp: paint vertical bar, Ctrl+Alt+P, add 2 pins, drag + rotate + weight, Enter, Ctrl+Z
    // =========================================================================
    // Paint a sturdy vertical bar at x=420, y=220..560
    await drawPathOnCanvas(page, [[420, 220], [420, 300], [420, 390], [420, 480], [420, 560]], { pointerId: 73 });
    const barBeforeBottom = await countOpaquePixelsInRect(page, 385, 500, 70, 80);
    assert.ok(barBeforeBottom > 80, `Expected painted vertical bar before Puppet Warp, got ${barBeforeBottom}`);
    const rightRegionBefore = await countOpaquePixelsInRect(page, 560, 480, 120, 120);
    assert.equal(rightRegionBefore, 0, 'Target warp destination must start empty');

    await page.keyboard.press('Control+Alt+KeyP');
    const pwOverlay = page.getByTestId('puppet-warp-overlay');
    await pwOverlay.waitFor({ state: 'visible', timeout: 8000 });
    await sleep(250);

    // Click to place Pin 1 at top of bar (420, 240) and Pin 2 at bottom of bar (420, 540)
    const pTop = await canvasToClientPoint(page, 420, 240);
    const pBot = await canvasToClientPoint(page, 420, 540);
    const pBotTarget = await canvasToClientPoint(page, 620, 540);
    await page.mouse.click(pTop.x, pTop.y);
    await sleep(120);
    await page.mouse.click(pBot.x, pBot.y);
    await sleep(120);
    assert.equal(await page.getByTestId('puppet-warp-pin').count(), 2, 'Expected 2 Puppet Warp pins');

    // Drag Pin 2 rightward to (620, 540)
    await page.mouse.move(pBot.x, pBot.y);
    await page.mouse.down();
    await page.mouse.move((pBot.x + pBotTarget.x) / 2, pBotTarget.y, { steps: 5 });
    await page.mouse.move(pBotTarget.x, pBotTarget.y, { steps: 5 });
    await page.mouse.up();
    await sleep(180);

    // Adjust selected pin rotation and weight via action bar controls
    const rotInput = page.getByTestId('puppet-warp-rotation-input');
    await rotInput.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '15');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const weightInput = page.getByTestId('puppet-warp-weight-input');
    await weightInput.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '1.5');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);

    // Confirm with Enter
    await page.mouse.click(pTop.x - 120, pTop.y); // blur range input so Enter confirms overlay
    await page.keyboard.press('Enter');
    await pwOverlay.waitFor({ state: 'hidden', timeout: 8000 });
    await sleep(450);

    const rightRegionAfter = await countOpaquePixelsInRect(page, 560, 480, 120, 120);
    assert.ok(rightRegionAfter > 40, `Expected Puppet Warp pixels moved to right region, got ${rightRegionAfter}`);

    // Ctrl+Z single-step undo restores pre-warp vertical bar
    await page.keyboard.press('Control+KeyZ');
    await waitForOpaquePixels(page, 560, 480, 120, 120, (c) => c === 0, 5000);
    const barRestoredBottom = await countOpaquePixelsInRect(page, 385, 500, 70, 80);
    assert.ok(barRestoredBottom > 80, `Expected pre-warp bar restored after Ctrl+Z, got ${barRestoredBottom}`);

    // Undo the original bar too so canvas is clean for 5.3
    await page.keyboard.press('Control+KeyZ');
    await waitForOpaquePixels(page, 360, 180, 120, 420, (c) => c === 0, 5000);
    console.log('  ✓ 5.2 Puppet Warp verified (Ctrl+Alt+P, 2 pins, drag + rotation + weight, Enter commit, Ctrl+Z restore)');

    // =========================================================================
    // 3. 5.3 Wrap-Around Seamless Mode: Alt+W toggle, cross-edge stroke, Ctrl+Z
    // =========================================================================
    const wrapBtn = page.getByTestId('viewport-wrap-around-toggle');
    await wrapBtn.waitFor({ state: 'visible', timeout: 6000 });
    assert.equal(await wrapBtn.getAttribute('aria-pressed'), 'false', 'Wrap-Around should start disabled');

    await page.keyboard.press('Alt+KeyW');
    await sleep(200);
    assert.equal(await wrapBtn.getAttribute('aria-pressed'), 'true', 'Alt+W must enable Wrap-Around mode');
    const engineWrapOn = await page.evaluate(() => window.__debugPixi.layerManager.isWrapAroundEnabled());
    assert.equal(engineWrapOn, true, 'LayerManager wrap-around flag must be true');

    // Zoom out slightly so the right boundary & 3x3 neighbor are comfortably on-screen
    await page.evaluate(() => {
      const dbg = window.__debugPixi;
      dbg.viewport.setZoom(dbg.viewport.getState().zoom * 0.65);
    });
    await sleep(200);

    // Draw stroke crossing right edge (width - 35 -> width + 35) at y = 320
    const edgeY = Math.round(dims.height * 0.35);
    await drawPathOnCanvas(page, [
      [dims.width - 35, edgeY],
      [dims.width - 10, edgeY],
      [dims.width + 10, edgeY],
      [dims.width + 35, edgeY],
    ], { pointerId: 74 });

    const rightEdgePx = await countOpaquePixelsInRect(page, dims.width - 35, edgeY - 25, 35, 50);
    const wrappedLeftPx = await countOpaquePixelsInRect(page, 0, edgeY - 25, 35, 50);
    assert.ok(rightEdgePx > 25, `Expected stroke pixels on right edge, got ${rightEdgePx}`);
    assert.ok(wrappedLeftPx > 25, `Expected seamlessly wrapped stroke pixels on left edge, got ${wrappedLeftPx}`);

    // Ctrl+Z single-step undo removes BOTH right-edge and left-edge wrapped pixels
    await page.keyboard.press('Control+KeyZ');
    await waitForOpaquePixels(page, dims.width - 35, edgeY - 25, 35, 50, (c) => c === 0, 5000);
    await waitForOpaquePixels(page, 0, edgeY - 25, 35, 50, (c) => c === 0, 5000);

    await wrapBtn.click();
    await sleep(150);
    assert.equal(await wrapBtn.getAttribute('aria-pressed'), 'false', 'Clicking Wrap-Around toggle must disable it');
    console.log('  ✓ 5.3 Wrap-Around verified (Alt+W toggle, 3x3 layer flag, cross-edge right->left wrap, Ctrl+Z clears both sides)');

    assert.deepEqual(pageErrors, [], `Unexpected solo page errors: ${pageErrors.join(' | ')}`);
  } finally {
    if (app) await app.close().catch(() => {});
    await sleep(400);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function loginAndOpenMpWindow(userDataDir, serverUrl, token, user) {
  const launched = await launchIsolated(userDataDir);
  const { page } = launched;
  await page.evaluate(({ url, jwt, user }) => {
    localStorage.setItem('atelier_server_url', url);
    localStorage.setItem('atelier_gateway_resolved', 'true');
    localStorage.setItem('atelier_gateway_skip_on_launch', 'true');
    localStorage.setItem(`atelier_token:${url}`, jwt);
    localStorage.setItem('atelier_token', jwt);
    localStorage.setItem('atelier_user', JSON.stringify(user));
  }, { url: serverUrl, jwt: token, user });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25000 });
  await page.waitForFunction(() => Boolean(window.__debugPixi?.layerManager && window.__debugPixi?.tileEngine), { timeout: 15000 });
  await sleep(400);
  return launched;
}

async function runMultiplayerTwoClientVerification() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-phase5-mp-'));
  const dataDir = path.join(tempRoot, 'server-data');
  const userDirA = path.join(tempRoot, 'electron-artist-a');
  const userDirB = path.join(tempRoot, 'electron-artist-b');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDirA, { recursive: true });
  fs.mkdirSync(userDirB, { recursive: true });

  console.log(`[Phase 5 MP 2-Client Electron] Isolated tempRoot: ${tempRoot}`);
  let serverProc = null;
  let appA = null;
  let appB = null;
  try {
    const server = await startTempServer(dataDir);
    serverProc = server.proc;
    console.log(`  ✓ Ephemeral PORT=0 server ready at ${server.url}`);

    // Artist A: seeded admin
    const loginA = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(loginA.status, 200);
    const authA = await loginA.json();

    // Artist B: second authenticated painter account
    const regB = await fetch(`${server.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'painter_b', password: 'Password123!', displayName: '畫友 B' }),
    });
    assert.ok(regB.status === 200 || regB.status === 201, `Register Artist B failed: ${regB.status}`);
    const authB = await regB.json();

    // Launch both isolated Electron clients onto the same canvas
    const winA = await loginAndOpenMpWindow(userDirA, server.url, authA.token, authA.user);
    appA = winA.app;
    const winB = await loginAndOpenMpWindow(userDirB, server.url, authB.token, authB.user);
    appB = winB.app;
    const { page: pageA, pageErrors: errorsA } = winA;
    const { page: pageB, pageErrors: errorsB } = winB;

    const dims = await getCanvasDims(pageA);
    await setBrushColorAndSize(pageA, '#2563EB', 5);

    // 1. Artist A paints a vertical bar and Puppet Warps the bottom pin rightward -> Artist B sees warped pixels!
    await drawPathOnCanvas(pageA, [[420, 220], [420, 340], [420, 460], [420, 560]], { pointerId: 81 });
    await waitForOpaquePixels(pageB, 385, 490, 70, 90, (c) => c > 60, 10000);

    await pageA.keyboard.press('Control+Alt+KeyP');
    const pwOverlayA = pageA.getByTestId('puppet-warp-overlay');
    await pwOverlayA.waitFor({ state: 'visible', timeout: 8000 });
    await sleep(250);

    const pTop = await canvasToClientPoint(pageA, 420, 240);
    const pBot = await canvasToClientPoint(pageA, 420, 540);
    const pBotTarget = await canvasToClientPoint(pageA, 630, 540);
    await pageA.mouse.click(pTop.x, pTop.y);
    await sleep(120);
    await pageA.mouse.click(pBot.x, pBot.y);
    await sleep(120);
    await pageA.mouse.move(pBot.x, pBot.y);
    await pageA.mouse.down();
    await pageA.mouse.move(pBotTarget.x, pBotTarget.y, { steps: 6 });
    await pageA.mouse.up();
    await sleep(180);
    await pageA.keyboard.press('Enter');
    await pwOverlayA.waitFor({ state: 'hidden', timeout: 8000 });

    const peerWarpedPx = await waitForOpaquePixels(pageB, 565, 480, 120, 120, (c) => c > 40, 12000);
    assert.ok(peerWarpedPx > 40, `Expected Artist B to receive Puppet Warp pixels, got ${peerWarpedPx}`);
    console.log(`  ✓ Multiplayer Puppet Warp synced to Artist B (${peerWarpedPx} warped pixels observed)`);

    // 2. Artist A enables Wrap-Around (Alt+W) and draws across right edge -> Artist B sees BOTH edges!
    await pageA.keyboard.press('Alt+KeyW');
    await sleep(200);
    await pageA.evaluate(() => {
      const dbg = window.__debugPixi;
      dbg.viewport.setZoom(dbg.viewport.getState().zoom * 0.65);
    });
    await sleep(200);

    const edgeY = Math.round(dims.height * 0.25);
    await drawPathOnCanvas(pageA, [
      [dims.width - 35, edgeY],
      [dims.width - 10, edgeY],
      [dims.width + 10, edgeY],
      [dims.width + 35, edgeY],
    ], { pointerId: 82 });

    const peerRightPx = await waitForOpaquePixels(pageB, dims.width - 35, edgeY - 25, 35, 50, (c) => c > 20, 12000);
    const peerLeftPx = await waitForOpaquePixels(pageB, 0, edgeY - 25, 35, 50, (c) => c > 20, 12000);
    assert.ok(peerRightPx > 20 && peerLeftPx > 20, `Expected Artist B to receive wrapped stroke on both edges (right=${peerRightPx}, left=${peerLeftPx})`);
    console.log(`  ✓ Multiplayer Wrap-Around cross-edge stroke synced to Artist B (right=${peerRightPx}px, wrapped left=${peerLeftPx}px)`);

    // 3. Artist A presses Ctrl+Z -> Artist B sees BOTH edges reverted cleanly!
    await pageA.keyboard.press('Control+KeyZ');
    await waitForOpaquePixels(pageB, dims.width - 35, edgeY - 25, 35, 50, (c) => c === 0, 10000);
    await waitForOpaquePixels(pageB, 0, edgeY - 25, 35, 50, (c) => c === 0, 10000);
    console.log('  ✓ Multiplayer Wrap-Around Ctrl+Z undo synced cleanly to Artist B');

    assert.deepEqual(errorsA, [], `Unexpected Artist A page errors: ${errorsA.join(' | ')}`);
    assert.deepEqual(errorsB, [], `Unexpected Artist B page errors: ${errorsB.join(' | ')}`);
  } finally {
    if (appB) await appB.close().catch(() => {});
    if (appA) await appA.close().catch(() => {});
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await sleep(300);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  await runSoloVerification();
  await runMultiplayerTwoClientVerification();
  console.log('\n🎉 ALL PHASE 5 ISOLATED ELECTRON & 2-CLIENT MULTIPLAYER SMOKE CHECKS PASSED!\n');
}

main().catch((err) => {
  console.error('❌ Phase 5 Electron smoke failed:', err);
  process.exit(1);
});

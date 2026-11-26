/**
 * v1.5 Workspace Enhancement Electron smoke check for Floating Pill / Capsule Dock:
 *   - Smooth v4 -> v5 layout migration without losing floating or docked panels
 *   - Minimize single floating window to circular icon pill + drag positioning
 *   - Merge pills magnetically into an auto-elongating multi-panel capsule
 *   - Toggle horizontal <-> vertical capsule orientation
 *   - Click individual icon inside capsule to expand and switch active tab
 *   - Drag single icon out of multi-panel capsule onto blank canvas to detach as a new pill
 *   - Merge multi-panel capsule into another pill + drag icon to dock (full DnD interop)
 *   - Zero console errors and zero page errors
 *
 * Build @atelier/client and Electron first, then run from the repo root:
 *   node apps/client/scripts/v15-dock-pills-electron-smoke.check.cjs
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');

const clientRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(__dirname, '../../server');
const requireClient = createRequire(path.join(clientRoot, 'package.json'));
const requireServer = createRequire(path.join(serverRoot, 'package.json'));
const { _electron: electron } = requireServer('playwright-core');
const electronExe = requireClient('electron');
const mainJs = path.join(clientRoot, 'dist-electron/main.js');
const rendererHtml = path.join(clientRoot, 'dist/index.html');
const tempPrefix = 'atelier-v15-dock-pills-';
const actionTimeout = 12_000;

function hasExited(child) {
  return !child?.pid || child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeout) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeout);
    child.once('exit', onExit);
  });
}

async function forceStop(child, label) {
  if (hasExited(child)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 5_000,
    });
  } else {
    child.kill('SIGKILL');
  }
  assert.ok(await waitForExit(child, 5_000), `${label} process did not exit during cleanup`);
}

async function closeElectron(app) {
  const child = app.process();
  const closed = app.close().then(() => true, () => false);
  if (await waitForExit(child, 8_000)) return;
  await forceStop(child, 'Electron');
  assert.ok(await Promise.race([closed, delay(2_000, false)]), 'Electron did not close cleanly');
}

async function launchIsolated(tempRoot, apps, rendererErrors, label) {
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, `electron-${label}-`));
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
        await this.loadURL('data:text/html,<title>Smoke startup</title>');
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
  const app = await electron.launch({
    executablePath: electronExe,
    args,
    env,
    artifactsDir: userDataDir,
    timeout: 25_000,
  });
  apps.push(app);
  const context = app.context();
  context.on('console', (message) => {
    if (message.type() === 'error') {
      const { url, lineNumber } = message.location();
      rendererErrors.push(`${label} console error at ${url || '(renderer)'}:${lineNumber}: ${message.text()}`);
    }
  });
  context.on('weberror', (event) => {
    rendererErrors.push(`${label} pageerror: ${event.error().message}`);
  });
  const page = await app.firstWindow({ timeout: 25_000 });
  page.setDefaultTimeout(actionTimeout);
  await page.setViewportSize({ width: 1440, height: 900 });
  return { app, page };
}

async function openRenderer({ app, page }, storage) {
  const url = pathToFileURL(rendererHtml).href;
  await page.addInitScript(({ url, storage }) => {
    if (location.href !== url) return;
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, { url, storage: { atelier_language: 'en-US', ...storage } });
  await app.evaluate(() => globalThis.startSmokeRenderer());
  await page.waitForURL(url, { waitUntil: 'domcontentloaded' });
}

async function dragPointer(page, fromX, fromY, toX, toY, steps = 16) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
    await delay(12);
  }
  await page.mouse.up();
  await delay(120);
}

async function centerOf(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, 'Expected element bounding box to exist');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function run() {
  assert.ok(fs.existsSync(mainJs), `Missing Electron main build: ${mainJs}`);
  assert.ok(fs.existsSync(rendererHtml), `Missing renderer build: ${rendererHtml}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  const apps = [];
  const rendererErrors = [];

  // Pre-seed a v4 dock layout so we also verify smooth v4 -> v5 migration in Electron
  const v4Layout = {
    version: 4,
    panels: {
      color: { visible: true, place: 'float', collapsed: false, weight: 1.28, float: { x: 180, y: 120, w: 280, h: 430 }, group: 'color' },
      subView: { visible: true, place: 'float', collapsed: false, weight: 1, float: { x: 180, y: 560, w: 280, h: 280 }, group: 'subView' },
      autoActions: { visible: false, place: 'left', collapsed: false, weight: 1, float: { x: 120, y: 140, w: 300, h: 420 }, group: 'autoActions' },
      brushToolset: { visible: true, place: 'right', collapsed: false, weight: 1, float: { x: 160, y: 140, w: 280, h: 420 }, group: 'toolProps' },
      toolProps: { visible: true, place: 'right', collapsed: false, weight: 1, float: { x: 160, y: 140, w: 280, h: 420 }, group: 'toolProps' },
      layers: { visible: true, place: 'float', collapsed: false, weight: 1.05, float: { x: 540, y: 120, w: 300, h: 420 }, group: 'layers' },
      members: { visible: false, place: 'float', collapsed: false, weight: 1, float: { x: -1, y: 96, w: 280, h: 340 }, group: 'members' },
      oplog: { visible: false, place: 'bottom', collapsed: false, weight: 1, float: { x: 240, y: 200, w: 320, h: 260 }, group: 'oplog' },
      quickKeys: { visible: false, place: 'left', collapsed: false, weight: 1, float: { x: 80, y: 140, w: 240, h: 320 }, group: 'quickKeys' },
      filters: { visible: false, place: 'float', collapsed: false, weight: 1, float: { x: -352, y: 96, w: 340, h: 420 }, group: 'filters' },
      align: { visible: false, place: 'float', collapsed: false, weight: 1, float: { x: -304, y: 132, w: 280, h: 420 }, group: 'align' },
    },
    order: ['color', 'subView', 'autoActions', 'brushToolset', 'toolProps', 'layers', 'members', 'oplog', 'quickKeys', 'filters', 'align'],
    dockSize: { left: 260, right: 300, bottom: 190 },
    activeTab: {},
    desktopMode: false,
    railSide: 'left',
    slidersWidth: 44,
    toolRailWidth: 46,
  };

  try {
    const client = await launchIsolated(tempRoot, apps, rendererErrors, 'dock-pills');
    const { page } = client;
    await openRenderer(client, {
      atelier_session_mode: 'offline',
      atelier_dock_layout: JSON.stringify(v4Layout),
    });

    // Enter offline solo workspace
    await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
    await page.getByRole('button', { name: 'Custom Size', exact: true }).click();
    await page.getByRole('spinbutton', { name: /^Width/ }).fill('800');
    await page.getByRole('spinbutton', { name: /^Height/ }).fill('600');
    await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
    await page.locator('[data-canvas-presented="true"]').waitFor({ timeout: 25_000 });

    // 1. Verify v4 -> v5 migration preserved floating windows & docked panels (and docked panels have NO minimize-pill button)
    await page.locator('[data-float-group="color"]:not([data-float-pill])').waitFor();
    await page.locator('[data-float-group="layers"]:not([data-float-pill])').waitFor();
    await page.locator('[data-float-group="subView"]:not([data-float-pill])').waitFor();
    await page.locator('[data-dock-side="right"]').waitFor();
    const dockedMinimizeCount = await page.locator('[data-dock-side="right"] [data-dock-minimize-pill]').count();
    assert.equal(dockedMinimizeCount, 0, 'Docked panels must not show minimize-to-pill button');

    // 2. Single window -> minimize to circular pill + drag repositioning
    await page.locator('[data-dock-minimize-pill="color"]').click();
    const colorPill = page.locator('[data-float-pill="color"]');
    await colorPill.waitFor();
    assert.equal(await colorPill.getAttribute('data-pill-count'), '1');
    const colorPillStart = await centerOf(colorPill);
    assert.ok(
      Math.abs(colorPillStart.box.width - colorPillStart.box.height) <= 2,
      `Single pill should be circular, got ${colorPillStart.box.width}x${colorPillStart.box.height}`,
    );

    // Drag color pill to new empty position
    const colorBtn = colorPill.locator('[data-pill-panel="color"]');
    const colorBtnPos = await centerOf(colorBtn);
    await dragPointer(page, colorBtnPos.x, colorBtnPos.y, colorBtnPos.x + 90, colorBtnPos.y + 70);
    const colorPillMoved = await centerOf(colorPill);
    assert.ok(colorPillMoved.box.x > colorPillStart.box.x + 50, 'Single pill should reposition after drag');
    assert.ok(colorPillMoved.box.y > colorPillStart.box.y + 40, 'Single pill Y should reposition after drag');

    // 3. Minimize layers window -> pill, then magnetically merge color pill into layers pill
    await page.locator('[data-dock-minimize-pill="layers"]').click();
    const layersPill = page.locator('[data-float-pill="layers"]');
    await layersPill.waitFor();
    assert.equal(await layersPill.getAttribute('data-pill-count'), '1');
    const singleLayersBox = (await centerOf(layersPill)).box;

    const colorDragCenter = await centerOf(colorPill.locator('[data-pill-panel="color"]'));
    const layersTargetCenter = await centerOf(layersPill);
    await dragPointer(page, colorDragCenter.x, colorDragCenter.y, layersTargetCenter.x, layersTargetCenter.y);

    // Verify merged capsule auto-elongates horizontally
    await page.waitForFunction(() => document.querySelector('[data-float-pill="layers"]')?.getAttribute('data-pill-count') === '2');
    assert.equal(await page.locator('[data-float-pill="color"]').count(), 0, 'Source pill should disappear after merge');
    await layersPill.locator('[data-pill-panel="layers"]').waitFor();
    await layersPill.locator('[data-pill-panel="color"]').waitFor();
    assert.equal(await layersPill.getAttribute('data-pill-orientation'), 'horizontal');
    const horizCapsuleBox = (await centerOf(layersPill)).box;
    assert.ok(
      horizCapsuleBox.width > singleLayersBox.width + 30,
      `Merged horizontal capsule should elongate (${horizCapsuleBox.width} vs ${singleLayersBox.width})`,
    );
    assert.ok(horizCapsuleBox.width > horizCapsuleBox.height, 'Horizontal capsule width should exceed height');

    // 4. Toggle orientation horizontal -> vertical -> horizontal
    await layersPill.locator('[data-pill-toggle-orientation="layers"]').click();
    await page.waitForFunction(() => document.querySelector('[data-float-pill="layers"]')?.getAttribute('data-pill-orientation') === 'vertical');
    const vertCapsuleBox = (await centerOf(layersPill)).box;
    assert.ok(
      vertCapsuleBox.height > vertCapsuleBox.width,
      `Vertical capsule height should exceed width (${vertCapsuleBox.width}x${vertCapsuleBox.height})`,
    );

    await layersPill.locator('[data-pill-toggle-orientation="layers"]').click();
    await page.waitForFunction(() => document.querySelector('[data-float-pill="layers"]')?.getAttribute('data-pill-orientation') === 'horizontal');

    // 5. Click specific icon inside capsule -> expand and switch active tab
    await layersPill.locator('[data-pill-panel="layers"]').click();
    const expandedGroup = page.locator('[data-float-group="layers"]:not([data-float-pill])');
    await expandedGroup.waitFor();
    assert.equal(await page.locator('[data-float-pill="layers"]').count(), 0, 'Capsule should disappear once expanded');
    const selectedTab1 = await expandedGroup.locator('[role="tab"][aria-selected="true"]').textContent();
    assert.match(selectedTab1 || '', /Layers/i, `Expected Layers tab active, got: ${selectedTab1}`);

    // Re-minimize and click Color icon -> expand with Color active
    await expandedGroup.locator('[data-dock-minimize-pill="layers"]').click();
    await layersPill.waitFor();
    await layersPill.locator('[data-pill-panel="color"]').click();
    await expandedGroup.waitFor();
    const selectedTab2 = await expandedGroup.locator('[role="tab"][aria-selected="true"]').textContent();
    assert.match(selectedTab2 || '', /Color/i, `Expected Color tab active, got: ${selectedTab2}`);

    // 6. Drag single icon out of multi-window capsule onto blank area -> detach into new standalone pill
    await expandedGroup.locator('[data-dock-minimize-pill="layers"]').click();
    await layersPill.waitFor();
    const colorIconInCapsule = await centerOf(layersPill.locator('[data-pill-panel="color"]'));
    await dragPointer(page, colorIconInCapsule.x, colorIconInCapsule.y, 440, 420);

    await page.locator('[data-float-pill="color"]').waitFor();
    assert.equal(await page.locator('[data-float-pill="color"]').getAttribute('data-pill-count'), '1');
    assert.equal(await layersPill.getAttribute('data-pill-count'), '1', 'Original capsule should shrink back to single pill');
    const detachedBox = (await centerOf(page.locator('[data-float-pill="color"]'))).box;
    assert.ok(Math.abs(detachedBox.width - detachedBox.height) <= 2, 'Detached pill should be circular');

    // 7. Full DnD interop: merge 3rd panel + merge capsule-onto-pill + dock icon from capsule to right dock
    await page.locator('[data-dock-minimize-pill="subView"]').click();
    const subViewPill = page.locator('[data-float-pill="subView"]');
    await subViewPill.waitFor();

    // Merge detached color pill into subView pill (creating a 2-panel capsule under subView)
    const detachedColorCenter = await centerOf(page.locator('[data-float-pill="color"] [data-pill-panel="color"]'));
    const subViewCenter = await centerOf(subViewPill);
    await dragPointer(page, detachedColorCenter.x, detachedColorCenter.y, subViewCenter.x, subViewCenter.y);
    await page.waitForFunction(() => document.querySelector('[data-float-pill="subView"]')?.getAttribute('data-pill-count') === '2');

    // Drag the 2-panel capsule grip onto the layers pill -> 3-panel capsule under layers
    const subViewGripCenter = await centerOf(subViewPill.locator('[data-pill-grip="subView"]'));
    const layersSingleCenter = await centerOf(layersPill);
    await dragPointer(page, subViewGripCenter.x, subViewGripCenter.y, layersSingleCenter.x, layersSingleCenter.y);
    await page.waitForFunction(() => document.querySelector('[data-float-pill="layers"]')?.getAttribute('data-pill-count') === '3');
    const threeCapsuleBox = (await centerOf(layersPill)).box;
    assert.ok(
      threeCapsuleBox.width > horizCapsuleBox.width + 20,
      `3-panel capsule should be wider than 2-panel capsule (${threeCapsuleBox.width} vs ${horizCapsuleBox.width})`,
    );

    // Drag subView icon from the 3-panel capsule onto the right dock -> docks cleanly, capsule drops to 2
    const subViewIconInThree = await centerOf(layersPill.locator('[data-pill-panel="subView"]'));
    const rightDockCenter = await centerOf(page.locator('[data-dock-side="right"]'));
    await dragPointer(page, subViewIconInThree.x, subViewIconInThree.y, rightDockCenter.x, rightDockCenter.y);
    await page.waitForFunction(() => document.querySelector('[data-float-pill="layers"]')?.getAttribute('data-pill-count') === '2');
    await page.locator('[data-dock-side="right"] [data-panel="subView"]').waitFor();

    // Verify layout version persisted as v5
    const storedVersion = await page.evaluate(() => JSON.parse(localStorage.getItem('atelier_dock_layout') || '{}').version);
    assert.equal(storedVersion, 5, 'Persisted dock layout should be upgraded to version 5');

    assert.deepEqual(rendererErrors, [], `Renderer errors observed:\n${rendererErrors.join('\n')}`);
    console.log('v1.5 floating pill / capsule dock Electron smoke check passed (0 console errors, 0 page errors)');
  } finally {
    await Promise.allSettled(apps.map((app) => closeElectron(app)));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

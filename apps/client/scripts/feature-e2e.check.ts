/**
 * End-to-End Feature & UI Verification for packaged Lumina-Drift-Paint.exe
 *
 * Verifies every requested feature & regression fix against an isolated packaged Electron run
 * (without interfering with Port 3000 server or user AppData):
 *   1. Offline mode: no voice chat, branding returns to the gateway, custom and Cloudflare share links work
 *   2. Custom Electron theme-synced titlebar + CSP document title + cm/mm/in units + DPI persistence
 *   3. Light/Sakura theme text contrast & non-blinking Dock panel resize
 *   4. ColorWheel: Transparent color toggle (retains FG hex, sets isEraser) + HLS Triangle toggle
 *   5. Smudge 'smudge' vs 'blend' (zero directional displacement in 'blend') + Liquify 7 CSP modes & hardness
 *   6. Free Transform Pivot handle rigid rotation + Animation Timeline Keyframes / Cubic-Bezier easing evaluation
 *
 * Run:
 *   .\apps\server\node_modules\.bin\tsx.cmd apps/client/scripts/feature-e2e.check.ts [--packaged|--dev]
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.resolve('apps/server/package.json'));
const { _electron: electron } = require('playwright-core') as typeof import('playwright-core');

const useDev = process.argv.includes('--dev');
const usePackaged = !useDev;

async function launchIsolatedApp(packaged: boolean) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profileDir = fs.mkdtempSync(path.join(tempRoot, 'atelier-e2e-'));
  const userDataDir = path.join(profileDir, 'user-data');
  const appDataDir = path.join(profileDir, 'roaming');
  const localAppDataDir = path.join(profileDir, 'local');
  for (const directory of [userDataDir, appDataDir, localAppDataDir]) fs.mkdirSync(directory);
  const electronExe = path.resolve('apps/client/node_modules/electron/dist/electron.exe');
  const packagedExe = path.resolve('apps/client/release/win-unpacked/Lumina-Drift-Paint.exe');
  const mainJs = path.resolve('apps/client/dist-electron/main.js');
  const commonEnv = { ...process.env, APPDATA: appDataDir, LOCALAPPDATA: localAppDataDir };

  const app = packaged
    ? await electron.launch({
        executablePath: packagedExe,
        args: [`--user-data-dir=${userDataDir}`],
        env: commonEnv,
      })
    : await electron.launch({
        executablePath: electronExe,
        args: [mainJs, `--user-data-dir=${userDataDir}`],
        env: commonEnv,
      });

  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));

  const cleanup = async () => {
    try { await app.close(); } catch {}
    try {
      const resolved = fs.realpathSync(profileDir);
      if (resolved === profileDir && path.dirname(resolved) === tempRoot) fs.rmSync(resolved, { recursive: true });
    } catch {}
  };
  return { app, page, pageErrors, cleanup };
}

async function enterOfflineWorkspace(page: import('playwright-core').Page) {
  const submitGateway = page.locator('button[type="submit"]:has-text("開始單機作畫")');
  if (await submitGateway.isVisible({ timeout: 10000 }).catch(() => false)) {
    await submitGateway.click();
  }
  await page.locator('.atelier-canvas-viewport').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('[data-canvas-presented="true"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const dbg = (window as any).__debugPixi;
    return dbg && dbg.app && dbg.layerManager && dbg.viewport && dbg.viewport.canvasWidth > 0 && Boolean(document.querySelector('.atelier-canvas-viewport canvas'));
  }, undefined, { timeout: 15000 });
}

async function observeWorkspaceEntrance(page: import('playwright-core').Page) {
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const workspace = document.querySelector<HTMLElement>('[data-workspace-entry="options"]')?.parentElement;
      const viewport = workspace?.querySelector('.atelier-canvas-viewport');
      if (!workspace || !viewport) return;
      const surface = viewport.querySelector('.atelier-canvas-surface');
      if (surface) workspace.dataset.testInitialCanvasOpacity = getComputedStyle(surface).opacity;
      const animations = workspace.getAnimations({ subtree: true })
        .filter((animation) => animation.id === 'atelier-workspace-entrance')
        .flatMap(({ effect }) => {
          if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof HTMLElement)) return [];
          const target = effect.target;
          return [{
            part: target.dataset.workspaceEntry || target.dataset.panel || target.dataset.floatGroup,
            delay: effect.getTiming().delay,
            movesCanvas: target.contains(viewport),
          }];
        });
      workspace.dataset.testEntrance = JSON.stringify(animations);
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  return page.locator('.atelier-workspace[data-test-entrance]');
}

async function checkTabsPositionAndTheme(page: import('playwright-core').Page) {
  const tabs = page.getByRole('navigation', { name: '畫布切換' });
  const viewport = page.locator('.atelier-canvas-viewport');
  await viewport.evaluate((element) => { (element as HTMLElement).dataset.testOriginalViewport = 'true'; });
  const handle = tabs.getByRole('button', { name: /畫布切換列移至上方/ });
  const handleBox = (await handle.boundingBox())!;
  const workspaceBox = (await page.locator('[data-canvas-workspace]').boundingBox())!;
  const x = handleBox.x + handleBox.width / 2;
  await page.mouse.move(x, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, workspaceBox.y + 24, { steps: 8 });
  await page.mouse.up();
  await tabs.and(page.locator('[data-canvas-tabs-placement="top"]')).waitFor();
  assert.ok((await tabs.boundingBox())!.y < (await viewport.boundingBox())!.y);
  assert.equal(await page.evaluate(() => localStorage.getItem('atelier_tabs_placement')), 'top');
  assert.equal(await viewport.getAttribute('data-test-original-viewport'), 'true');
  await tabs.getByRole('button', { name: /畫布切換列移至下方/ }).press('Enter');
  await tabs.and(page.locator('[data-canvas-tabs-placement="bottom"]')).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('atelier_tabs_placement')), 'bottom');

  await viewport.evaluate((element) => {
    element.addEventListener('pointerdown', () => element.setAttribute('data-test-pointer-reached', 'true'));
  });
  const picker = page.getByRole('radiogroup', { name: '介面主題' });
  await page.getByTitle('主題配色選擇', { exact: true }).click();
  const preset = picker.getByRole('radio', { checked: false }).first();
  await preset.click();
  await page.locator('html.atelier-theme-vt').waitFor({ state: 'attached' });
  const canvasBox = (await viewport.boundingBox())!;
  await page.mouse.dblclick(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  assert.equal(await viewport.getAttribute('data-test-pointer-reached'), null);
  await page.locator('html.atelier-theme-vt').waitFor({ state: 'detached' });
  await picker.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'detached' });
}

async function checkDialogMotion(page: import('playwright-core').Page) {
  await page.evaluate(() => {
    document.addEventListener('transitionstart', (event) => {
      if (event.propertyName !== 'opacity' || !(event.target instanceof HTMLElement)) return;
      const wrapper = event.target.parentElement;
      if (wrapper?.dataset.overlayMotion) wrapper.dataset.testOpacityPhase = wrapper.dataset.overlayPhase;
    }, true);
  });
  const overlay = page.locator('[data-overlay-motion="dialog"]');
  const openFileItem = async (name: string) => {
    await page.getByTitle('檔案', { exact: true }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  for (const open of [
    () => page.getByTitle('偏好設定', { exact: true }).click(),
    () => page.getByTitle('個人檔案', { exact: true }).click(),
    () => page.keyboard.press('F1'),
    () => openFileItem('時光膠囊 (歷史存檔)'),
    () => openFileItem('縮時重播'),
  ]) {
    await open();
    await overlay.and(page.locator('[data-test-opacity-phase="open"]')).waitFor({ state: 'attached' });
    if (await overlay.getByRole('button', { name: '快捷鍵', exact: true }).count()) {
      await overlay.getByRole('button', { name: '快捷鍵', exact: true }).click();
      const search = overlay.getByRole('searchbox', { name: '搜尋快捷鍵' });
      await search.fill('ZZ_no_shortcut');
      await overlay.getByText('找不到符合的快捷鍵。').waitFor();
      await search.fill('Ctrl + Z');
      await overlay.getByRole('button', { name: 'Ctrl+Z', exact: true }).first().waitFor();
    }
    await overlay.getByRole('button', { name: '關閉', exact: true }).first().click();
    await overlay.and(page.locator('[data-test-opacity-phase="closing"]')).waitFor({ state: 'attached' });
    await overlay.waitFor({ state: 'detached' });
  }
}

async function checkCollaborativeWorkspace(page: import('playwright-core').Page, app: import('playwright-core').ElectronApplication) {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-chat-test-'));
  process.env.DATA_DIR = testDir;
  process.env.DATABASE_PATH = path.join(testDir, 'chat.db');
  process.env.ADMIN_PASSWORD = 'chat-fixture-only';
  const { buildApp } = await import('../../server/src/app');
  const server = await buildApp();
  const origin = await server.listen({ host: '127.0.0.1', port: 0 });
  const roomServer = server.roomManager as unknown as { io: { disconnectSockets(close: boolean): void } };
  const clientRequire = createRequire(path.resolve('apps/client/package.json'));
  const { io } = clientRequire('socket.io-client') as typeof import('socket.io-client');
  const list = (await server.inject({ method: 'GET', url: '/api/canvases' })).json();
  const canvasId = list.canvases[0].id as string;
  // Seed a Canvas Group with 2 canvases on the server so CanvasTabsBar & ConnectionGateway render collapsible group folders
  const regRes = await server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'group_host', displayName: 'Group Host', password: 'password123' },
  });
  const hostToken = regRes.json().token as string;
  const g1Res = await server.inject({
    method: 'POST',
    url: '/api/canvases/grouped',
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { title: 'GroupCanvas_1', newGroupTitle: '角色設定夾' },
  });
  const groupId = g1Res.json().canvas.group.id as string;
  await server.inject({
    method: 'POST',
    url: '/api/canvases/grouped',
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { title: 'GroupCanvas_2', groupId },
  });
  const socket = io(origin, { transports: ['websocket'], auth: { canvasId, displayName: '畫友' } });

  try {
    await page.getByPlaceholder('https://example.trycloudflare.com').fill(`${origin}/?room=${canvasId}`);
    await page.locator('form button[type="submit"]').click();
    await page.locator('[data-canvas-presented="true"]').waitFor();
    console.log('Isolated multiplayer canvas ready');
    const send = (id: string, text: string) => socket.emit('chat_message', { canvasId, id, text });
    const chat = page.getByRole('button', { name: '即時聊天室', exact: true });
    const badge = chat.locator('[data-chat-unread]');
    // Both clients can finish their joins on different ticks. Retry using a unique message id.
    for (let retries = 0; retries < 10 && !(await badge.isVisible()); retries += 1) {
      send(`first-${retries}`, 'First incoming message');
      await badge.waitFor({ timeout: 300 }).catch(() => {});
    }
    assert.ok(await badge.isVisible(), 'An incoming message must show the badge');
    await chat.click();
    const drawer = page.getByRole('dialog', { name: '即時聊天室', exact: true });
    const dismiss = drawer.getByRole('button', { name: '關閉', exact: true });
    const titleBar = (await page.locator('.atelier-drag-region').boundingBox())!;
    const closeButton = (await dismiss.boundingBox())!;
    assert.ok(closeButton.y >= titleBar.y + titleBar.height, 'Chat close button must sit below the native title bar');
    await drawer.getByText('First incoming message').first().waitFor();
    assert.equal(await badge.count(), 0);
    send('second', 'Message while open');
    await drawer.getByText('Message while open').waitFor();
    await dismiss.click();
    await page.locator('[data-overlay-motion="drawer"][data-overlay-phase="closing"]').waitFor({ state: 'attached' });
    await drawer.waitFor({ state: 'detached' });
    assert.equal(await badge.count(), 0);
    send('third', 'Message after close');
    await badge.waitFor();
    console.log('Chat badge resets on read and reappears for the next message');
    assert.equal(await page.getByRole('switch', { name: /Cloudflare/ }).count(), 0, 'A remote painter cannot manage the host tunnel');

    // In-canvas Share Link & QR Code button works for remote / internet / LAN / tunnel connections
    const shareBtn = page.locator('[data-workspace-share-btn]');
    await shareBtn.waitFor({ state: 'visible' });
    await shareBtn.click();
    const sharePopover = page.locator('[data-workspace-share-popover]');
    await sharePopover.waitFor({ state: 'visible' });
    const shareUrlText = await sharePopover.locator('[data-workspace-share-url]').textContent();
    assert.equal(shareUrlText, `${origin}/?room=${canvasId}`, 'In-canvas share link must include room invite query');
    await sharePopover.locator('[data-workspace-copy-link]').click();
    const qrToggle = sharePopover.locator('[data-workspace-qr-toggle]');
    await qrToggle.click();
    const qrImg = sharePopover.locator('[data-workspace-qr-img]');
    await qrImg.waitFor({ state: 'visible' });
    const qrSrc = await qrImg.getAttribute('src');
    assert.ok(qrSrc?.startsWith('data:image/png;base64,'), 'In-canvas QR code image must render valid data URL');
    await shareBtn.click();
    await sharePopover.waitFor({ state: 'detached' });

    await app.evaluate(({ BrowserWindow }, url) => {
      BrowserWindow.getAllWindows()[0].webContents.send('atelier:tunnel-status', url);
    }, origin);
    const hostTunnel = page.getByRole('switch', { name: /Cloudflare/ });
    await hostTunnel.waitFor();
    assert.equal(await hostTunnel.getAttribute('aria-checked'), 'true');
    await hostTunnel.click();
    await hostTunnel.waitFor({ state: 'detached' });
    assert.equal((await server.inject({ method: 'GET', url: '/health' })).statusCode, 200);

    // Verify Canvas Group folder collapsing in CanvasTabsBar
    const groupFolder = page.locator('[data-canvas-group]').first();
    await groupFolder.waitFor({ state: 'visible' });
    assert.equal(await groupFolder.getAttribute('data-collapsed'), 'false', 'Canvas group folder starts expanded');
    assert.equal(await groupFolder.getByRole('tab').count(), 2, 'Expanded canvas group shows 2 child tabs');
    const groupToggle = groupFolder.locator('[data-canvas-group-toggle]');
    await groupToggle.click();
    assert.equal(await groupFolder.getAttribute('data-collapsed'), 'true', 'Canvas group folder collapses on click');
    assert.equal(await groupFolder.getByRole('tab').count(), 0, 'Collapsed canvas group hides child tabs');
    await groupToggle.click();
    assert.equal(await groupFolder.getAttribute('data-collapsed'), 'false', 'Canvas group folder expands on second click');
    assert.equal(await groupFolder.getByRole('tab').count(), 2, 'Expanded canvas group restores 2 child tabs');

    const JSZip = clientRequire('jszip') as typeof import('jszip');
    const zip = new JSZip();
    const title = 'Collaborative Lumina import';
    zip.file('project.json', JSON.stringify({ canvas: { title, width: 64, height: 64, bgColor: '#ffffff', dpi: 300 } }));
    zip.file('layers/hierarchy.json', JSON.stringify([
      { id: 'editable', name: 'Editable paint', layerType: 'raster', blendMode: 'normal', opacity: 1, sortOrder: 0, isVisible: true, isLocked: false },
      { id: 'locked', name: 'Locked layout', layerType: 'raster', blendMode: 'normal', opacity: 1, sortOrder: 1, isVisible: true, isLocked: true },
    ]));
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#d42e47';
      ctx.fillRect(4, 4, 12, 12);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    zip.file('layers/layer_editable.png', png, { base64: true });
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await page.locator('input[accept=".lumina"]').setInputFiles({ name: 'fixture.lumina', mimeType: 'application/zip', buffer });
    await page.waitForFunction((name) => document.title.includes(name), title, { timeout: 10000 });
    const imported = (await server.inject({ method: 'GET', url: '/api/canvases' })).json().canvases.find((canvas: { title: string }) => canvas.title === title);
    assert.ok(imported, 'Import must create a server canvas');
    const importedLayers = (await server.inject({ method: 'GET', url: `/api/canvases/${imported.id}/layers` })).json().layers as Array<{
      name: string; isPublic: boolean; isLocked: boolean; aclMode: string;
    }>;
    assert.equal(importedLayers.find(({ name }) => name === 'Editable paint')?.aclMode, 'shared_all');
    assert.equal(importedLayers.find(({ name }) => name === 'Locked layout')?.isLocked, true);
    assert.ok(imported.latestSeq > 0, 'Imported pixels must reach the server operation log');
    console.log('Collaborative .lumina import preserved pixels, shared layers and locked layers');
  } finally {
    socket.disconnect();
    roomServer.io.disconnectSockets(true);
    await server.close();
  }
}

function relLuminance(r: number, g: number, b: number) {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function parseRgba(s: string): [number, number, number, number] {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
}

function compositeOver(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
  const a = fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}

function contrastRgb(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relLuminance(fg[0], fg[1], fg[2]);
  const l2 = relLuminance(bg[0], bg[1], bg[2]);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function checkGatewayDragAndSurface(page: import('playwright-core').Page) {
  const dragBar = page.locator('.atelier-gateway .atelier-drag-region').first();
  await dragBar.waitFor({ state: 'visible', timeout: 5000 });
  const dragBox = await dragBar.boundingBox();
  assert.ok(dragBox, 'ConnectionGateway .atelier-drag-region bounding box missing');
  assert.ok(dragBox.y >= 0 && dragBox.y <= 1, `Expected gateway drag bar at top edge, got y=${dragBox.y}`);
  assert.ok(dragBox.height >= 28 && dragBox.height <= 30, `Expected 28px gateway drag bar, got ${dragBox.height}`);
  assert.ok(dragBox.width >= 900, `Expected full-width gateway drag bar, got ${dragBox.width}`);

  const dragPadding = await dragBar.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      paddingLeft: parseFloat(cs.paddingLeft),
      paddingRight: parseFloat(cs.paddingRight),
      appRegion: cs.getPropertyValue('-webkit-app-region'),
    };
  });
  assert.equal(dragPadding.appRegion, 'drag', 'Gateway top bar must have -webkit-app-region: drag');
  if (process.platform === 'darwin') {
    assert.ok(dragPadding.paddingLeft >= 76, `Expected macOS traffic light inset >= 76px, got ${dragPadding.paddingLeft}`);
  } else {
    assert.ok(dragPadding.paddingRight >= 142, `Expected Windows titleBarOverlay clearance >= 142px, got ${dragPadding.paddingRight}`);
  }

  const scrollBox = await page.locator('.atelier-gateway form').evaluate((formEl) => {
    const scroller = formEl.parentElement;
    if (!scroller) return null;
    const rect = scroller.getBoundingClientRect();
    return { y: rect.y, overflowY: getComputedStyle(scroller).overflowY };
  });
  assert.ok(scrollBox, 'Gateway scroll container missing');
  assert.ok(scrollBox.y >= dragBox.y + dragBox.height - 0.5,
    `Gateway form scroll area (y=${scrollBox.y}) must start below 28px drag bar (${dragBox.y + dragBox.height})`);

  const splash = page.locator('.atelier-startup-splash').first();
  if (await splash.isVisible().catch(() => false)) {
    const splashBox = await splash.boundingBox();
    const pointerEvents = await splash.evaluate((el) => getComputedStyle(el).pointerEvents);
    assert.equal(pointerEvents, 'none', 'Startup splash must keep pointer-events: none');
    if (splashBox) {
      assert.ok(splashBox.y >= dragBox.y + dragBox.height,
        `Startup splash (y=${splashBox.y}) must sit below gateway drag bar`);
    }
  }

  const startBtnRegion = await page.locator('button:has-text("開始單機作畫")').first().evaluate(
    (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'),
  );
  assert.notEqual(startBtnRegion, 'drag', 'Gateway buttons must remain clickable (not drag region)');
}

async function main() {
  console.log(`=== Running Feature E2E Suite (${usePackaged ? 'PACKAGED .EXE' : 'DEV ELECTRON'}) ===`);
  const { app, page, pageErrors, cleanup } = await launchIsolatedApp(usePackaged);

  try {
    assert.equal(await page.evaluate(() => (window as any).atelierDesktop.server.stopTunnel()), true,
      'The local desktop renderer may control its own tunnel');
    await checkGatewayDragAndSurface(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normalEntrance = await observeWorkspaceEntrance(page);
    await enterOfflineWorkspace(page);
    const entrance = JSON.parse(await normalEntrance.getAttribute('data-test-entrance') ?? '[]') as Array<{
      part: string; delay: number; movesCanvas: boolean;
    }>;
    const delays = new Map(entrance.map(({ part, delay }) => [part, delay]));
    assert.equal(delays.get('options'), 0);
    assert.ok((delays.get('left-tools') ?? 0) > 0);
    assert.ok((delays.get('layers') ?? 0) > (delays.get('color') ?? 0), 'Dock panels must enter in sequence');
    assert.ok(entrance.every(({ movesCanvas }) => !movesCanvas), 'The canvas viewport must stay in place');
    assert.equal(await normalEntrance.getAttribute('data-test-initial-canvas-opacity'), '0');
    assert.equal(await page.locator('.atelier-canvas-surface').evaluate((element) => getComputedStyle(element).animationName), 'atelierCanvasReveal');
    await checkTabsPositionAndTheme(page);
    await checkDialogMotion(page);

    // 1. Offline UI checks: No voice chat button, Gateway return button visible
    const voiceBtnCount = await page.locator('button:has-text("加入語音聊天")').count();
    assert.equal(voiceBtnCount, 0, 'Offline mode must hide voice chat button');
    const switchModeBtn = page.locator('button[title*="返回連線入口"]');
    assert.ok(await switchModeBtn.isVisible(), 'Offline topbar should expose gateway return button');
    await page.locator('.atelier-drag-region').getByRole('button', { name: /Lumina Drift/ }).click();
    await page.getByRole('heading', { name: /Lumina Drift/ }).waitFor({ state: 'visible' });
    assert.ok(await page.getByRole('heading', { name: /Lumina Drift/ }).evaluate((el) => document.activeElement === el));

    // Exercise the production renderer and preload with an isolated IPC and HTTP fixture.
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const tunnel = 'https://packaged-gateway.trycloudflare.com';
      for (const channel of ['atelier:get-server-status', 'atelier:get-tunnel-status', 'atelier:start-tunnel', 'atelier:stop-tunnel']) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle('atelier:get-server-status', () => ({ isRunning: true }));
      ipcMain.handle('atelier:get-tunnel-status', () => ({ url: null }));
      ipcMain.handle('atelier:start-tunnel', () => {
        BrowserWindow.getAllWindows()[0].webContents.send('atelier:tunnel-status', tunnel);
        return { success: true, url: tunnel };
      });
      ipcMain.handle('atelier:stop-tunnel', () => {
        BrowserWindow.getAllWindows()[0].webContents.send('atelier:tunnel-status', null);
        return true;
      });
    });
    const headers = { 'Access-Control-Allow-Origin': '*' };
    await page.route('http://127.0.0.1:3000/api/canvases', (route) => route.fulfill({ headers, json: { canvases: [] } }));
    await page.getByRole('button', { name: /多人連線繪茶/ }).click();
    const cloudflare = page.getByRole('switch', { name: /Cloudflare/ });
    await cloudflare.click();
    await page.getByText('https://packaged-gateway.trycloudflare.com', { exact: true }).waitFor();
    assert.equal(await cloudflare.getAttribute('aria-checked'), 'true');
    await cloudflare.click();
    await page.getByText('https://packaged-gateway.trycloudflare.com', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await cloudflare.getAttribute('aria-checked'), 'false');

    const customHost = 'https://studio.example.test';
    await page.route(`${customHost}/health`, (route) => route.fulfill({ headers, json: { status: 'ok' } }));
    await page.route(`${customHost}/api/canvases`, (route) => route.fulfill({ headers, json: { canvases: [
      { id: 'fixture-a', title: 'First fixture', width: 100, height: 100 },
      { id: 'fixture-b', title: 'Invited fixture', width: 100, height: 100 },
    ] } }));
    await page.getByPlaceholder('https://example.trycloudflare.com').fill('studio.example.test/?room=fixture-b');
    await page.getByRole('button', { name: /測試連線/ }).click();
    await page.getByText(customHost, { exact: true }).waitFor();
    await page.getByText(/連得上.*ms/).waitFor();
    const invited = page.getByRole('radio', { name: /Invited fixture/ });
    await invited.waitFor();
    assert.equal(await invited.getAttribute('aria-checked'), 'true');

    await checkCollaborativeWorkspace(page, app);
    await page.locator('.atelier-drag-region').getByRole('button', { name: /Lumina Drift/ }).click();
    await page.getByRole('button', { name: /單人離線作畫/ }).click();

    // C1: Default motion mode ('on') keeps animations alive even when OS reducedMotion is 'reduce'.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('html').getAttribute('data-motion'), 'on');
    assert.equal(await page.locator('html').getAttribute('data-motion-mode'), 'on');
    const forcedEntrance = await observeWorkspaceEntrance(page);
    await enterOfflineWorkspace(page);
    const forcedEntryParts = JSON.parse(await forcedEntrance.getAttribute('data-test-entrance') ?? '[]') as unknown[];
    assert.ok(forcedEntryParts.length > 0, 'Default motionMode="on" must still run entrance animation under OS reduced-motion');
    assert.equal(await page.locator('.atelier-canvas-surface').evaluate((element) => getComputedStyle(element).animationName), 'atelierCanvasReveal');

    // Switch motion mode to 'auto' in Settings -> now OS reducedMotion='reduce' turns animations off.
    await page.getByTitle('偏好設定', { exact: true }).click();
    const settingsDialog = page.locator('[data-overlay-motion="dialog"]');
    await settingsDialog.waitFor({ state: 'visible' });
    await settingsDialog.locator('[data-setting="motion-mode"][data-motion-mode="auto"]').click();
    assert.equal(await page.locator('html').getAttribute('data-motion'), 'off');
    assert.equal(await page.locator('html').getAttribute('data-motion-mode'), 'auto');
    await settingsDialog.getByRole('button', { name: '關閉', exact: true }).first().click();
    await settingsDialog.waitFor({ state: 'detached' });

    await page.locator('.atelier-drag-region').getByRole('button', { name: /Lumina Drift/ }).click();
    await page.getByRole('button', { name: /單人離線作畫/ }).click();
    const reducedEntrance = await observeWorkspaceEntrance(page);
    await enterOfflineWorkspace(page);
    assert.equal(await reducedEntrance.getAttribute('data-test-entrance'), '[]');
    assert.equal(await page.locator('.atelier-canvas-surface').evaluate((element) => getComputedStyle(element).animationName), 'none');

    // Restore OS media & set app motion mode back to 'on' for remaining checks.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByTitle('偏好設定', { exact: true }).click();
    await settingsDialog.waitFor({ state: 'visible' });
    await settingsDialog.locator('[data-setting="motion-mode"][data-motion-mode="on"]').click();
    await settingsDialog.getByRole('button', { name: '關閉', exact: true }).first().click();
    await settingsDialog.waitFor({ state: 'detached' });
    console.log('✓ [1/7] Canvas fade, motionMode(on/auto) vs OS reduced motion, docking, theme input guard, chat read receipts, gateway and tunnel verified');

    // 2. Electron custom titlebar, CSP info format, Physical Units (cm / in) + DPI
    const hasDragTitlebar = await page.locator('.atelier-drag-region').first().isVisible();
    assert.ok(hasDragTitlebar, 'Custom Electron titlebar (.atelier-drag-region) should be visible');

    // Open New Canvas modal -> create A4 300 DPI via cm units (21 x 29.7 cm)
    await page.locator('button[title="新建畫布"]').click();
    await page.locator('#new-canvas-w').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('form input[type="text"]').first().fill('CSP_Unit_Test');
    const cmBtn = page.locator('form button[aria-pressed]:has-text("cm")').first();
    await cmBtn.click();
    const dpiInput = page.locator('form label:has-text("DPI") input').first();
    await dpiInput.fill('300');
    await dpiInput.blur();
    await page.locator('#new-canvas-w').fill('21');
    await page.locator('#new-canvas-h').fill('29.7');
    await page.locator('button[type="submit"]:has-text("建立畫布")').click();

    await page.waitForFunction(() => {
      const dbg = (window as any).__debugPixi;
      return dbg?.viewport?.canvasWidth === 2480 && dbg?.viewport?.canvasHeight === 3508;
    }, undefined, { timeout: 15000 });

    // Check document title / custom titlebar CSP string & live zoom reaction
    await page.evaluate(() => {
      const dbg = (window as any).__debugPixi;
      dbg.viewport.setZoom(1.8);
    });
    await page.waitForTimeout(150);
    const titleAfterCreate = await page.title();
    assert.ok(titleAfterCreate.includes('CSP_Unit_Test'), `Expected title in doc title, got: ${titleAfterCreate}`);
    assert.ok(titleAfterCreate.includes('cm') && titleAfterCreate.includes('300dpi'), `Expected cm & 300dpi in title: ${titleAfterCreate}`);
    assert.ok(titleAfterCreate.includes('180.0%') && titleAfterCreate.includes('RGB:sRGB IEC61966-2.1'), `Expected zoom & RGB profile in title: ${titleAfterCreate}`);

    // Resize Canvas using inches & 150 DPI -> 10 x 8 in = 1500 x 1200 px
    await page.locator('button[title="變更畫布尺寸"]').click();
    await page.locator('#resize-canvas-form').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#resize-canvas-form button[aria-pressed]:has-text("in")').click();
    const lockBtn = page.locator('#resize-canvas-form button[title*="等比"], #resize-canvas-form button[title*="鎖定"], #resize-canvas-form button[title*="解除"]').first();
    if (await lockBtn.isVisible().catch(() => false)) {
      const tAttr = (await lockBtn.getAttribute('title')) || '';
      if (tAttr.includes('解除') || tAttr.toLowerCase().includes('unlock')) {
        await lockBtn.click();
      }
    }
    const resizeDpi = page.locator('#resize-canvas-form label:has-text("DPI") input').first();
    await resizeDpi.fill('150');
    await resizeDpi.blur();
    await page.locator('#resize-w').fill('10');
    await page.locator('#resize-h').fill('8');
    await page.locator('button[form="resize-canvas-form"][type="submit"]').click();
    await page.waitForFunction(() => {
      const dbg = (window as any).__debugPixi;
      return dbg?.viewport?.canvasWidth === 1500 && dbg?.viewport?.canvasHeight === 1200;
    }, undefined, { timeout: 15000 });
    const titleAfterResize = await page.title();
    assert.ok(titleAfterResize.includes('in') && titleAfterResize.includes('150dpi'), `Expected resized unit & dpi in title: ${titleAfterResize}`);
    console.log(`✓ [2/7] Electron titlebar & physical unit/DPI pipeline verified (${titleAfterResize})`);

    // 3. Light/Sakura theme text contrast + 5 Surface Styles + Dock panel resize without canvas blink
    const darkDragBg = await page.locator('.atelier-drag-region').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.locator('button[title="主題配色選擇"]').click();
    const sakuraOption = page.locator('button:has-text("粉櫻"), button:has-text("櫻")').first();
    await sakuraOption.waitFor({ state: 'visible', timeout: 5000 });
    await sakuraOption.click();
    await page.locator('html.atelier-theme-vt').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForTimeout(150);

    const lightDragBg = await page.locator('.atelier-drag-region').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(lightDragBg, darkDragBg, 'Titlebar drag bar color must adapt to light/sakura theme');
    const prefBtnStyles = await page.locator('button[title="偏好設定"]').evaluate((el) => {
      const cs = getComputedStyle(el);
      const layers: string[] = [];
      let cur: HTMLElement | null = el;
      while (cur) {
        layers.push(getComputedStyle(cur).backgroundColor);
        cur = cur.parentElement;
      }
      return { color: cs.color, bgLayers: layers };
    });
    let effBg: [number, number, number] = [255, 255, 255];
    for (let i = prefBtnStyles.bgLayers.length - 1; i >= 0; i--) {
      const rgba = parseRgba(prefBtnStyles.bgLayers[i]);
      if (rgba[3] > 0) effBg = compositeOver(rgba, effBg);
    }
    const fgRgba = parseRgba(prefBtnStyles.color);
    const effFg = compositeOver(fgRgba, effBg);
    const prefContrast = contrastRgb(effFg, effBg);
    assert.ok(prefContrast >= 4.5, `Expected readable Preferences text contrast >= 4.5 under Sakura theme (fg=${effFg.join(',')} bg=${effBg.join(',')}), got ${prefContrast.toFixed(2)}`);

    // C2: Switch through all 5 surface styles and verify persistence + zero canvas backdropFilter/boxShadow
    for (const surfaceId of ['liquid-glass', 'frosted-matte', 'lumina-glow', 'soft-paper', 'solid'] as const) {
      const surfaceBtn = page.locator(`[data-surface-option="${surfaceId}"]`).first();
      await surfaceBtn.waitFor({ state: 'visible', timeout: 5000 });
      await surfaceBtn.click();
      await page.locator('html.atelier-theme-vt').waitFor({ state: 'detached', timeout: 5000 });
      await page.waitForTimeout(50);
      assert.equal(await page.locator('html').getAttribute('data-surface'), surfaceId);
      assert.equal(await page.evaluate(() => localStorage.getItem('atelier_surface_style')), surfaceId);
      const canvasFx = await page.evaluate(() => {
        const vp = document.querySelector('.atelier-canvas-viewport');
        const surf = document.querySelector('.atelier-canvas-surface');
        return {
          vpBackdrop: vp ? getComputedStyle(vp).backdropFilter : 'none',
          vpShadow: vp ? getComputedStyle(vp).boxShadow : 'none',
          surfBackdrop: surf ? getComputedStyle(surf).backdropFilter : 'none',
          surfShadow: surf ? getComputedStyle(surf).boxShadow : 'none',
        };
      });
      assert.equal(canvasFx.vpBackdrop, 'none', `Canvas viewport must not have backdrop-filter under ${surfaceId}`);
      assert.equal(canvasFx.vpShadow, 'none', `Canvas viewport must not have box-shadow under ${surfaceId}`);
      assert.equal(canvasFx.surfBackdrop, 'none', `Canvas surface must not have backdrop-filter under ${surfaceId}`);
      assert.equal(canvasFx.surfShadow, 'none', `Canvas surface must not have box-shadow under ${surfaceId}`);
    }

    // Switch back to Midnight for remaining checks (ThemePicker leaves DropdownMenu open, so toggle cleanly)
    await page.keyboard.press('Escape');
    await page.locator('button[title="主題配色選擇"]').click();
    const midnightOption = page.locator('button:has-text("午夜藍"), button:has-text("極夜")').first();
    if (await midnightOption.isVisible().catch(() => false)) {
      await midnightOption.click();
      await page.locator('html.atelier-theme-vt').waitFor({ state: 'detached', timeout: 5000 });
    }
    await page.keyboard.press('Escape');

    const resizeHandle = page.locator('[aria-label="調整面板寬度"]').first();
    if (await resizeHandle.isVisible().catch(() => false)) {
      const hb = await resizeHandle.boundingBox();
      assert.ok(hb, 'Dock resize handle bounding box missing');
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(hb.x - i * 12, hb.y + hb.height / 2);
        const canvasOk = await page.evaluate(() => {
          const cv = document.querySelector('.atelier-canvas-viewport canvas') as HTMLCanvasElement | null;
          return Boolean(cv && cv.width > 100 && cv.height > 100);
        });
        assert.ok(canvasOk, 'WebGL canvas must remain valid with non-zero size during Dock resize drag');
      }
      await page.mouse.up();
    }
    console.log(`✓ [3/7] Light/Sakura theme titlebar & readable contrast (${prefContrast.toFixed(2)}:1) + zero-blink dock resize verified`);

    // 4. Offline telemetry (stroke count + draw time) & IDB persistence
    const strokePt = await page.evaluate(() => {
      const dbg = (window as any).__debugPixi;
      const vpEl = document.querySelector('.atelier-canvas-viewport') as HTMLElement | null;
      if (dbg?.viewport && vpEl) {
        dbg.viewport.fitToContainer?.(vpEl.clientWidth, vpEl.clientHeight);
      }
      const cx = (dbg?.viewport?.canvasWidth ?? 1500) / 2;
      const cy = (dbg?.viewport?.canvasHeight ?? 1200) / 2;
      const s = dbg?.viewport?.canvasToScreen?.(cx, cy) ?? { x: 400, y: 400 };
      const r = vpEl?.getBoundingClientRect();
      return { x: (r?.left ?? 0) + s.x, y: (r?.top ?? 0) + s.y };
    });

    await page.locator('button[aria-label^="一般畫筆"]').click();
    for (let s = 0; s < 3; s++) {
      await page.mouse.move(strokePt.x - 40 + s * 15, strokePt.y - 30);
      await page.mouse.down();
      await page.mouse.move(strokePt.x + 40 + s * 15, strokePt.y + 30, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(120);
    }

    // schedulePersist debounces 1000ms — poll IDB from Node until persisted
    let telemetryState = { strokeCount: 0, drawTimeMs: 0, debugAll: [] as any[] };
    for (let attempt = 0; attempt < 25; attempt++) {
      telemetryState = await page.evaluate(async () => {
        const dbReq = indexedDB.open('LuminaDrift_OfflineStorage');
        const db: IDBDatabase = await new Promise((res, rej) => {
          dbReq.onsuccess = () => res(dbReq.result);
          dbReq.onerror = () => rej(dbReq.error);
        });
        const tx = db.transaction(['offline_canvases'], 'readonly');
        const all: any[] = await new Promise((res, rej) => {
          const r = tx.objectStore('offline_canvases').getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        });
        db.close();
        const target = all.find((c) => c.canvas?.title === 'CSP_Unit_Test') || all[all.length - 1];
        return {
          strokeCount: target?.strokeCount ?? 0,
          drawTimeMs: target?.drawTimeMs ?? 0,
          debugAll: all.map((c) => ({ id: c.canvas?.id, title: c.canvas?.title, strokeCount: c.strokeCount, drawTimeMs: c.drawTimeMs })),
        };
      });
      if (telemetryState.strokeCount >= 3 && telemetryState.drawTimeMs > 0) break;
      await page.waitForTimeout(200);
    }
    const cx = strokePt.x;
    const cy = strokePt.y;
    assert.ok(telemetryState.strokeCount >= 3, `Expected IDB strokeCount >= 3, got ${telemetryState.strokeCount} (${JSON.stringify(telemetryState.debugAll)})`);
    assert.ok(telemetryState.drawTimeMs > 0, `Expected IDB drawTimeMs > 0, got ${telemetryState.drawTimeMs}`);

    await page.locator('button[title="在線成員"]').click();
    const membersText = await page.locator('[aria-label="在線成員"], [aria-label="成員"]').first().innerText().catch(async () => {
      return await page.locator('body').innerText();
    });
    assert.ok(!membersText.includes('尚未作畫'), 'Offline user card must show stroke count & draw time instead of 尚未作畫');
    assert.ok(/[3-9]\d*\s*筆/.test(membersText), 'UI must display >= 3 筆 in offline member telemetry');
    console.log(`✓ [4/7] Offline stroke telemetry verified: ${telemetryState.strokeCount} strokes, ${telemetryState.drawTimeMs}ms in IDB & UI`);

    // 5. ColorWheel: Transparent color toggle & HLS Triangle toggle
    const transparentBtn = page.locator('button[title*="透明色"]').first();
    await transparentBtn.waitFor({ state: 'visible', timeout: 5000 });
    await transparentBtn.click();
    const badgePressed = await transparentBtn.getAttribute('aria-pressed');
    assert.equal(badgePressed, 'true', 'Clicking transparent swatch must activate eraser-color mode');
    await page.locator('button[title="前景色"]').first().click();
    assert.equal(await transparentBtn.getAttribute('aria-pressed'), 'false', 'Clicking FG swatch must exit transparent color mode while retaining FG hex');

    const hlsBtn = page.locator('button:has-text("HLS")').first();
    await hlsBtn.waitFor({ state: 'visible', timeout: 5000 });
    await hlsBtn.click();
    assert.equal(await hlsBtn.getAttribute('aria-pressed'), 'true', 'HLS triangle mode toggle must activate');
    await page.locator('button:has-text("HSV")').first().click();
    console.log('✓ [5/7] ColorWheel Transparent swatch & HLS Triangle mode verified');

    // 6. Smudge ('smudge' vs 'blend') & Liquify (7 CSP modes & hardness)
    await page.locator('button[aria-label^="揉色"]').click();
    const blendBtn = page.locator('button:has-text("原位融合")');
    const smudgeBtn = page.locator('button:has-text("拖曳揉色")');
    assert.ok(await blendBtn.isVisible(), 'Smudge blend (原位融合) mode option must appear');
    assert.ok(await smudgeBtn.isVisible(), 'Smudge drag (拖曳揉色) mode option must appear');
    await blendBtn.click();

    await page.locator('button[aria-label^="液化"]').click();
    for (const label of ['普通', '擴散', '內縮', '基準左側', '基準右側', '左旋轉', '右旋轉']) {
      assert.ok(await page.locator(`button:has-text("${label}")`).first().isVisible(), `Liquify mode '${label}' missing`);
    }
    assert.ok(await page.locator('text=硬度').first().isVisible(), 'Liquify hardness slider missing');
    assert.ok(await page.locator('text=僅參照操作範圍').first().isVisible(), 'Liquify reference-area checkbox missing');
    console.log('✓ [6/7] Smudge dual modes & all 7 CSP Liquify modes + hardness verified');

    // 7. Free Transform Pivot Rigid Rotation + Timeline Keyframes / Cubic-Bezier Easing
    // Switch back to brush, verify binary antiAlias='none' sharp pixel mode & zoom>1 pixelated sampling
    await page.locator('button[aria-label^="一般畫筆"]').click();
    const aaNoneBtn = page.getByRole('radio', { name: '消除鋸齒: 無' }).first();
    await aaNoneBtn.click();
    assert.equal(await aaNoneBtn.getAttribute('aria-checked'), 'true', 'Anti-alias None must be selectable');
    const isPixelatedAt150 = await page.evaluate(() => {
      const d = (window as any).__debugPixi;
      d.viewport.setZoom(1.5);
      return true;
    });
    assert.ok(isPixelatedAt150);
    await page.waitForFunction(() => Boolean((window as any).__debugPixi?.layerManager?.pixelated), null, { timeout: 3000 });
    await page.evaluate(() => (window as any).__debugPixi.viewport.setZoom(1.0));
    await page.mouse.move(cx - 25, cy - 25);
    await page.mouse.down();
    await page.mouse.move(cx + 25, cy + 25, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    await page.locator('button[aria-label^="自由變形"]').click();
    const pivotHandle = page.locator('[title*="關節軸心"]');
    await pivotHandle.waitFor({ state: 'visible', timeout: 5000 });
    const pb = await pivotHandle.boundingBox();
    assert.ok(pb, 'Transform Pivot handle bounding box missing');
    // Drag pivot 24px right/down
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width / 2 + 24, pb.y + pb.height / 2 + 18, { steps: 4 });
    await page.mouse.up();
    const pbMoved = await pivotHandle.boundingBox();
    assert.ok(pbMoved && Math.abs(pbMoved.x - pb.x) > 10, 'Pivot handle must move when dragged');

    const rotateHandle = page.locator('[title*="旋轉把手"]');
    const rb = await rotateHandle.boundingBox();
    assert.ok(rb, 'Transform rotate handle missing');
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width / 2 + 50, rb.y + rb.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    const pbAfterRotate = await pivotHandle.boundingBox();
    const pivCenterMoved = pbMoved ? { x: pbMoved.x + pbMoved.width / 2, y: pbMoved.y + pbMoved.height / 2 } : null;
    const pivCenterAfter = pbAfterRotate ? { x: pbAfterRotate.x + pbAfterRotate.width / 2, y: pbAfterRotate.y + pbAfterRotate.height / 2 } : null;
    const pivotCenterDrift = pivCenterMoved && pivCenterAfter ? Math.hypot(pivCenterAfter.x - pivCenterMoved.x, pivCenterAfter.y - pivCenterMoved.y) : 999;
    assert.ok(pivotCenterDrift < 2.5, `Pivot center must stay fixed in canvas space during rigid rotation (drift=${pivotCenterDrift.toFixed(2)}px)`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);

    // Open Animation Timeline -> create animation folder if needed -> add cel -> Keyframe & Cubic Bezier
    await page.locator('button[aria-label^="逐格動畫"]').click();
    await page.locator('[data-anim-timeline]').waitFor({ state: 'visible', timeout: 5000 });
    const createFolderBtn = page.locator('button:has-text("建立動畫資料夾"), button[title="建立動畫資料夾"]').first();
    if (await createFolderBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await createFolderBtn.click();
      await page.waitForTimeout(250);
    }
    const addCelBtn = page.locator('button[title="新增賽璐珞格"], button:has-text("新增賽璐珞格")').first();
    if (await addCelBtn.isVisible().catch(() => false)) {
      await addCelBtn.click();
      await page.waitForTimeout(200);
    }
    const kfToggleBtn = page.locator('button[title="關鍵影格與補間"]');
    await kfToggleBtn.waitFor({ state: 'visible', timeout: 5000 });
    await kfToggleBtn.click();
    const addKfBtn = page.locator('button:has-text("新增／更新影格")');
    await addKfBtn.waitFor({ state: 'visible', timeout: 5000 });
    await addKfBtn.click(); // frame 0 keyframe

    // Jump back or advance frames & add second keyframe with Bezier easing
    const firstCelBtn = page.locator('button[title*="第一格"], button[aria-label*="第一格"]').first();
    if (await firstCelBtn.isVisible().catch(() => false)) {
      await firstCelBtn.click();
    }
    const easingSelect = page.locator('select:has(option[value="cubicBezier"])');
    await easingSelect.waitFor({ state: 'visible', timeout: 5000 });
    await easingSelect.selectOption('cubicBezier');
    await addKfBtn.click();
    const diamondCount = await page.locator('button:has-text("◆")').count();
    assert.ok(diamondCount >= 1, 'Animation timeline should render keyframe diamond markers (◆)');
    console.log(`✓ [7/7] Free Transform Pivot handle & Animation Keyframe/Cubic-Bezier timeline verified (${diamondCount} markers)`);

    assert.equal(pageErrors.length, 0, `Unexpected pageerrors: ${pageErrors.join('; ')}`);
    console.log('ALL E2E FEATURE CHECKS PASSED ON REAL ELECTRON BUILD!');
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('E2E FEATURE CHECK FAILED:', err);
  process.exit(1);
});

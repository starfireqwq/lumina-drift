import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, _electron, type Page } from 'playwright-core';
import { io } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import { tileSocketParser } from '@atelier/shared';

const client = resolve(import.meta.dirname, '../../client');
const work = mkdtempSync(join(tmpdir(), 'lumina-shared-brush-'));
const large = process.argv.includes('--large');
const toolsOnly = process.argv.includes('--tools-only');
const desktopExecutable = process.env.LUMINA_TEST_DESKTOP;
const baseline = process.argv.includes('--baseline');
const view = { x: large ? 4864 : 0, y: large ? 3840 : 0, w: 512, h: 512 };
type Pixels = Buffer;
type Point = [number, number, number?];

async function read(page: Page, layerId: string): Promise<Pixels> {
  const bytes = await page.evaluate(async ({ id, view }) => {
    const { layerManager } = (window as any).__debugPixi;
    const [pixels] = await layerManager.readAsync(id, [view]);
    let binary = '';
    for (let i = 0; i < pixels.length; i += 8192) binary += String.fromCharCode(...pixels.subarray(i, i + 8192));
    return btoa(binary);
  }, { id: layerId, view });
  return Buffer.from(bytes, 'base64');
}

function differences(actual: Pixels, expected: Pixels) {
  let count = 0;
  for (let i = 0; i < expected.length; i += 4) {
    if (actual.readUInt32LE(i) !== expected.readUInt32LE(i)) count++;
  }
  return count;
}

function samples(actual: Pixels, expected: Pixels) {
  const result: Array<{ x: number; y: number; actual: number[]; expected: number[] }> = [];
  for (let i = 0; i < expected.length && result.length < 4; i += 4) {
    if (actual.readUInt32LE(i) !== expected.readUInt32LE(i)) result.push({
      x: (i / 4) % view.w, y: Math.floor(i / 4 / view.w),
      actual: [...actual.subarray(i, i + 4)], expected: [...expected.subarray(i, i + 4)],
    });
  }
  return result;
}

async function paint(page: Page, points: Point[]) {
  await page.evaluate(async (path) => {
    const { app, viewport } = (window as any).__debugPixi;
    const surface = document.querySelector('.atelier-canvas-viewport')!;
    const rect = app.canvas.getBoundingClientRect();
    const time = performance.now();
    const send = (type: string, [x, y, pressure = 0.7]: Point, index: number) => {
      const p = viewport.canvasToScreen(x, y);
      const down = type === 'pointerdown';
      const up = type === 'pointerup';
      const event = new PointerEvent(type, { bubbles: true, pointerId: 41, pointerType: 'pen', isPrimary: true,
        clientX: rect.left + p.x, clientY: rect.top + p.y, button: down || up ? 0 : -1,
        buttons: up ? 0 : 1, pressure: up ? 0 : pressure });
      Object.defineProperty(event, 'timeStamp', { value: time + index * 16 });
      surface.dispatchEvent(event);
    };
    send('pointerdown', path[0], 0);
    for (let index = 1; index < path.length; index++) {
      send('pointermove', path[index], index);
      await new Promise(requestAnimationFrame);
    }
    send('pointerup', path[path.length - 1], path.length);
    const [x, y] = path[path.length - 1];
    surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 41,
      pointerType: 'pen', isPrimary: true, buttons: 0, clientX: rect.left + viewport.canvasToScreen(x + 45, y + 45).x,
      clientY: rect.top + viewport.canvasToScreen(x + 45, y + 45).y }));
  }, points.map(([x, y, p]): Point => [x + view.x, y + view.y, p]));
}

async function mousePath(page: Page, points: Point[]) {
  const [endX, endY] = points[points.length - 1];
  const path: Point[] = [...points, [endX + 45, endY + 45]];
  const screen = await page.evaluate(path => {
    const { app, viewport } = (window as any).__debugPixi;
    const rect = app.canvas.getBoundingClientRect();
    return path.map(([x, y]) => {
      const p = viewport.canvasToScreen(x, y);
      return { x: rect.left + p.x, y: rect.top + p.y };
    });
  }, path.map(([x, y]) => [x + view.x, y + view.y]));
  const hover = screen.pop()!;
  await page.mouse.move(screen[0].x, screen[0].y);
  await page.mouse.down();
  for (const point of screen.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(hover.x, hover.y);
}

async function main() {
  process.env.DATA_DIR = join(work, 'server');
  process.env.DATABASE_PATH = join(work, 'server', 'atelier.db');
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const failures: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let observer: ReturnType<typeof io> | undefined;
  try {
    async function post(url: string, payload: object, token?: string, method: 'POST' | 'PATCH' = 'POST') {
      const response = await app.inject({ method, url, payload,
        headers: token ? { authorization: `Bearer ${token}` } : {} });
      assert.ok(response.statusCode < 300, response.body);
      return response.json();
    }
    const password = 'shared-brush-browser-test';
    const chromeAccount = await post('/api/auth/register', { username: 'chromepainter', password });
    const desktopAccount = await post('/api/auth/register', { username: 'desktoppainter', password });
    const { canvas } = await post('/api/canvases', {
      title: 'Shared brush study', width: large ? 10000 : 512, height: large ? 8000 : 512,
    }, chromeAccount.token);
    const layerUrl = `/api/canvases/${canvas.id}/layers`;
    const makeLayer = async (name: string) => (await post(layerUrl, { name, aclMode: 'shared_all' }, chromeAccount.token)).layer.id as string;
    const initial = await makeLayer('Initial');

    const chromeExe = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await chromium.launch({ executablePath: chromeExe, headless: true, args: ['--enable-unsafe-swiftshader'] });
    const chrome = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const dirs = ['appdata', 'localappdata', 'userdata'].map(name => join(work, name));
    for (const path of dirs) mkdirSync(path);
    desktop = await _electron.launch({
      executablePath: desktopExecutable ?? join(client, 'node_modules/electron/dist/electron.exe'),
      args: [...(desktopExecutable ? [] : [client]), `--user-data-dir=${dirs[2]}`, '--enable-unsafe-swiftshader'],
      env: { ...process.env, APPDATA: dirs[0], LOCALAPPDATA: dirs[1], VITE_DEV_SERVER_URL: '' },
    });
    const electron = await desktop.firstWindow();
    const pages = [chrome, electron];
    for (const page of pages) {
      page.on('pageerror', error => console.error(new URL(page.url()).protocol, error.message));
      page.on('console', message => {
        if (message.type() === 'error' || (message.type() === 'warning' && message.text().includes('[undo]')))
          console.error(new URL(page.url()).protocol, message.text());
      });
    }
    async function open(page: Page, token: string, level: number) {
      await page.addInitScript(({ token, id, level, origin }) => {
        (window as any).__name = (value: unknown) => value;
        localStorage.setItem('atelier_language', 'en-US');
        localStorage.setItem('atelier_token', token);
        localStorage.setItem('atelier_active_canvas_id', id);
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_server_url', origin);
        localStorage.setItem('atelier_brush_tools', JSON.stringify({ brush: {
          size: 24, minSize: 0.8, stabilizerLevel: level, hardness: 0.8, spacing: 0.04,
        } }));
      }, { token, id: canvas.id, level, origin });
      if (page === chrome) await page.goto(origin);
      else await page.reload();
      await page.locator(`[data-layer-id="${initial}"]`).waitFor();
      await page.locator('[data-canvas-presented="true"]').waitFor();
      if (large) {
        await page.evaluate(({ x, y }) => {
          const { app, viewport } = (window as any).__debugPixi;
          viewport.setZoom(1);
          const p = viewport.canvasToScreen(x + 256, y + 256);
          viewport.panBy(app.screen.width / 2 - p.x, app.screen.height / 2 - p.y);
        }, view);
      }
    }
    await Promise.all([open(chrome, chromeAccount.token, 3.5), open(electron, desktopAccount.token, 9.5)]);
    assert.equal(new URL(electron.url()).protocol, 'file:', 'desktop uses the local build');
    console.log('Connected Chrome and compiled Electron to', origin, 'isolated under', work);

    observer = io(origin, { auth: { token: chromeAccount.token }, transports: ['websocket'], parser: tileSocketParser(socketParser) });
    const committed: { layerId: string; opType: string; seq: number }[] = [];
    observer.on('op_broadcast', packet => committed.push(packet));
    const ready = new Promise<void>(resolve => observer!.once('room_state', () => resolve()));
    observer.emit('join_canvas', { canvasId: canvas.id });
    await ready;
    async function action(page: Page, id: string, type: string, run: () => Promise<void>) {
      const from = committed.length;
      await run();
      for (let tries = 0; tries < 100; tries++) {
        if (committed.slice(from).some(op => op.layerId === id && op.opType === type)) {
          await page.waitForTimeout(350);
          return;
        }
        await page.waitForTimeout(50);
      }
      console.error('Recent server operations:', committed.slice(from));
      console.error('History state:', JSON.stringify(await page.evaluate(() => {
        const { undo } = (window as any).__debugPixi;
        const summarize = (ops: any[]) => ops.map(({ layerId, opType, seq, beforeTiles }) =>
          ({ layerId, opType, seq, tiles: beforeTiles.length }));
        return { stacks: Object.fromEntries(Object.entries(undo.inspect()).map(([key, value]) =>
          [key, summarize(value as any[])])), focused: document.activeElement?.outerHTML.slice(0, 170),
          modal: document.querySelector('[aria-modal=true]')?.getAttribute('aria-label') };
      })));
      throw new Error(`No ${type} committed for ${id} on ${page.url()}`);
    }
    async function select(id: string) {
      for (const page of pages) {
        await page.locator(`[data-layer-id="${id}"]`).click();
        await page.waitForFunction((id) => (window as any).__debugPixi?.layerManager?.getLayerItem(id), id);
        await page.keyboard.press('b');
      }
    }
    async function compare(label: string, id: string, expected: Pixels) {
      const pixels = await Promise.all(pages.map(page => read(page, id)));
      const errors = pixels.map(actual => differences(actual, expected));
      console.log(`${label}: Chrome ${errors[0]}, Electron ${errors[1]} differing pixels`);
      if (errors.some(Boolean)) {
        failures.push(label);
        console.log('Pixel samples:', JSON.stringify(samples(pixels[errors[0] ? 0 : 1], expected)));
      }
    }
    const center = large ? 256 : 256.25;
    const routes: Point[][] = [
      Array.from({ length: 25 }, (_, i) => [112 + i * 12, center]),
      Array.from({ length: 25 }, (_, i) => [center, 112 + i * 12]),
    ];
    const blank = Buffer.alloc(512 * 512 * 4);
    const reopen: { id: string; pixels: Pixels; label: string }[] = [];
    const undo = (page: Page, id: string) => action(page, id, 'TILE_PATCH', () => page.keyboard.press('Control+z'));
    const redo = (page: Page, id: string) => action(page, id, 'TILE_PATCH', () => page.keyboard.press('Control+Shift+z'));
    if (process.argv.includes('--mixed-input')) {
      const { autoCreateCheckpoint } = await import('../src/services/snapshot.service');
      for (const page of pages) {
        for (const penFirst of [false, true]) {
          const label = `${page === chrome ? 'Chrome' : 'Electron'} ${penFirst ? 'pen → mouse' : 'mouse → pen'}`;
          const id = await makeLayer(label);
          await select(id);
          const firstStroke = penFirst ? paint : mousePath;
          const secondStroke = penFirst ? mousePath : paint;
          const oldArt: Point[] = Array.from({ length: 25 }, (_, i) => [112 + i * 12, center - 22]);
          await action(page, id, 'STROKE', () => mousePath(page, oldArt));
          const existing = await read(page, id);
          assert.ok(differences(existing, blank), `${label}: existing art must be visible`);
          if (process.argv.includes('--reopen')) {
            assert.ok(autoCreateCheckpoint(canvas.id), 'the older art must be saved to a checkpoint');
            await Promise.all([open(chrome, chromeAccount.token, 3.5), open(electron, desktopAccount.token, 9.5)]);
            await select(id);
            await compare(`${label}: old art after reopening`, id, existing);
          }

          await action(page, id, 'STROKE', () => firstStroke(page, routes[0]));
          const beforeSecond = await read(page, id);
          assert.ok(differences(beforeSecond, existing), `${label}: first stroke must change pixels`);
          await action(page, id, 'STROKE', () => secondStroke(page, routes[1]));
          const afterSecond = await read(page, id);
          assert.ok(differences(afterSecond, beforeSecond), `${label}: second stroke must change pixels`);

          await undo(page, id);
          await compare(`${label}: undo only the second stroke`, id, beforeSecond);
          await redo(page, id);
          await compare(`${label}: redo the second stroke`, id, afterSecond);
          await undo(page, id);
          await undo(page, id);
          await compare(`${label}: two undos preserve the existing art`, id, existing);
        }
      }
      assert.deepEqual(failures, [], 'Mixed mouse and pen history must preserve every existing pixel');
      return;
    }
    const layerIds = (page: Page) => page.evaluate(() =>
      (window as any).__debugPixi.layerManager.getLayers().map((item: any) => item.model.id) as string[]);
    async function addedLayer(page: Page, run: () => Promise<void>) {
      const prior = await layerIds(page);
      await run();
      await page.waitForFunction(ids => (window as any).__debugPixi.layerManager.getLayers().some((item: any) => !ids.includes(item.model.id)), prior);
      const id = (await layerIds(page)).find(id => !prior.includes(id))!;
      for (const other of pages) await other.waitForFunction(id => (window as any).__debugPixi.layerManager.getLayerItem(id), id);
      return id;
    }
    async function removeLayer(id: string, run: () => Promise<void>) {
      await run();
      for (const other of pages) await other.waitForFunction(id => !(window as any).__debugPixi.layerManager.getLayerItem(id), id);
    }
    await select(initial);
    for (const [index, page] of pages.entries()) {
      const slider = page.getByRole('slider', { name: 'Stabilization', exact: true }).first();
      const level = index === 0 ? 3.5 : 9.5;
      if (baseline) {
        console.log(`Baseline ${index} loaded stabilization ${await slider.inputValue()} (requested ${level})`);
        continue;
      }
      assert.equal(Number(await slider.inputValue()), level, 'half-stage preferences loaded');
      const attrs = await Promise.all(['min', 'max', 'step'].map(name => slider.getAttribute(name)));
      assert.deepEqual(attrs, ['0', '10', '0.5']);
      await slider.press('Home');
      for (let step = 0; step < 21; step++) {
        assert.equal(Number(await slider.inputValue()), step / 2);
        if (step < 20) await slider.press('ArrowRight');
      }
      for (let step = 10; step > level; step -= 0.5) await slider.press('ArrowLeft');
      assert.equal(Number(await slider.inputValue()), level);
    }
    if (!baseline) console.log('Chrome and Electron: all 21 stabilization settings, 3.5 / 9.5 restored');
    if (large) {
      // Black isolates alpha coverage from the GPU's 8-bit tint rounding on repainted edges.
      for (const page of pages) {
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.keyboard.press('s');
        const hex = page.getByRole('textbox', { name: 'HEX Code', exact: true }).first();
        await hex.fill('#000000');
        await hex.blur();
      }
    }
    for (const aa of toolsOnly ? [] : ['medium', 'none']) {
      await select(initial);
      for (const page of pages) {
        await page.getByRole('radio', { name: aa === 'none' ? 'Anti-aliasing: None' : 'Anti-aliasing: Medium' }).first().click();
      }
      const solo: Pixels[] = [];
      for (const [index, page] of pages.entries()) {
        const id = await makeLayer(`${aa} solo ${index}`);
        await select(id);
        await action(page, id, 'STROKE', () => paint(page, routes[index]));
        solo[index] = await read(page, id);
        assert.ok(differences(solo[index], blank) > 500, 'solo paint is visible');
        await compare(`${aa} solo ${index}`, id, solo[index]);
      }
      const crossedTiles = new Set<number>();
      for (let i = 3; i < blank.length; i += 4) {
        if (solo[0][i] && solo[1][i]) {
          const pixel = (i - 3) / 4;
          crossedTiles.add(Math.floor((pixel % view.w) / 256) + 2 * Math.floor(pixel / view.w / 256));
        }
      }
      assert.equal(crossedTiles.size, 4, 'the two strokes overlap on all four tiles');
      for (const first of [0, 1]) {
        const second = 1 - first;
        const id = await makeLayer(`${aa} shared ${first}`);
        await select(id);
        await action(pages[first], id, 'STROKE', () => paint(pages[first], routes[first]));
        await compare(`${aa} ${first} first`, id, solo[first]);
        await action(pages[second], id, 'STROKE', () => paint(pages[second], routes[second]));
        const both = await read(pages[second], id);
        await compare(`${aa} ${first} crossed`, id, both);
        await undo(pages[first], id);
        await compare(`${aa} ${first} undo first`, id, solo[second]);
        await undo(pages[second], id);
        await compare(`${aa} ${first} undo second`, id, blank);
        await redo(pages[second], id);
        await compare(`${aa} ${first} redo second alone`, id, solo[second]);
        await redo(pages[first], id);
        await compare(`${aa} ${first} redo both`, id, both);
        await undo(pages[second], id);
        await compare(`${aa} ${first} undo newest`, id, solo[first]);
        await undo(pages[first], id);
        await compare(`${aa} ${first} undo oldest last`, id, blank);
        await redo(pages[second], id);
        await compare(`${aa} ${first} redo newest on empty`, id, solo[second]);
        await undo(pages[second], id);
        await compare(`${aa} ${first} undo newest on empty`, id, blank);
        await redo(pages[first], id);
        await compare(`${aa} ${first} redo oldest alone`, id, solo[first]);
        await redo(pages[second], id);
        await compare(`${aa} ${first} redo newest last`, id, both);
        if (first === 1) {
          await undo(pages[first], id);
          await undo(pages[second], id);
          await compare(`${aa} ${first} empty before reopening`, id, blank);
        }
        reopen.push({ id, pixels: first === 1 ? blank : both, label: `${aa} ${first}` });
      }
    }
    if (!large && !baseline) {
      await select(initial);
      for (const page of pages) await page.getByRole('radio', { name: 'Anti-aliasing: None' }).first().click();
      for (const [index, page] of pages.entries()) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const id = await makeLayer(`Mouse start ${index} ${attempt}`);
          await select(id);
          await action(page, id, 'STROKE', () => mousePath(page, [[126, 126], [230, 126], [230, 215], [340, 215]]));
          const pixels = await read(page, id);
          const alpha = (x: number, y: number) => pixels[(y * 512 + x) * 4 + 3];
          const followedTurn = Array.from({ length: 21 }, (_, i) => alpha(220 + i, 170)).some(Boolean) &&
            Array.from({ length: 21 }, (_, i) => alpha(295, 205 + i)).some(Boolean);
          assert.ok(alpha(126, 126) > 0 && alpha(180, 126) > 0 && followedTurn &&
            alpha(340, 215) > 0 && alpha(385, 260) === 0, `mouse start, line, turn, endpoint and hover on ${page.url()}`);
          await compare(`mouse ${index} start ${attempt}`, id, pixels);
          await undo(page, id);
          await compare(`mouse ${index} undo ${attempt}`, id, blank);
        }
        const id = await makeLayer(`Pressure ${index}`);
        await select(id);
        for (const browserPage of pages) await browserPage.getByRole('radio', { name: 'Anti-aliasing: Medium' }).first().click();
        const pressureLine = (y: number, pressure: number): Point[] => Array.from({ length: 23 }, (_, i) => [118 + i * 12, y, pressure]);
        await action(page, id, 'STROKE', () => paint(page, pressureLine(170, 0.18)));
        const light = await read(page, id);
        await undo(page, id);
        await compare(`pressure ${index} light undone`, id, blank);
        await action(page, id, 'STROKE', () => paint(page, pressureLine(170, 0.87)));
        const heavy = await read(page, id);
        assert.ok(differences(heavy, blank) > differences(light, blank), 'higher simulated pressure deposits more pixels');
        await compare(`pressure ${index} heavy`, id, heavy);
        await undo(page, id);
        await compare(`pressure ${index} heavy undone`, id, blank);
      }
      // A red Electron stroke over a blue Chrome stroke, followed by applying and undoing an invert.
      await select(initial);
      await electron.keyboard.press('s');
      const hex = electron.getByRole('textbox', { name: 'HEX Code', exact: true }).first();
      await hex.fill('#DE2F27');
      await hex.blur();
      await electron.keyboard.press('b');
      const soloLayer = await makeLayer('Red baseline');
      await select(soloLayer);
      await action(electron, soloLayer, 'STROKE', () => paint(electron, routes[1]));
      const red = await read(electron, soloLayer);
      const overlap = await makeLayer('Red and blue, invert history');
      await select(overlap);
      await action(chrome, overlap, 'STROKE', () => paint(chrome, routes[0]));
      const blue = await read(chrome, overlap);
      assert.notEqual(red.readUInt32LE((256 * 512 + 256) * 4), blue.readUInt32LE((256 * 512 + 256) * 4));
      await action(electron, overlap, 'STROKE', () => paint(electron, routes[1]));
      const crossed = await read(electron, overlap);
      await compare('different color crossing', overlap, crossed);
      for (const [index, page] of pages.entries()) {
        await page.getByTitle('Layer Filters', { exact: true }).click();
        await page.getByRole('button', { name: '負片', exact: true }).click();
        await action(page, overlap, 'TILE_PATCH', () => page.getByRole('button', { name: 'Apply', exact: true }).click());
        const inverted = await read(page, overlap);
        assert.ok(differences(inverted, crossed) > 500, 'invert applied');
        await compare(`invert ${index} applied`, overlap, inverted);
        await undo(page, overlap);
        await compare(`invert ${index} undone`, overlap, crossed);
        await redo(page, overlap);
        await compare(`invert ${index} redone`, overlap, inverted);
        await undo(page, overlap);
      }
      await undo(electron, overlap);
      await compare('undo peer stroke after undoing invert', overlap, blue);
      await redo(electron, overlap);
      await compare('redo peer stroke after undoing invert', overlap, crossed);
      await undo(chrome, overlap);
      await compare('older different color stroke undone', overlap, red);
      await undo(electron, overlap);
      await compare('both different color strokes undone', overlap, blank);

      for (const [index, page] of pages.entries()) {
        for (const [key, opType, label] of [['u', 'STROKE', 'shape'], ['g', 'TILE_PATCH', 'bucket']] as const) {
          const id = await makeLayer(`${label} ${index}`);
          await select(id);
          await page.keyboard.press(key);
          await action(page, id, opType, () => mousePath(page, key === 'u' ? [[145, 155], [340, 340]] : [[256, 256]]));
          const pixels = await read(page, id);
          assert.ok(differences(pixels, blank) > 500, `${label} painted`);
          await compare(`${label} ${index} applied`, id, pixels);
          await undo(page, id);
          await compare(`${label} ${index} undone`, id, blank);
          await redo(page, id);
          await compare(`${label} ${index} redone`, id, pixels);
        }
        await page.locator(`[data-layer-id="${initial}"]`).click();
        const created = await addedLayer(page, () => page.getByRole('button', { name: 'New Raster Layer', exact: true }).click());
        await removeLayer(created, () => page.keyboard.press('Control+z'));
        const restored = await addedLayer(page, () => page.keyboard.press('Control+Shift+z'));
        await page.locator(`[data-layer-id="${restored}"]`).click();
        await removeLayer(restored, () => page.keyboard.press('Control+Delete'));
        const deletedRestored = await addedLayer(page, () => page.keyboard.press('Control+z'));
        await removeLayer(deletedRestored, () => page.keyboard.press('Control+Shift+z'));
        console.log(`${index} created/deleted raster layer, undo and redo, synced to both`);
      }

      const { layer: folder } = await post(layerUrl, {
        name: 'Collaboration Animation', layerType: 'group', meta: { animation: { fps: 12, shared: true } },
      }, chromeAccount.token);
      const access = `${layerUrl}/${folder.id}/folder-access`;
      await post(access, {}, desktopAccount.token);
      await post(`${access}/${desktopAccount.user.id}`, { approved: true }, chromeAccount.token, 'PATCH');
      for (const page of pages) {
        await page.locator(`[data-layer-id="${folder.id}"]`).click();
        await page.keyboard.press('Control+Shift+a');
      }
      const nextCel = (page: Page) => page.getByRole('button', { name: 'New Cel', exact: true }).click();
      const cel1 = await addedLayer(chrome, () => nextCel(chrome));
      const cel2 = await addedLayer(electron, () => nextCel(electron));
      await removeLayer(cel2, () => electron.keyboard.press('Control+z'));
      const cel2Restored = await addedLayer(electron, () => electron.keyboard.press('Control+Shift+z'));
      for (const [index, id] of [cel1, cel2Restored].entries()) {
        await select(id);
        const page = pages[index];
        await action(page, id, 'STROKE', () => paint(page, routes[index]));
        const pixels = await read(page, id);
        assert.ok(differences(pixels, blank) > 500, 'the cel contains its own drawing');
        await undo(page, id);
        await compare(`animation cel ${index} undone`, id, blank);
        await redo(page, id);
        await compare(`animation cel ${index} redone`, id, pixels);
        reopen.push({ id, pixels, label: `animation cel ${index}` });
      }
      for (const page of pages) {
        const timeline = page.getByRole('toolbar', { name: 'Animation Timeline' });
        await timeline.getByRole('button', { name: 'Play Animation', exact: true }).click();
        await page.waitForFunction(() => (window as any).__debugPixi.animationEngine.getIsPlaying());
        await timeline.getByRole('button', { name: 'Pause Playback', exact: true }).click();
      }
      console.log('Chrome and Electron: animation cel creation, undo, redo, pixel sync and playback');
    }
    if (large) {
      for (const page of pages) {
        const fullTextures = await page.evaluate(() =>
          (window as any).__debugPixi.layerManager.getLayers().filter((item: any) => item.rt).length);
        assert.equal(fullTextures, 0, 'shared brush keeps the 10,000 × 8,000 canvas tiled');
      }
    }
    await Promise.all(pages.map(page => page.reload()));
    for (const page of pages) {
      await page.waitForFunction(id => (window as any).__debugPixi?.layerManager?.getLayerItem(id), reopen[0].id);
    }
    await chrome.waitForTimeout(1500);
    for (const { id, pixels, label } of reopen) await compare(`reopened ${label} server canvas`, id, pixels);
    assert.deepEqual(failures, []);
  } finally {
    observer?.close();
    await desktop?.close();
    await browser?.close();
    await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { chromium, type Page } from 'playwright-core';
import type { WinTabUpdate } from '../../client/electron/tabletProtocol';

const password = 'round12-browser-password';

async function preferences(page: Page) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('tab', { name: 'Stylus Test' }).click();
  return page.getByRole('dialog');
}

async function mouseStrokeWithMissingSamples(page: Page, points: { x: number; y: number }[]) {
  const suppressMove = await page.evaluateHandle(() => {
    const controller = new AbortController();
    window.addEventListener('pointermove', event => {
      if (event.isTrusted && event.pointerType === 'mouse' && (event.buttons & 1) !== 0) event.stopPropagation();
    }, { capture: true, signal: controller.signal });
    return controller;
  });
  const [start, firstEnd, secondStart, end] = points;
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(firstEnd.x, firstEnd.y, { steps: 5 });
    await page.waitForTimeout(120);
    await page.mouse.move(secondStart.x, secondStart.y);
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
  } finally {
    await suppressMove.evaluate(controller => controller.abort());
    await suppressMove.dispose();
  }
}

async function blackStripe(page: Page, layerId: string) {
  await page.evaluate((id) => {
    const { layerManager } = (window as any).__debugPixi;
    const w = 280, h = 42;
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    layerManager.writeRegion(id, 108, 269, w, h, pixels);
  }, layerId);
}

async function rgbaRow(page: Page, layerId: string, x: number, y = 290, width = 1) {
  return page.evaluate(async ({ layerId, x, y, width }) => {
    const { layerManager } = (window as any).__debugPixi;
    const [pixels]: Uint8Array[] = await layerManager.readAsync(layerId, [{ x, y, w: width, h: 1 }]);
    return Array.from(pixels);
  }, { layerId, x, y, width });
}

async function alphaRow(page: Page, layerId: string, x: number, y = 290, width = 1) {
  return (await rgbaRow(page, layerId, x, y, width)).filter((_, i) => i % 4 === 3);
}

async function waitForAlpha(page: Page, layerId: string, x: number, alpha: number, y = 290) {
  await page.waitForFunction(async ({ layerId, x, y, alpha }) => {
    const { layerManager } = (window as any).__debugPixi;
    const [pixel]: Uint8Array[] = await layerManager.readAsync(layerId, [{ x, y, w: 1, h: 1 }]);
    return pixel[3] === alpha;
  }, { layerId, x, y, alpha }, { timeout: 6000 });
}

async function tailEvent(page: Page, type: string, x: number, buttons: number, button = -1,
    source?: 'wintab' | 'ink', inverted = true, y = 290, pressure = 1) {
  await page.locator('.atelier-canvas-viewport').evaluate((element, event) => {
    const win = window as any;
    const { viewport, app } = win.__debugPixi;
    const point = viewport.canvasToScreen(event.x, event.y);
    const rect = app.canvas.getBoundingClientRect();
    const clientX = point.x + rect.left, clientY = point.y + rect.top;
    const contact = event.buttons !== 0;
    const sample = { x: clientX, y: clientY, time: Date.now(), cursor: 12, pressure: event.pressure, contact, eraser: event.inverted };
    if (event.source) win.tabletReport({
      generation: 4, status: 'ready',
      samples: event.source === 'wintab' ? [sample] : [],
      inkSample: event.source === 'ink' && event.inverted ? sample : null,
      inkSamples: event.source === 'ink' ? [sample] : [],
    });
    element.dispatchEvent(new PointerEvent(event.type, {
      bubbles: true, pointerId: 42, pointerType: 'pen', clientX, clientY,
      button: event.button, buttons: event.buttons, pressure: contact ? event.pressure : 0,
    }));
  }, { type, x, y, buttons, button, source, inverted, pressure });
}

async function main() {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'lumina-tablet-web-'));
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const live = process.argv.includes('--live');
  const origin = live ? await app.listen({ host: '127.0.0.1', port: 0 }) : 'http://localhost:3102';
  if (live) console.log(`Live browser and collaboration test at ${origin}`);
  async function call(url: string, payload: object, token?: string) {
    const result = await app.inject({ method: 'POST', url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.ok(result.statusCode < 300, result.body);
    return result.json();
  }
  const account = await call('/api/auth/register', { username: 'tabletpainter', password });
  const collaborator = live ? await call('/api/auth/register', { username: 'tabletpeer', password }) : undefined;
  const { canvas } = await call('/api/canvases', { title: 'Tablet studio', width: 512, height: 512 }, account.token);
  const { layer } = await call(`/api/canvases/${canvas.id}/layers`, { name: 'Pressure samples', aclMode: 'shared_all' }, account.token);
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  async function open(mock: boolean, authenticated = mock, token = account.token) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
    if (!live) await page.route(origin + '/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await app.inject({
        url: url.pathname + url.search, method: request.method() as InjectOptions['method'],
        headers: request.headers(), payload: request.postDataBuffer() ?? undefined,
      });
      const headers = Object.fromEntries(Object.entries(response.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
    });
    if (!live) await page.routeWebSocket(/\/socket\.io\//, (socket) => {
      socket.send('0{"sid":"tablet-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
      socket.onMessage((message) => {
        if (typeof message !== 'string') return;
        if (message.startsWith('40')) socket.send('40{"sid":"tablet-socket"}');
        if (message.startsWith('42["join_canvas"')) socket.send('42' + JSON.stringify(['room_state', {
          canvasId: canvas.id, latestSeq: 0, members: [], offlineMembers: [],
        }]));
      });
    });
    await page.addInitScript(({ canvasId, token, mock, authenticated, origin }) => {
      const state = window as any;
      state.__name = (value: unknown) => value;
      localStorage.setItem('atelier_language', 'en-US');
      if (!localStorage.getItem('atelier_brush_tools')) localStorage.setItem('atelier_brush_tools', JSON.stringify({
        brush: { size: 48, minSize: 1, stabilizerLevel: 0, hardness: 1 },
        eraser: { size: 40, minSize: 1, stabilizerLevel: 0, flow: 0.09, customBrushUrl: null },
      }));
      if (!authenticated) return;
      localStorage.setItem('atelier_token', token);
      localStorage.setItem('atelier_active_canvas_id', canvasId);
      localStorage.setItem('atelier_gateway_resolved', 'true');
      localStorage.setItem('atelier_server_url', origin);
      if (!mock) return;
      state.configureHistory = [];
      state.tabletReads = 0;
      let report: (update: WinTabUpdate) => void;
      state.tabletReport = (update: WinTabUpdate) => report(update);
      state.atelierDesktop = { isElectron: true, platform: 'win32', tablet: {
        configure: (enabled: boolean) => {
          state.configureHistory.push(enabled);
          report({ status: enabled ? 'driver-missing' : 'disabled', generation: 0, samples: [] });
        },
        read: () => { state.tabletReads++; return null; },
        subscribe: (callback: typeof report) => { report = callback; return () => {}; },
      } };
    }, { canvasId: canvas.id, token, mock, authenticated, origin });
    await page.goto(origin);
    return page;
  }

  try {
    const page = await open(false);
    await page.getByRole('radio', { name: /Tablet studio/ }).click();
    await page.getByRole('button', { name: 'Join "Tablet studio"' }).click();
    await page.getByRole('button', { name: 'Sign In / Register', exact: true }).click();
    const auth = page.getByRole('dialog');
    await auth.getByRole('textbox', { name: 'Username' }).fill('tabletpainter');
    await auth.getByLabel('Password', { exact: true }).fill(password);
    await auth.getByRole('button', { name: 'Sign In', exact: true }).click();
    await auth.waitFor({ state: 'hidden' });
    const row = page.locator(`[data-layer-id="${layer.id}"]`);
    await row.click();

    const settings = await preferences(page);
    assert.equal(await settings.getByRole('combobox', { name: 'Selected mode' }).count(), 0);
    assert.equal(await settings.locator('[data-tablet-mode]').getAttribute('data-tablet-mode'), 'browser');
    const threshold = settings.getByRole('slider');
    for (let i = 0; i < 15; i++) await threshold.press('ArrowRight');
    assert.equal(await threshold.inputValue(), '15');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('atelier_stylus_pressure_curve')!).deadZone), 0.15);
    const preview = await settings.locator('canvas').boundingBox();
    assert.ok(preview);
    const cdp = await page.context().newCDPSession(page);
    const pen = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number, force: number) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', force, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await pen('mousePressed', preview.x + 35, preview.y + 40, 0.3);
    assert.ok(Math.abs(Number(await settings.locator('[data-pressure-raw]').getAttribute('data-pressure-raw')) - 0.3) < 0.01);
    const mapped = Number(await settings.locator('[data-pressure-mapped]').getAttribute('data-pressure-mapped'));
    assert.ok(Math.abs(mapped - (0.3 - 0.15) / 0.85) < 0.01);
    await pen('mouseReleased', preview.x + 35, preview.y + 40, 0);
    assert.equal(await threshold.getAttribute('max'), '20');
    assert.ok(await settings.getByText('Softer', { exact: true }).isVisible());
    assert.ok(await settings.getByText('Firmer', { exact: true }).isVisible());
    assert.ok(await settings.getByText('Input pressure', { exact: true }).isVisible());
    assert.ok(await settings.getByText('Output pressure', { exact: true }).isVisible());
    const outputs: number[] = [];
    for (const name of ['Softer 2', 'Softer 1', 'Linear pressure', 'Firmer 1', 'Firmer 2']) {
      const preset = settings.getByRole('button', { name, exact: true });
      await preset.click();
      assert.equal(await preset.getAttribute('aria-pressed'), 'true');
      await pen('mousePressed', preview.x + 35, preview.y + 40, 0.35);
      outputs.push(Number(await settings.locator('[data-pressure-mapped]').getAttribute('data-pressure-mapped')));
      await pen('mouseReleased', preview.x + 35, preview.y + 40, 0);
    }
    assert.ok(outputs.every((value, i) => !i || outputs[i - 1] - value > 0.05),
      `each preset changes light-pressure output visibly: ${outputs}`);
    await settings.getByRole('button', { name: 'Linear pressure', exact: true }).click();
    assert.equal(await threshold.inputValue(), '15', 'presets preserve the light-touch threshold');
    for (const index of [1, 2]) {
      const control = settings.getByLabel(`Pressure curve ${index}`, { exact: true });
      for (let step = 0; step < 20; step++) {
        await control.press('Shift+ArrowRight');
        await control.press('Shift+ArrowDown');
      }
    }
    const extreme = await page.evaluate(() => JSON.parse(localStorage.getItem('atelier_stylus_pressure_curve')!).bezierPoints);
    assert.deepEqual(extreme, [1, 0, 1, 0]);
    await settings.getByRole('button', { name: 'Linear pressure', exact: true }).click();
    const control = settings.getByLabel('Pressure curve 1', { exact: true });
    const drag = await control.evaluate(el => {
      const graph = (el as SVGCircleElement).ownerSVGElement!;
      const transform = graph.getScreenCTM()!;
      const start = new DOMPoint(Number(el.getAttribute('cx')), Number(el.getAttribute('cy'))).matrixTransform(transform);
      const end = new DOMPoint(15, 15).matrixTransform(transform);
      return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
    });
    await page.mouse.move(drag.start.x, drag.start.y);
    await page.mouse.down();
    await page.mouse.move(drag.end.x, drag.end.y, { steps: 4 });
    await page.mouse.up();
    const [dragX, dragY] = await page.evaluate(() => JSON.parse(localStorage.getItem('atelier_stylus_pressure_curve')!).bezierPoints);
    assert.equal(dragX, 0, 'dragging left of the light-touch threshold clamps input at its start');
    assert.ok(dragY > 0.95, 'output can independently reach the top of the chart');
    await settings.getByRole('button', { name: 'Reset curve', exact: true }).click();
    for (let i = 0; i < 15; i++) await threshold.press('ArrowRight');
    const continuous = await settings.locator('canvas').evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext('2d')!;
      const { left, top, width, height } = el.getBoundingClientRect();
      const y = 100;
      const samples = [72, 132];
      const before = samples.map(x => Array.from(ctx.getImageData(x, y, 1, 1).data));
      const send = (type: string, x: number, buttons: number, pressure: number) =>
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, pointerId: 55, pointerType: 'pen', clientX: left + x * width / el.width,
          clientY: top + y * height / el.height, button: type === 'pointermove' ? -1 : 0, buttons, pressure,
        }));
      send('pointerdown', 40, 1, 0.75);
      send('pointermove', 100, 1, 0);
      send('pointermove', 160, 1, 0.75);
      send('pointerup', 160, 0, 0);
      return samples.every((x, i) => ctx.getImageData(x, y, 1, 1).data.some((v, j) => v !== before[i][j]));
    });
    assert.ok(continuous, 'preview joins widely spaced samples and continues through zero pressure');
    const previewCanvas = settings.locator('canvas');
    const previewPath = await previewCanvas.evaluate((canvas: HTMLCanvasElement) => {
      const rect = canvas.getBoundingClientRect();
      return [40, 96, 220, 268].map(x => ({ x: rect.left + x * rect.width / canvas.width, y: rect.top + 44 * rect.height / canvas.height }));
    });
    const previewPixels = () => previewCanvas.evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d')!;
      return [68, 160, 244].map(x => Array.from(ctx.getImageData(x, 44, 1, 1).data));
    });
    const previewBefore = await previewPixels();
    await mouseStrokeWithMissingSamples(page, previewPath);
    const previewAfter = await previewPixels();
    assert.notDeepEqual(previewAfter[0], previewBefore[0], 'preview draws the first run from raw mouse movement');
    assert.deepEqual(previewAfter[1], previewBefore[1], 'preview leaves an actual input gap unpainted');
    assert.notDeepEqual(previewAfter[2], previewBefore[2], 'preview draws the second run from raw mouse movement');
    if (process.env.TABLET_SCREENSHOTS) await previewCanvas.screenshot({ path: join(process.env.TABLET_SCREENSHOTS, 'preview-raw-mouse.png') });
    await settings.getByRole('button', { name: 'Close', exact: true }).last().click();
    await settings.waitFor({ state: 'hidden' });

    const coordinates = (x: number, y: number) => page.evaluate(([x, y]) => {
      const { viewport, app } = (window as any).__debugPixi;
      const point = viewport.canvasToScreen(x, y);
      const rect = app.canvas.getBoundingClientRect();
      return { x: rect.left + point.x, y: rect.top + point.y };
    }, [x, y]);
    const waitUndo = async (count: number) => {
      try {
        await page.waitForFunction((count) => (window as any).__debugPixi?.undo.getUndoCount() === count, count, { timeout: 6000 });
      } catch (error) {
        console.error(await page.evaluate(() => ({
          undo: (window as any).__debugPixi?.undo.inspect().undo.map((op: any) => op.opType),
          alerts: Array.from(document.querySelectorAll('[role="alert"]'), (element) => element.textContent),
          events: (window as any).inputTrace,
        })));
        throw error;
      }
    };
    async function penLine(y: number, pressure: number) {
      const start = await coordinates(140, y);
      const end = await coordinates(360, y);
      await page.waitForFunction(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.atelier-canvas-viewport')), start);
      await pen('mousePressed', start.x, start.y, pressure);
      for (let i = 1; i <= 10; i++) await pen('mouseMoved', start.x + i * (end.x - start.x) / 10, start.y, pressure);
      await pen('mouseReleased', end.x, end.y, 0);
    }
    await page.evaluate(() => {
      const trace: unknown[] = [];
      (window as any).inputTrace = trace;
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        document.addEventListener(type, (event) => {
          const e = event as PointerEvent;
          trace.push([type, e.pointerType, e.pointerId, e.buttons, e.pressure, e.clientX, e.clientY,
            Boolean((e.target as HTMLElement).closest('.atelier-canvas-viewport'))]);
          if (trace.length > 18) trace.shift();
        }, { capture: true });
      }
    });
    await penLine(100, 0.3);
    await waitUndo(1);
    await penLine(220, 0.85);
    await waitUndo(2);
    const widths = await page.evaluate(async ({ id }) => {
      const lm = (window as any).__debugPixi.layerManager;
      const pixels: Uint8Array[] = await lm.readAsync(id, [100, 220].map(y => ({ x: 225, y: y - 35, w: 1, h: 70 })));
      return pixels.map((column) => column.filter((alpha, index) => index % 4 === 3 && alpha > 20).length);
    }, { id: layer.id });
    assert.ok(widths[0] > 0 && widths[1] > widths[0] * 1.4, `Light and heavy stroke widths: ${widths}`);
    const mouse = await coordinates(180, 330);
    await page.mouse.click(mouse.x, mouse.y);
    await waitUndo(3);
    const touch = await coordinates(200, 400);
    await page.touchscreen.tap(touch.x, touch.y);
    await waitUndo(4);
    const canvasPath = await Promise.all([40, 105, 270, 340].map(x => coordinates(x, 450)));
    await mouseStrokeWithMissingSamples(page, canvasPath);
    await waitUndo(5);
    assert.ok((await alphaRow(page, layer.id, 75, 450))[0] > 0, 'canvas draws the first raw mouse run');
    assert.deepEqual(await alphaRow(page, layer.id, 185, 450), [0], 'canvas leaves an actual input gap unpainted');
    assert.ok((await alphaRow(page, layer.id, 305, 450))[0] > 0, 'canvas draws the second raw mouse run');
    if (process.env.TABLET_SCREENSHOTS) await page.locator('.atelier-canvas-viewport').screenshot({ path: join(process.env.TABLET_SCREENSHOTS, 'canvas-raw-mouse.png') });
    await page.keyboard.press('Control+z');
    await waitUndo(4);
    for (const x of [75, 305]) await waitForAlpha(page, layer.id, x, 0, 450);
    console.log('Mouse pointerrawupdate: both surfaces draw when pointermove is blocked, leave a 120 ms input gap unpainted, and undo the canvas stroke in one step');
    console.log(`Web: login + join, saved curve + pen preview, light/heavy paint (${widths.join('/')} px), mouse and touch, one undo per stroke`);
    await blackStripe(page, layer.id);
    const tool = (id: string) => page.locator(`[data-tool-id="${id}"]:visible`).first();
    await tool('eraser').click();
    const hard = page.getByRole('radio', { name: 'Hard Edge', exact: true });
    const soft = page.getByRole('radio', { name: 'Soft Edge', exact: true });
    assert.equal(await hard.getAttribute('aria-checked'), 'true');
    const clickAt = async (x: number) => {
      const pos = await coordinates(x, 290);
      await page.mouse.click(pos.x, pos.y);
    };
    assert.deepEqual(await alphaRow(page, layer.id, 160, 266), [0], 'canvas above the black stripe is transparent');
    const observer = collaborator ? await open(false, true, collaborator.token) : undefined;
    if (observer) await observer.waitForFunction(() => Boolean((window as any).__debugPixi?.undo));
    await clickAt(160);
    await waitUndo(5);
    const hardRow = await alphaRow(page, layer.id, 160, 290, 24);
    assert.ok(hardRow.slice(0, 18).every((a) => a === 0) && hardRow.at(-1) === 255, `Hard alpha: ${hardRow}`);
    assert.ok(hardRow.some((a) => a > 0 && a < 255), 'hard boundary has antialiasing');
    if (observer) {
      await waitForAlpha(observer, layer.id, 190, 255);
      await waitForAlpha(observer, layer.id, 160, 0);
    }
    await page.getByRole('button', { name: /^Undo$/ }).click();
    await waitUndo(4);
    await waitForAlpha(page, layer.id, 160, 255);
    if (observer) await waitForAlpha(observer, layer.id, 160, 255);
    await page.getByRole('button', { name: /^Redo$/ }).click();
    await waitUndo(5);
    await waitForAlpha(page, layer.id, 160, 0);
    if (observer) {
      await waitForAlpha(observer, layer.id, 160, 0);
      await observer.locator(`[data-layer-id="${layer.id}"]`).click();
      await tailEvent(observer, 'pointerdown', 160, 1, 0, undefined, false, 290, 0.35);
      await tailEvent(observer, 'pointerup', 160, 0, 0);
      await observer.waitForFunction(() => (window as any).__debugPixi.undo.getUndoCount() === 1);
      const peerPixel = await rgbaRow(observer, layer.id, 160);
      assert.ok(peerPixel[3] > 0 && peerPixel[3] < 255 && peerPixel.slice(0, 3).some(Boolean),
        'peer stroke supplies distinguishable translucent ink in the same tile');
      await waitForAlpha(page, layer.id, 160, peerPixel[3]);
      await page.getByRole('button', { name: /^Undo$/ }).click();
      await waitUndo(4);
      await waitForAlpha(page, layer.id, 174, 255);
      await waitForAlpha(observer, layer.id, 174, 255);
      // Undoing the eraser restores the opaque black stripe beneath the other painter's ink.
      const restored = [...peerPixel.slice(0, 3), 255];
      assert.deepEqual(await rgbaRow(page, layer.id, 160), restored, 'undo restores the background under another artist’s ink');
      assert.deepEqual(await rgbaRow(observer, layer.id, 160), restored);
      await page.getByRole('button', { name: /^Redo$/ }).click();
      await waitUndo(5);
      await waitForAlpha(observer, layer.id, 174, 0);
      await waitForAlpha(page, layer.id, 160, peerPixel[3]);
      await waitForAlpha(observer, layer.id, 160, peerPixel[3]);
      assert.deepEqual(await rgbaRow(observer, layer.id, 160), peerPixel, 'redo removes only the restored background');
      await observer.close();
      console.log('Live Socket.IO: two different artists shared the same tile; own undo and redo preserved the other artist’s stroke');
    }
    await tailEvent(page, 'pointerdown', 205, 1, 0, undefined, false, 290, 0.45);
    await tailEvent(page, 'pointerup', 205, 0, 0);
    await waitUndo(6);
    assert.deepEqual(await alphaRow(page, layer.id, 205), [0], 'low pressure controls size without leaving a trace');
    assert.deepEqual(await alphaRow(page, layer.id, 216), [255]);
    await soft.click();
    await clickAt(250);
    await waitUndo(7);
    const softRow = await alphaRow(page, layer.id, 250, 290, 24);
    assert.ok(softRow[0] < softRow[5] && softRow[5] < softRow[10] && softRow[10] < softRow[15] && softRow[15] < 255 && softRow[23] === 255, `Soft alpha: ${softRow}`);
    await tool('brush').click();
    await tailEvent(page, 'pointermove', 307, 0, 5);
    assert.deepEqual(await alphaRow(page, layer.id, 307), [255], 'hover does not erase');
    await tailEvent(page, 'pointerdown', 305, 0, 5);
    await tailEvent(page, 'pointermove', 315, 32);
    await tailEvent(page, 'pointercancel', 375, 0);
    await tailEvent(page, 'pointerup', 375, 0, 5);
    await waitUndo(8);
    assert.ok((await alphaRow(page, layer.id, 307))[0] < 50);
    assert.deepEqual(await alphaRow(page, layer.id, 375), [255], 'cancel did not stamp its coordinates');
    await tailEvent(page, 'pointerdown', 307, 1, 0, undefined, false, 340);
    await tailEvent(page, 'pointerup', 307, 0, 0, undefined, false, 340);
    await waitUndo(9);
    assert.ok((await alphaRow(page, layer.id, 307, 340))[0] > 250, 'tip paints after using the tail');
    await tool('lasso').click();
    const corners = await Promise.all([[334, 277], [350, 277], [350, 303], [334, 303]].map(([x, y]) => coordinates(x, y)));
    await page.mouse.move(corners[0].x, corners[0].y);
    await page.mouse.down();
    for (const point of corners.slice(1).concat(corners[0])) await page.mouse.move(point.x, point.y, { steps: 3 });
    await page.mouse.up();
    await waitUndo(10);
    await tool('eraser').click();
    await hard.click();
    await clickAt(348);
    await waitUndo(11);
    assert.deepEqual(await alphaRow(page, layer.id, 344), [0], 'hard eraser stays opaque through the selection mask');
    assert.deepEqual(await alphaRow(page, layer.id, 355), [255], 'hard eraser leaves pixels outside selection intact');
    await soft.click();
    await page.reload();
    await tool('eraser').click();
    assert.equal(await soft.getAttribute('aria-checked'), 'true', 'mode survives a reload');
    console.log(`Web eraser: hard AA ${hardRow.join('/')}, soft ${[0, 5, 10, 15, 23].map(i => softRow[i]).join('/')}; low pressure, selection, undo/redo, mode reload, tail hover/cancel and tip restore`);
    await page.close();

    const simulated = await open(true);
    await simulated.locator(`[data-layer-id="${layer.id}"]`).waitFor();
    let simulatedSettings = await preferences(simulated);
    const select = () => simulatedSettings.getByRole('combobox', { name: 'Selected mode' });
    assert.equal(await select().inputValue(), 'auto');
    await select().selectOption('wintab');
    await simulatedSettings.getByText('The WinTab driver (wintab32.dll) was not found.').waitFor();
    assert.equal(await simulatedSettings.locator('[data-tablet-mode]').getAttribute('data-tablet-mode'), 'ink');
    await simulated.reload();
    simulatedSettings = await preferences(simulated);
    assert.equal(await select().inputValue(), 'wintab');
    await select().selectOption('auto');
    const simulatedPreview = simulatedSettings.locator('canvas');
    const touchPen = (generation: number, pointerPressure: number) => simulatedPreview.evaluate((el, { generation, pointerPressure }) => {
      const win = window as any;
      const { left, top } = el.getBoundingClientRect();
      const x = left + 70, y = top + 35;
      win.tabletReport({
        status: 'ready', generation, samples: [{ x, y, time: Date.now(), cursor: 7, pressure: 0.25, contact: true }],
      });
      el.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 17, pointerType: 'pen', clientX: x, clientY: y, pressure: pointerPressure, button: 0, buttons: 1,
      }));
      if (pointerPressure !== 0.5) el.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 17, pointerType: 'pen', clientX: x + 1, clientY: y,
        pressure: pointerPressure, button: -1, buttons: 1,
      }));
    }, { generation, pointerPressure });
    await touchPen(1, 0.75);
    assert.equal(await simulatedSettings.locator('[data-tablet-mode]').getAttribute('data-tablet-mode'), 'ink');
    assert.equal(Number(await simulatedSettings.locator('[data-pressure-raw]').getAttribute('data-pressure-raw')), 0.75);
    await simulatedPreview.dispatchEvent('pointerup', { pointerId: 17, pointerType: 'pen' });
    await touchPen(2, 0.5);
    await simulated.waitForFunction(() => document.querySelector('[data-tablet-mode="wintab"]'));
    assert.equal(Number(await simulatedSettings.locator('[data-pressure-raw]').getAttribute('data-pressure-raw')), 0.25);
    await select().selectOption('ink');
    assert.equal(await simulatedSettings.locator('[data-tablet-mode]').getAttribute('data-tablet-mode'), 'wintab');
    await simulatedSettings.locator('canvas').dispatchEvent('pointerup', { pointerId: 17, pointerType: 'pen' });
    await simulated.waitForFunction(() => document.querySelector('[data-tablet-mode="ink"]'));
    assert.deepEqual(await simulated.evaluate(() => (window as any).configureHistory), [true, false]);
    await select().selectOption('wintab');
    await simulatedSettings.getByRole('button', { name: 'Close', exact: true }).last().click();
    await simulatedSettings.waitFor({ state: 'hidden' });
    await simulated.locator(`[data-layer-id="${layer.id}"]`).click();
    await simulated.locator('.atelier-canvas-viewport').evaluate((element) => {
      const win = window as any;
      const { viewport, app } = win.__debugPixi;
      const rect = app.canvas.getBoundingClientRect();
      const samples = (x: number, y: number, contact = true) => win.tabletReport({
        status: 'ready', generation: 3,
        samples: [{ x, y, time: Date.now(), cursor: 12, pressure: contact ? 0.25 : 0, contact }],
      });
      const send = (type: string, localX: number) => {
        const point = viewport.canvasToScreen(localX, 155);
        const x = rect.left + point.x, y = rect.top + point.y;
        const held = type !== 'pointerup';
        samples(x, y, held);
        element.dispatchEvent(new PointerEvent(type, {
          bubbles: true, pointerId: 21, pointerType: 'pen', clientX: x, clientY: y,
          button: 0, buttons: held ? 1 : 0, pressure: held ? 0.5 : 0,
        }));
      };
      send('pointerdown', 150);
      send('pointermove', 170);
      send('pointermove', 200);
      send('pointerup', 200);
      send('pointerup', 200);
    });
    await simulated.waitForFunction(() => (window as any).__debugPixi?.undo.getUndoCount() === 1);
    assert.equal(await simulated.evaluate(() => (window as any).__debugPixi?.undo.inspect().undo[0]?.opType), 'STROKE');
    await blackStripe(simulated, layer.id);
    await tailEvent(simulated, 'pointerdown', 155, 1, 0, 'wintab');
    await tailEvent(simulated, 'pointermove', 180, 1, -1, 'wintab');
    await tailEvent(simulated, 'pointermove', 350, 0, -1, 'wintab');
    await tailEvent(simulated, 'pointerup', 350, 0, 0);
    await simulated.waitForFunction(() => (window as any).__debugPixi?.undo.getUndoCount() === 2);
    assert.deepEqual(await alphaRow(simulated, layer.id, 165), [0]);
    assert.deepEqual(await alphaRow(simulated, layer.id, 350), [255]);
    simulatedSettings = await preferences(simulated);
    await select().selectOption('ink');
    await simulatedSettings.getByRole('button', { name: 'Close', exact: true }).last().click();
    await simulatedSettings.waitFor({ state: 'hidden' });
    await tailEvent(simulated, 'pointerdown', 240, 1, 0, 'ink');
    await tailEvent(simulated, 'lostpointercapture', 350, 0, -1, 'ink');
    await tailEvent(simulated, 'pointerup', 350, 0, 0);
    await simulated.waitForFunction(() => (window as any).__debugPixi?.undo.getUndoCount() === 3);
    assert.deepEqual(await alphaRow(simulated, layer.id, 240), [0]);
    const readsBeforeInk = await simulated.evaluate(() => (window as any).tabletReads);
    await tailEvent(simulated, 'pointerdown', 240, 1, 0, 'ink', false, 340);
    await tailEvent(simulated, 'pointerup', 240, 0, 0, 'ink', false, 340);
    await simulated.waitForFunction(() => (window as any).__debugPixi?.undo.getUndoCount() === 4);
    assert.ok((await alphaRow(simulated, layer.id, 240, 340))[0] > 250);
    assert.equal(await simulated.evaluate(() => (window as any).tabletReads), readsBeforeInk, 'Windows Ink does not block on a sync driver call');
    await simulated.locator('.atelier-canvas-viewport').evaluate((element) => {
      const { viewport, app } = (window as any).__debugPixi;
      const bounds = app.canvas.getBoundingClientRect();
      const make = (type: string, x: number, pressure: number, buttons: number) => {
        const point = viewport.canvasToScreen(x, 415);
        return new PointerEvent(type, {
          bubbles: true, pointerId: 81, pointerType: 'pen',
          clientX: bounds.left + point.x, clientY: bounds.top + point.y,
          button: type === 'pointermove' ? -1 : 0, buttons, pressure,
        });
      };
      element.dispatchEvent(make('pointerdown', 80, 0.8, 1));
      const move = make('pointermove', 250, 0.8, 1);
      Object.defineProperty(move, 'getCoalescedEvents', {
        value: () => [make('pointermove', 130, 0, 0), make('pointermove', 165, 0, 1)],
      });
      element.dispatchEvent(move);
      element.dispatchEvent(make('pointerup', 250, 0, 0));
    });
    await simulated.waitForFunction(() => (window as any).__debugPixi?.undo.getUndoCount() === 5);
    assert.ok((await alphaRow(simulated, layer.id, 200, 415))[0] > 150, 'an isolated zero sample does not lose the rest of the stroke');
    await simulated.locator('.atelier-canvas-viewport').evaluate((element) => {
      const { viewport, app } = (window as any).__debugPixi;
      const bounds = app.canvas.getBoundingClientRect();
      const base = performance.now();
      const send = (type: string, x: number, time: number) => {
        const p = viewport.canvasToScreen(x, 470);
        const event = new PointerEvent(type, {
          bubbles: true, pointerId: 91, pointerType: 'pen', clientX: bounds.left + p.x, clientY: bounds.top + p.y,
          button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, pressure: 0.8,
        });
        Object.defineProperty(event, 'timeStamp', { value: base + time });
        element.dispatchEvent(event);
      };
      send('pointerdown', 75, 0);
      send('pointermove', 345, 90);
      send('pointerup', 345, 95);
    });
    await simulated.waitForFunction(() => (window as any).__debugPixi?.undo.getUndoCount() === 6);
    assert.ok((await alphaRow(simulated, layer.id, 75, 470))[0] > 0);
    assert.ok((await alphaRow(simulated, layer.id, 345, 470))[0] > 0);
    assert.deepEqual(await alphaRow(simulated, layer.id, 210, 470), [0], 'missing positions must not create a straight connector');
    console.log('Pressure labels and limits, continuous preview, and live stroke through zero-pressure/invalid coalesced samples passed');
    simulatedSettings = await preferences(simulated);
    await select().selectOption('wintab');
    const latePreview = simulatedSettings.locator('canvas');
    await latePreview.evaluate((el) => {
      const w = window as any;
      const { left, top } = el.getBoundingClientRect();
      const x = left + 45, y = top + 35;
      w.tabletReport({ generation: 8, status: 'ready', samples: [] });
      el.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 41, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: 1, pressure: 0.5,
      }));
      w.tabletReport({ generation: 8, status: 'ready',
        samples: [{ x: x + 3, y, time: Date.now(), cursor: 8, pressure: 0.7, contact: true }] });
    });
    assert.equal(await simulatedSettings.locator('[data-tablet-mode]').getAttribute('data-tablet-mode'), 'wintab');
    await simulated.waitForFunction(() => Number(document.querySelector('[data-pressure-raw]')?.getAttribute('data-pressure-raw')) === 0.7);
    assert.ok(Math.abs(Number(await simulatedSettings.locator('[data-pressure-raw]').getAttribute('data-pressure-raw')) - 0.7) < 0.01);
    await latePreview.dispatchEvent('pointerup', { pointerId: 41, pointerType: 'mouse' });
    const curveRecovered = await latePreview.evaluate(async (el: HTMLCanvasElement) => {
      const report = (window as any).tabletReport;
      const ctx = el.getContext('2d')!;
      const rect = el.getBoundingClientRect();
      const base = performance.now();
      const positions = [
        { x: 50, y: 116, elapsed: 0 },
        { x: 78, y: 87, elapsed: 8 },
        { x: 103, y: 69, elapsed: 16 },
        { x: 133, y: 87, elapsed: 24 },
        { x: 165, y: 116, elapsed: 32 },
      ].map(p => ({ ...p, clientX: rect.left + p.x * rect.width / el.width, clientY: rect.top + p.y * rect.height / el.height }));
      const before = ctx.getImageData(103, 69, 1, 1).data;
      const straightBefore = ctx.getImageData(103, 116, 1, 1).data;
      const packet = (p: typeof positions[number]) => ({ x: p.clientX, y: p.clientY,
        time: performance.timeOrigin + base, cursor: 12, contact: true, pressure: 0.8 });
      const send = (type: string, p: typeof positions[number]) => {
        const event = new PointerEvent(type, {
          bubbles: true, pointerId: 66, pointerType: 'mouse', clientX: p.clientX, clientY: p.clientY,
          buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0, pressure: 0.5,
        });
        Object.defineProperty(event, 'timeStamp', { value: base + p.elapsed });
        el.dispatchEvent(event);
      };
      report({ generation: 9, status: 'ready', samples: [packet(positions[0])] });
      send('pointerdown', positions[0]);
      send('pointerup', positions[4]);
      el.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 66, pointerType: 'mouse' }));
      report({ generation: 9, status: 'ready', samples: [
        ...positions.slice(1).map(packet),
        { ...packet(positions[4]), contact: false, pressure: 0 },
      ] });
      await new Promise(requestAnimationFrame);
      return ctx.getImageData(103, 69, 1, 1).data.some((v, i) => v !== before[i]) &&
        ctx.getImageData(103, 116, 1, 1).data.every((v, i) => v === straightBefore[i]);
    });
    assert.ok(curveRecovered, 'WinTab preview follows the bend even when native motion arrives after pointerup and lost capture');
    console.log('WinTab preview preserved the curve and late native lift without drawing a chord');
    await select().selectOption('ink');
    await simulatedSettings.getByRole('button', { name: 'Close', exact: true }).last().click();
    await simulatedSettings.waitFor({ state: 'hidden' });
    const gapPixel = await alphaRow(simulated, layer.id, 224, 382);
    assert.deepEqual(gapPixel, [0], 'native gap case starts on a transparent pixel');
    await simulated.locator('.atelier-canvas-viewport').evaluate(async (element) => {
      const win = window as any;
      const { viewport, app } = win.__debugPixi;
      const bounds = app.canvas.getBoundingClientRect();
      const base = performance.now();
      const packet = (x: number, y: number, pressure: number, offset: number, contact = true) => {
        const p = viewport.canvasToScreen(x, y);
        return { x: bounds.left + p.x, y: bounds.top + p.y, cursor: 71, time: performance.timeOrigin + base + offset,
          pressure, contact };
      };
      const report = (generation: number, inkSamples: ReturnType<typeof packet>[] = []) =>
        win.tabletReport({ generation, status: 'disabled', samples: [], inkSamples });
      const pointer = (type: string, p: ReturnType<typeof packet>, pointerId = 92) => {
        const event = new PointerEvent(type, {
          bubbles: true, pointerId, pointerType: 'pen', clientX: p.x, clientY: p.y,
          button: 0, buttons: type === 'pointerdown' ? 1 : 0, pressure: type === 'pointerdown' ? 0.5 : 0,
        });
        Object.defineProperty(event, 'timeStamp', { value: p.time - performance.timeOrigin });
        element.dispatchEvent(event);
      };
      report(10);
      const start = packet(90, 384, 0.85, 0);
      pointer('pointerdown', start);
      report(10, [start, packet(130, 370, 0.82, 2)]);
      // No DOM movement. The next accepted packet follows a known loss at the
      // same timestamp, then the driver restarts before the animation frame.
      report(10, [{ ...packet(270, 388, 0.72, 2), gapBefore: true }, packet(295, 388, 0.65, 4)]);
      report(11);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      pointer('pointerup', packet(330, 388, 0, 8, false));
      pointer('pointerup', packet(330, 388, 0, 8, false));

      const next = packet(356, 390, 0.75, 10);
      pointer('pointerdown', next, 93);
      pointer('pointerup', packet(398, 390, 0, 15, false), 93);
      // Terminal IPC can arrive after DOM pointerup.
      report(11, [next, packet(390, 390, 0.72, 13), packet(398, 390, 0, 15, false)]);
    });
    await simulated.waitForFunction(() => (window as any).__debugPixi?.undo.getUndoCount() === 8);
    assert.ok((await alphaRow(simulated, layer.id, 130, 370))[0] > 0, 'native Ink paints without DOM movement');
    assert.deepEqual(await alphaRow(simulated, layer.id, 224, 382), gapPixel, 'reported loss breaks the line at equal timestamps');
    assert.ok((await alphaRow(simulated, layer.id, 290, 388))[0] > 0, 'generation reset retains buffered contact');
    assert.ok((await alphaRow(simulated, layer.id, 386, 390))[0] > 0, 'late native lift finishes the second stroke');
    console.log('Ink batches started without DOM moves, preserved both sides of loss and committed once on reset and late lift');
    const history = await simulated.evaluate(() => {
      const undo = (window as any).__debugPixi.undo;
      undo.clear();
      for (let i = 0; i < 35; i++) {
        undo.push({ opId: String(i), userId: 'artist-a', layerId: 'layer',
          opType: 'STROKE', beforeTiles: [], afterTiles: [], timestamp: i });
      }
      return {
        count: undo.getUndoCount(),
        otherArtistCanUndo: Boolean(undo.undo('artist-b')),
        guestCanUndo: Boolean(undo.undo('guest')),
      };
    });
    assert.deepEqual(history, { count: 30, otherArtistCanUndo: false, guestCanUndo: false });
    console.log('Online canvas retained 30 out of 35 steps; other artist and guest cannot undo them');
    console.log('Delayed WinTab packet started without a DOM move; Windows Ink history drew without sync driver reads');
    console.log('Simulated Windows tablet packets: WinTab TPS_INVERT and Windows Ink eraser route primary-button events to the eraser; hover lift/lost capture commit once; flipped tip paints');
    console.log('Simulated Windows renderer: auto selects Ink or WinTab according to the pressure source, missing driver falls back, preference reloads, manual change waits for lift, WinTab packets plus pointer events commit one stroke');
  } finally {
    await browser.close();
    await app.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

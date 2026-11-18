import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { chromium } from 'playwright-core';

const injected = process.argv.includes('--inject');
const base = injected ? 'http://localhost:3100' : process.argv[2] || 'http://127.0.0.1:3100';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let app: FastifyInstance | undefined;

async function post(path: string, body: unknown, token?: string) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  if (app) {
    const response = await app.inject({ method: 'POST', url: '/api' + path, headers, payload: JSON.stringify(body) });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  }
  const response = await fetch(base + '/api' + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
}

async function main() {
  if (injected) {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'lumina-undo-'));
    const { buildApp } = await import('../src/app');
    app = await buildApp();
  }
  const account = await post('/auth/register', { username: 'undo_' + Date.now(), password: 'test-password' });
  const { canvas } = await post('/canvases', { title: 'Sparse undo test', width: 4096, height: 4096 }, account.token);
  const { layer } = await post(`/canvases/${canvas.id}/layers`, { name: 'Undo test', aclMode: 'shared_all' }, account.token);
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
    await page.addInitScript({ content: 'window.__name = (f) => f;' });
    if (app) {
      await page.route(base + '/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const response = await app!.inject({
          url: url.pathname + url.search, method: request.method() as InjectOptions['method'],
          headers: request.headers(), payload: request.postDataBuffer() ?? undefined,
        });
        const headers = Object.fromEntries(Object.entries(response.headers)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
      });
    }
    await page.addInitScript(({ token, canvasId }) => {
      localStorage.setItem('atelier_token', token);
      localStorage.setItem('atelier_gateway_resolved', 'true');
      localStorage.setItem('atelier_active_canvas_id', canvasId);
      localStorage.setItem('atelier_brush_tools', JSON.stringify({
        brush: { size: 235, hardness: 0.12, flow: 0.55, stabilizerLevel: 0, spacing: 0.12, tiltSize: 1 },
      }));
    }, { token: account.token, canvasId: canvas.id });
    await page.goto(base);
    await page.locator(`[data-layer-id="${layer.id}"]`).click({ timeout: 30000 });
    await page.waitForFunction(() => Boolean((window as any).__debugPixi?.undo));

    const snapshot = await page.evaluate(async (id: string) => {
      const lm = (window as any).__debugPixi.layerManager;
      const coords = Array.from({ length: 40 }, (_, i) => ({ col: i % 8, row: Math.floor(i / 8) }));
      const pixel = (value: number) => new Uint8Array([value, 0, 0, 255]);
      for (const { col, row } of coords) lm.writeRegion(id, col * 256, row * 256, 1, 1, pixel(37));
      lm.syncPingPong(id);
      const read = lm.readTilesAsync(id, coords, 'before');
      await Promise.resolve(); // the first WebGL2 wave is now submitted
      lm.writeRegion(id, 7 * 256, 4 * 256, 1, 1, pixel(173));
      const values = await read;
      const oldValue = values.at(-1).data[0];
      lm.revertToPingPong(id);
      lm.writeRegion(id, 0, 0, 2048, 1280, null);
      lm.syncPingPong(id);
      return oldValue;
    }, layer.id);
    assert.equal(snapshot, 37, 'queued before read must retain the old pixel of a live atlas slot');
    console.log('40-tile queued before snapshot retained the original pixel');

    await page.evaluate((layerId: string) => {
      const w = window as any;
      const d = w.__debugPixi;
      const el = document.querySelector('.atelier-canvas-viewport')!;
      const applyTiles = d.layerManager.applyTiles.bind(d.layerManager);
      w.undoWrites = 0;
      d.layerManager.applyTiles = (id: string, ...args: unknown[]) => {
        applyTiles(id, ...args);
        if (id === layerId) w.undoWrites++;
      };
      w.undoTest = {
        draw(index: number, phase: 'all' | 'start' | 'finish' = 'all') {
          const box = d.app.canvas.getBoundingClientRect();
          const fire = (type: string, i: number) => {
            const p = d.viewport.canvasToScreen(246 + i * 113, 246 + i * 113 + index * 36);
            el.dispatchEvent(new PointerEvent(type, {
              bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 1,
              clientX: box.left + p.x, clientY: box.top + p.y, isPrimary: true,
              button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
              pressure: type === 'pointerup' ? 0 : 0.8, tiltX: 70,
            }));
          };
          if (phase !== 'finish') {
            fire('pointerdown', 0);
            for (let i = 1; i <= 30; i++) fire('pointermove', i);
          }
          if (phase !== 'start') fire('pointerup', 30);
        },
        async snapshot() {
          const coords = d.layerManager.occupiedTiles(layerId) ?? [];
          const tiles = await d.layerManager.readTilesAsync(layerId, coords);
          return new Map<string, Uint8Array>(tiles.map((tile: { col: number; row: number; data: Uint8Array }) => [`${tile.col},${tile.row}`, tile.data]));
        },
        async compare(expected: Map<string, Uint8Array>) {
          const actual: Map<string, Uint8Array> = await this.snapshot();
          return [...new Set([...actual.keys(), ...expected.keys()])].filter((key) => {
            const got = actual.get(key);
            const want = expected.get(key);
            return got ? got.some((byte, i) => byte !== (want?.[i] ?? 0)) : want?.some(Boolean);
          });
        },
      };
      d.viewport.centerInView(d.app.screen.width, d.app.screen.height);
    }, layer.id);

    const undo = async (remaining: number) => {
      const before = await page.evaluate(() => (window as any).undoWrites);
      await page.keyboard.press('Control+z');
      await page.waitForFunction(({ count, writes }) => {
        const w = window as any;
        return w.__debugPixi.undo.getUndoCount() === count && w.undoWrites > writes;
      }, { count: remaining, writes: before });
    };
    for (const zoomed of [false, true]) {
      await page.evaluate((zoom: boolean) => {
        const w = window as any;
        const d = w.__debugPixi;
        if (zoom) d.viewport.setZoom(d.viewport.getState().zoom * 1.8);
        w.undoExpected = [];
        for (let i = 0; i < 3; i++) {
          // Capture the real baseline of this stroke while it is still pending on the GPU,
          // then feed the next stroke with no input delay.
          w.undoExpected.push(w.undoTest.snapshot());
          w.undoTest.draw(i);
        }
      }, zoomed);
      await page.waitForFunction(() => (window as any).__debugPixi.undo.getUndoCount() === 3);
      assert.ok(await page.evaluate((id) => (window as any).__debugPixi.undo.peekLatestForLayer(id).afterTiles.length > 30, layer.id), 'stroke must cover over 30 tiles');
      if (zoomed) {
        await page.evaluate(async () => {
          const w = window as any;
          await Promise.all(w.undoExpected);
          // Trigger the ordinary eviction path with a small fixture; its production GPU budget is much larger.
          w.__debugPixi.layerManager.evictOffscreenGpuTiles(8);
        });
        await page.waitForFunction((id) => (window as any).__debugPixi.layerManager.getLayerItem(id).coldTiles.size > 0, layer.id);
      }
      for (let i = 2; i >= 0; i--) {
        await undo(i);
        const mismatches = await page.evaluate(async (j) => (window as any).undoTest.compare(await (window as any).undoExpected[j]), i);
        assert.deepEqual(mismatches, [], `RGBA tile mismatch after undo ${i}, zoomed=${zoomed}`);
      }
      console.log(`Three consecutive 4K strokes and Ctrl+Z matched byte-for-byte (zoomed=${zoomed})`);
    }

    await page.evaluate(async () => {
      const w = window as any;
      w.beforeUndoRace = await w.undoTest.snapshot();
      w.undoTest.draw(0);
    });
    await page.waitForFunction(() => (window as any).__debugPixi.undo.getUndoCount() === 1);
    const priorWrites = await page.evaluate(() => {
      const w = window as any;
      const lm = w.__debugPixi.layerManager;
      const readTiles = lm.readTilesAsync.bind(lm);
      lm.readTilesAsync = async (...args: unknown[]) => {
        if (args[2] === undefined && !w.releaseUndoRead) {
          await new Promise<void>(resolve => { w.releaseUndoRead = resolve; });
        }
        return readTiles(...args);
      };
      return w.undoWrites as number;
    });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => Boolean((window as any).releaseUndoRead));
    await page.evaluate(() => {
      const w = window as any;
      w.undoTest.draw(1, 'start');
      w.releaseUndoRead();
    });
    await page.waitForFunction((writes) => (window as any).undoWrites > writes, priorWrites);
    await page.evaluate(() => (window as any).undoTest.draw(1, 'finish'));
    await page.waitForFunction(() => (window as any).__debugPixi.undo.getUndoCount() === 1);
    await undo(0);
    const raceMismatches = await page.evaluate(async () => {
      const w = window as any;
      return w.undoTest.compare(w.beforeUndoRace);
    });
    assert.deepEqual(raceMismatches, [], 'undo while the next stroke starts must not destroy its before-state');
    console.log('Stroke started during Ctrl+Z retained its separate before-state');
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => app?.close());

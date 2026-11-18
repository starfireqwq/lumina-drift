/**
 * Big-canvas test in a real (headless) Chrome: a 10000×8000 canvas with 10 visible layers that
 * have content, one painter drawing long strokes across it.
 *
 *   PORT=3100 DATA_DIR=<throwaway> node dist/server.js        (after pnpm -r build)
 *   npx tsx tests/bigcanvas-browser.ts http://127.0.0.1:3100 [width] [height] [layers] [tilesPerLayer] [seconds]
 *   CPU_THROTTLE=4 …   phone-class CPU        FILL=1 …   the first layer is filled edge to edge
 *
 * Reports what the item list asks for: GPU memory for layer textures while drawing
 * (LayerManager.getTextureStats, peak), WebGL draw calls per frame, frame times while drawing, and
 * the longest frame in the second after each pen-up (the commit must not stall the page).
 * Creates its own account and canvas: point it at a throwaway server only.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { compressTileBuffer } from '@atelier/shared';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const WIDTH = Number(process.argv[3] || 10000);
const HEIGHT = Number(process.argv[4] || 8000);
const LAYERS = Number(process.argv[5] || 10);
const TILES = Number(process.argv[6] || 40);
const SECONDS = Number(process.argv[7] || 12);
const SHARED = process.argv.includes('--shared');
const THROTTLE = Number(process.env.CPU_THROTTLE || 1);
const FILL = process.env.FILL === '1';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));

async function api(token: string | null, method: string, url: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data as any;
}

/** Line-art-like tile (sparse strokes), different per seed */
function tile(col: number, row: number, seed: number, solid = false) {
  const w = Math.min(256, WIDTH - col * 256);
  const h = Math.min(256, HEIGHT - row * 256);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = solid || (x + y * 3 + seed) % 23 === 0 || (x * 2 + seed) % 61 === 0;
      if (!on) continue;
      const i = (y * w + x) * 4;
      px[i] = 40 + (seed * 37) % 180; px[i + 1] = 60; px[i + 2] = 120; px[i + 3] = 255;
    }
  }
  const { data } = compressTileBuffer(px, 'lz4');
  return { col, row, width: w, height: h, compression: 'lz4', data: Buffer.from(data).toString('base64') };
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

async function main() {
  if (!CHROME) throw new Error('Chrome not found');
  const run = Date.now().toString(36).slice(-5);
  console.log(`🚀 ${WIDTH}×${HEIGHT}, ${LAYERS} layers × ${TILES} tiles${FILL ? ' (first layer filled)' : ''}, ${SECONDS}s of strokes${THROTTLE > 1 ? `, CPU ×${THROTTLE} slower` : ''} on ${BASE}`);
  const { token } = await api(null, 'POST', '/api/auth/register', { username: `big_${run}`, password: 'password123', displayName: 'big' });
  const { canvas } = await api(token, 'POST', '/api/canvases', { title: `big ${run}`, width: WIDTH, height: HEIGHT });
  const cols = Math.ceil(WIDTH / 256);
  const rows = Math.ceil(HEIGHT / 256);
  const ids: string[] = [];
  for (let l = 0; l < LAYERS; l++) {
    const id = (await api(token, 'POST', `/api/canvases/${canvas.id}/layers`, {
      name: `層 ${l + 1}`, aclMode: SHARED ? 'shared_all' : 'owner_only',
    })).layer.id as string;
    ids.push(id);
    const tiles = FILL && l === 0
      ? Array.from({ length: cols * rows }, (_, k) => tile(k % cols, Math.floor(k / cols), l, true))
      : Array.from({ length: TILES }, (_, k) => tile((l * 7 + k * 5) % cols, (l * 3 + k * 2) % rows, l * 100 + k));
    for (let i = 0; i < tiles.length; i += 200) await api(token, 'POST', `/api/canvases/${canvas.id}/layers/${id}/tiles`, { tiles: tiles.slice(i, i + 200) });
  }
  console.log(`… seeded ${LAYERS} layers`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
    await ctx.addInitScript(([t, c]) => {
      localStorage.setItem('atelier_token', t);
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_active_canvas_id', c);
    }, [token, canvas.id]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('pageerror:', e.message));
    if (THROTTLE > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.goto(BASE);
    await page.waitForFunction((n) => (window as any).__debugPixi?.layerManager?.getLayers().length >= n, LAYERS, { timeout: 60000 });
    const r = await page.evaluate(async ({ w, h, seconds, lastLayer }) => {
      const win = window as any;
      const d = win.__debugPixi;
      const lm = d.layerManager;
      const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
      await wait(6000); // replay lands, idle layers settle
      // The top layer is the one drawn on
      const row = [...document.querySelectorAll('[data-layer-id]')].find((el) => el.textContent?.includes(lastLayer));
      (row as HTMLElement | undefined)?.click();
      await wait(800);
      const gl = d.app.renderer.gl as WebGL2RenderingContext;
      let draws = 0;
      const orig = gl.drawElements.bind(gl);
      (gl as any).drawElements = (...a: Parameters<typeof gl.drawElements>) => { draws++; return orig(...a); };
      const origArrays = gl.drawArrays.bind(gl);
      (gl as any).drawArrays = (...a: Parameters<typeof gl.drawArrays>) => { draws++; return origArrays(...a); };
      // Draw calls for one frame of the idle scene (layers only: what each frame costs to show)
      draws = 0;
      d.app.renderer.render(d.app.stage);
      const drawsPerFrameIdle = draws;
      const atLoad = lm.getTextureStats();

      const el = document.querySelector('.atelier-canvas-viewport') as HTMLElement;
      const toClient = (x: number, y: number) => {
        const p = d.viewport.canvasToScreen(x, y);
        const rc = d.app.canvas.getBoundingClientRect();
        return { x: rc.left + p.x, y: rc.top + p.y };
      };
      const ev = (type: string, x: number, y: number, buttons: number) => {
        const c = toClient(x, y);
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, clientX: c.x, clientY: c.y, buttons, button: 0, pressure: 0.7 }));
      };
      const frames: number[] = [];
      const afterUp: number[] = [];
      let upAt = -1e9;
      let last = performance.now();
      let running = true;
      let peakMB = 0;
      let peak: any = atLoad;
      const loop = (t: number) => {
        const dt = t - last;
        frames.push(dt);
        if (t - upAt < 1000) afterUp.push(dt);
        last = t;
        if (running) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      const end = performance.now() + seconds * 1000;
      let strokes = 0;
      while (performance.now() < end) {
        // Long diagonal strokes over the whole canvas: many tiles each
        const y0 = h * (0.1 + Math.random() * 0.8);
        ev('pointerdown', w * 0.05, y0, 1);
        for (let i = 1; i <= 40; i++) {
          ev('pointermove', w * 0.05 + i * w * 0.022, y0 + Math.sin(i / 4) * h * 0.15, 1);
          await new Promise((res) => requestAnimationFrame(res));
        }
        const s = lm.getTextureStats();
        if (s.megabytes > peakMB) { peakMB = s.megabytes; peak = s; }
        ev('pointerup', w * 0.93, y0, 0);
        upAt = performance.now();
        strokes++;
        await wait(1100);
      }
      running = false;
      await wait(300);
      return {
        strokes,
        drawsPerFrameIdle,
        atLoad,
        peak,
        end: lm.getTextureStats(),
        heapMB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576),
        frames: frames.slice(3),
        afterUp,
      };
    }, { w: WIDTH, h: HEIGHT, seconds: SECONDS, lastLayer: `層 ${LAYERS}` });

    const fmt = (s: any) => `${s.megabytes} MB GPU (canvas-sized textures ${s.textures}: resident ${s.resident}, ping-pong ${s.pingPong}; warm ${s.warm} with ${s.tiles} tiles${s.atlasPages !== undefined ? ` in ${s.atlasPages} atlas pages, backups ${s.backups}` : ''}; cold ${s.cold})`;
    console.log(`Layer memory after load:     ${fmt(r.atLoad)}`);
    console.log(`Layer memory peak, drawing:  ${fmt(r.peak)}`);
    console.log(`Layer memory at the end:     ${fmt(r.end)}  JS heap ${r.heapMB} MB`);
    console.log(`WebGL draw calls per frame (idle scene): ${r.drawsPerFrameIdle}`);
    console.log(`Drawing: ${r.strokes} strokes, ${(r.frames.length / SECONDS).toFixed(0)} fps, frame p50 ${q(r.frames, 0.5).toFixed(1)}ms p95 ${q(r.frames, 0.95).toFixed(1)}ms max ${Math.max(...r.frames).toFixed(0)}ms`);
    console.log(`In the 1 s after each pen-up: frame p95 ${q(r.afterUp, 0.95).toFixed(1)}ms, max ${Math.max(...r.afterUp).toFixed(0)}ms, frames over 16.7ms ${r.afterUp.filter((f) => f > 16.7).length}/${r.afterUp.length}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('❌ big canvas test failed:', err);
  process.exit(1);
});

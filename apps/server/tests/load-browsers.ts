/**
 * Browser load test: N real (headless Chrome) painters in one room, drawing at once, while some
 * of them play a shared animation. Measures what a painter actually sees: frame rate / frame time
 * of their own page and how late the others' live strokes arrive (window.__atelierLatency).
 *
 *   PORT=3103 DATA_DIR=<throwaway> node dist/server.js           (in another terminal)
 *   npx tsx tests/load-browsers.ts http://127.0.0.1:3103 12 20 [width] [height] [cels] [bots]
 *
 * bots: extra painters as plain sockets (live previews ~40/s, a 2-tile stroke every 1.2 s). Many
 * real browsers on one PC mostly measure that PC; a few browsers plus bots measure what one
 * painter's screen does while 15 people draw.
 *
 * Uses the installed Chrome (playwright-core: no browser download). Never point it at the real
 * server: it creates accounts, layers and a canvas.
 */
import { chromium, type Page } from 'playwright-core';
import fs from 'node:fs';
import { io as ClientSocket, type Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import { compressTileBuffer, tileSocketParser, type TileData } from '@atelier/shared';

const BASE = process.argv[2] || 'http://127.0.0.1:3103';
const PAINTERS = Number(process.argv[3] || 12);
const SECONDS = Number(process.argv[4] || 20);
const WIDTH = Number(process.argv[5] || 2048);
const HEIGHT = Number(process.argv[6] || 2048);
const CELS = Number(process.argv[7] || 24);
const BOTS = Number(process.argv[8] || 0);
/** Tiles of line-art-like content put into every cel and painter layer before the pages open (sparse layers are cheap only if they are sparse) */
const SEED = Number(process.argv[9] ?? 6);

function tile(col: number, row: number, seed: number): TileData {
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < px.length; i += 4) {
    const on = ((i / 4) % 256) % 17 === seed % 17;
    px[i] = 200; px[i + 1] = 40; px[i + 2] = 40; px[i + 3] = on ? 255 : 0;
  }
  const { compression, data } = compressTileBuffer(px, 'lz4');
  return { col, row, width: 256, height: 256, compression, data };
}
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));

async function api(token: string | null, method: string, url: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
  return data as any;
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

/** Runs inside each page: draws zigzag strokes in its own band and records every frame's duration */
const painterScript = async ({ index, seconds, width, height, play, cels }: { index: number; seconds: number; width: number; height: number; play: boolean; cels: number }) => {
  const w = window as any;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 200 && !w.__debugPixi?.layerManager?.getLayers().length; i++) await wait(100);
  const d = w.__debugPixi;
  // Settle: the replay lands, idle layers park
  await wait(5000);
  const heap = () => Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576);
  const atLoad = { ...d.layerManager.getTextureStats(), heap: heap() };
  const el = document.querySelector('.atelier-canvas-viewport') as HTMLElement;
  const toClient = (x: number, y: number) => {
    const p = d.viewport.canvasToScreen(x, y);
    const r = d.app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  };
  const ev = (type: string, x: number, y: number, buttons: number) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, buttons, button: 0, pressure: 0.6 }));
  let animationFrames = 0;
  let stopFrameCount: (() => void) | undefined;
  let synchronousThaws = 0;
  let restoreSyncLayers: (() => void) | undefined;
  if (play) {
    const timeline = d.animationEngine;
    if (!timeline || timeline.getLength() !== cels) throw new Error(`Expected timeline with ${cels} cels`);
    const lm = d.layerManager;
    const syncLayers = lm.syncLayers;
    const thaw = lm.thaw;
    if (typeof thaw === 'function') {
      lm.syncLayers = function (...args: unknown[]) {
        const previousThaw = this.thaw;
        this.thaw = function (item: { cpu?: Map<unknown, unknown> }) {
          if (item.cpu?.size) synchronousThaws++;
          return thaw.call(this, item);
        };
        try {
          return syncLayers.apply(this, args);
        } finally {
          this.thaw = previousThaw;
        }
      };
      restoreSyncLayers = () => { lm.syncLayers = syncLayers; };
    }
    stopFrameCount = timeline.onFrameChange(() => { animationFrames++; });
    timeline.play();
    if (!timeline.getIsPlaying()) throw new Error('Timeline playback did not start');
  }
  type LongFrame = PerformanceEntry & { blockingDuration: number; scripts: Array<PerformanceEntry & { sourceURL: string; sourceFunctionName: string }> };
  const longFrames: Array<{ duration: number; blocking: number; source: string }> = [];
  const observer = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
    ? new PerformanceObserver((entries) => collectLongFrames(entries.getEntries()))
    : null;
  function collectLongFrames(entries: PerformanceEntry[]) {
    for (const frame of entries as LongFrame[]) {
      const script = frame.scripts.reduce<LongFrame['scripts'][number] | undefined>(
        (longest, next) => !longest || next.duration > longest.duration ? next : longest, undefined,
      );
      longFrames.push({
        duration: Math.round(frame.duration),
        blocking: Math.round(frame.blockingDuration),
        source: script ? [script.sourceURL, script.sourceFunctionName].filter(Boolean).join(' ') : '',
      });
    }
  }
  observer?.observe({ type: 'long-animation-frame' });
  const frames: number[] = [];
  let last = performance.now();
  let running = true;
  const loop = (t: number) => {
    frames.push(t - last);
    last = t;
    if (running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const band = (height / 16) * (1 + (index % 14));
  const end = performance.now() + seconds * 1000;
  let strokes = 0;
  while (performance.now() < end) {
    const x0 = width * 0.1 + Math.random() * width * 0.2;
    const start = toClient(x0, band);
    ev('pointerdown', start.x, start.y, 1);
    for (let i = 1; i <= 40; i++) {
      const p = toClient(x0 + i * (width * 0.012), band + Math.sin(i / 3) * height * 0.02);
      ev('pointermove', p.x, p.y, 1);
      await wait(16);
    }
    const p = toClient(x0 + 40 * width * 0.012, band);
    ev('pointerup', p.x, p.y, 0);
    strokes++;
    await wait(300);
  }
  running = false;
  const elapsed = seconds * 1000 + (performance.now() - end);
  if (observer) {
    collectLongFrames(observer.takeRecords());
    observer.disconnect();
  }
  stopFrameCount?.();
  restoreSyncLayers?.();
  if (play) d.animationEngine.pause();
  await wait(500);
  const lat = (w.__atelierLatency?.() ?? []) as Array<{ p50: number; p95: number; count: number }>;
  const gl = d.app.renderer.gl;
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    strokes,
    elapsed,
    animationFrames,
    synchronousThaws,
    longFrameCount: observer ? longFrames.length : null,
    slowestLongFrames: longFrames.sort((a, b) => b.duration - a.duration).slice(0, 3),
    frames: frames.slice(5),
    latencyP50: lat.map((l) => l.p50),
    latencyP95: lat.map((l) => l.p95),
    senders: lat.length,
    gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown',
    atLoad,
    textures: { ...d.layerManager.getTextureStats(), heap: heap() },
  };
};

async function main() {
  if (!CHROME) throw new Error('Chrome not found');
  const run = Date.now().toString(36).slice(-5);
  console.log(`🚀 ${PAINTERS} browsers + ${BOTS} socket painters × ${SECONDS}s on ${BASE} — canvas ${WIDTH}×${HEIGHT}, animation of ${CELS} cels${Number(process.env.CPU_THROTTLE) > 1 ? `, CPU ×${process.env.CPU_THROTTLE} slower` : ''}`);
  const painters: Array<{ token: string; userId: string }> = [];
  for (let i = 0; i < PAINTERS; i++) {
    const r = await api(null, 'POST', '/api/auth/register', { username: `pw_${run}_${i}`, password: 'password123', displayName: `瀏覽器${i + 1}` });
    painters.push({ token: r.token, userId: r.user.id });
  }
  const { canvas } = await api(painters[0].token, 'POST', '/api/canvases', { title: `PW ${run}`, width: WIDTH, height: HEIGHT });
  const layersUrl = `/api/canvases/${canvas.id}/layers`;
  // An animation folder of CELS cels (painter 0), and one own layer per painter to draw on
  const folder = (await api(painters[0].token, 'POST', layersUrl, { name: '動畫', layerType: 'group', meta: { animation: { fps: 12, shared: true } } })).layer;
  const seeded: string[] = [];
  for (let c = 0; c < CELS; c++) seeded.push((await api(painters[0].token, 'POST', layersUrl, { name: String(c + 1), parentId: folder.id })).layer.id);
  for (let i = 0; i < PAINTERS; i++) {
    if (i > 0) await api(painters[i].token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
    const own = (await api(painters[i].token, 'POST', layersUrl, { name: `瀏覽器${i + 1} 的圖層` })).layer.id;
    if (i === 0) seeded.push(own);
  }
  if (SEED > 0) {
    // SEED tiles per layer along a diagonal, different per layer (cels differ frame to frame)
    const cols = Math.ceil(WIDTH / 256);
    const rows = Math.ceil(HEIGHT / 256);
    const s = ClientSocket(BASE, { auth: { token: painters[0].token, canvasId: canvas.id }, transports: ['websocket'], parser: tileSocketParser(socketParser) });
    await new Promise<void>((resolve) => s.on('connect', () => { s.emit('join_canvas', { canvasId: canvas.id }); resolve(); }));
    await new Promise((r) => setTimeout(r, 300));
    for (const [n, layerId] of seeded.entries()) {
      const tiles = Array.from({ length: SEED }, (_, k) => tile((n + k * 3) % cols, Math.floor(((k + 0.5) * rows) / SEED) % rows, n + k));
      s.emit('tile_patch', { type: 'TILE_PATCH', canvasId: canvas.id, layerId, tiles, clientSeq: n + 1 });
      if (n % 20 === 19) await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1500));
    s.close();
    console.log(`… seeded ${SEED} tiles into each of ${seeded.length} layers`);
  }

  // Socket painters (bots): their own layers, drawing during the measurement
  const bots: Array<{ token: string; layerId: string; socket?: Socket }> = [];
  for (let i = 0; i < BOTS; i++) {
    const r = await api(null, 'POST', '/api/auth/register', { username: `pwb_${run}_${i}`, password: 'password123', displayName: `機器人${i + 1}` });
    await api(r.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
    bots.push({ token: r.token, layerId: (await api(r.token, 'POST', layersUrl, { name: `機器人${i + 1}` })).layer.id });
  }
  await Promise.all(bots.map((b) => new Promise<void>((resolve) => {
    b.socket = ClientSocket(BASE, { auth: { token: b.token, canvasId: canvas.id }, transports: ['websocket'], parser: tileSocketParser(socketParser) });
    b.socket.on('connect', () => { b.socket!.emit('join_canvas', { canvasId: canvas.id }); resolve(); });
  })));
  const startBots = () => {
    const timers: NodeJS.Timeout[] = [];
    bots.forEach((b, i) => {
      let t = 0;
      let seq = 0;
      timers.push(setInterval(() => {
        t += 1;
        const dabs = Array.from({ length: 6 }, (_, k) => ({ x: 100 + ((t * 6 + k) % 800), y: (HEIGHT / (BOTS + 2)) * (i + 1) + Math.sin((t * 6 + k) / 20) * 40, pressure: 0.6 }));
        b.socket!.emit('preview_dab', { canvasId: canvas.id, layerId: b.layerId, color: '#2255cc', brushSize: 12, opacity: 1, isEraser: false, sentAt: Date.now(), dabs });
      }, 24));
      timers.push(setInterval(() => {
        seq += 1;
        b.socket!.emit('tile_patch', { type: 'TILE_PATCH', canvasId: canvas.id, layerId: b.layerId, tiles: [tile(i % 8, 1, seq), tile((i + 1) % 8, 2, seq + 3)], clientSeq: seq });
      }, 1200 + i * 7));
    });
    return () => timers.forEach(clearInterval);
  };

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
  const pages: Page[] = [];
  try {
    for (const p of painters) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      // tsx (esbuild keepNames) wraps functions in __name(); the page script needs it to exist
      await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
      await ctx.addInitScript(([token, canvasId]) => {
        localStorage.setItem('atelier_token', token);
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_active_canvas_id', canvasId);
      }, [p.token, canvas.id]);
      const page = await ctx.newPage();
      // CPU_THROTTLE=2 ≈ a Snapdragon 8 Gen 3 phone or an iPad next to a desktop CPU, 4 ≈ a mid-range phone
      const throttle = Number(process.env.CPU_THROTTLE || 1);
      if (throttle > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
      await page.goto(BASE);
      pages.push(page);
    }
    console.log(`… ${pages.length} pages open; drawing (every third page also plays the animation)`);
    const stopBots = startBots();
    const results = await Promise.all(pages.map((page, index) =>
      page.evaluate(painterScript, { index, seconds: SECONDS, width: WIDTH, height: HEIGHT, play: CELS > 1 && index % 3 === 0, cels: CELS })));

    stopBots();
    bots.forEach((b) => b.socket?.close());
    const all = (k: 'latencyP50' | 'latencyP95') => results.flatMap((r) => r[k]);
    console.log(`GPU: ${results[0].gpu}`);
    const fmt = (t: any) => `${t.megabytes} MB GPU (${t.textures} canvas-sized textures${t.resident !== undefined ? `; resident ${t.resident}, ping-pong ${t.pingPong}, warm ${t.warm} with ${t.tiles} tiles, cold ${t.cold}, CPU ${t.cpuMegabytes} MB` : ''}), JS heap ${t.heap} MB`;
    console.log(`Layer memory per page after load: ${fmt(results[0].atLoad)}`);
    console.log(`Layer memory per page at the end:  ${fmt(results[0].textures)}`);
    results.forEach((r, i) => {
      const fps = r.frames.length * 1000 / r.elapsed;
      const playback = CELS > 1 && i % 3 === 0
        ? `；動畫 ${(r.animationFrames * 1000 / r.elapsed).toFixed(2)} 格／秒，播放期間 syncLayers 同步解壓 ${r.synchronousThaws} 次`
        : '';
      console.log(`  瀏覽器${String(i + 1).padStart(2)} ${fps.toFixed(1)} fps  frame p50 ${q(r.frames, 0.5).toFixed(0)}ms p95 ${q(r.frames, 0.95).toFixed(0)}ms max ${Math.max(...r.frames).toFixed(0)}ms  strokes ${r.strokes}  sees ${r.senders} painters${playback}`);
      console.log(`    Long Animation Frames: ${r.longFrameCount ?? 'unsupported'}`);
      for (const frame of r.slowestLongFrames) {
        console.log(`    ${frame.duration}ms (${frame.blocking}ms blocking) ${frame.source || '(no attributed script)'}`);
      }
    });
    console.log(`Live-stroke delay to the others: p50 of medians ${q(all('latencyP50'), 0.5)}ms, worst median ${Math.max(...all('latencyP50'))}ms, p95 of p95s ${q(all('latencyP95'), 0.95)}ms`);
    const seen = results.map((r) => r.senders);
    console.log(`Each page saw previews from ${Math.min(...seen)}–${Math.max(...seen)} of the ${PAINTERS - 1 + BOTS} other painters`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('❌ browser load test failed:', err);
  process.exit(1);
});

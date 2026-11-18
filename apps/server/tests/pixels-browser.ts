/**
 * Screen-pixel test in a real (headless) Chrome: what the workspace actually composites.
 *
 *   PORT=3100 DATA_DIR=<throwaway> node dist/server.js        (after pnpm -r build)
 *   npx tsx tests/pixels-browser.ts http://127.0.0.1:3100
 *
 * 1. A layer with a mask and blend mode 色彩增值 (multiply) / 覆蓋 (overlay) over an orange base:
 *    where the mask is white it must show the blend, where it is black the base. It used to come
 *    out black: the blend was applied inside the mask filter's empty buffer.
 * 2. Merging that layer down bakes the same pixels into the base.
 *
 * Uses the installed Chrome via playwright-core and creates its own accounts and canvas, so point
 * it at a throwaway server only.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const SIZE = 512;

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

/** Fills a whole SIZE×SIZE layer; fill(x, y) gives premultiplied RGBA */
async function paint(token: string, canvasId: string, layerId: string, fill: (x: number, y: number) => [number, number, number, number]) {
  const tiles = [];
  for (let row = 0; row < SIZE / 256; row++) {
    for (let col = 0; col < SIZE / 256; col++) {
      const px = Buffer.alloc(256 * 256 * 4);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) px.set(fill(col * 256 + x, row * 256 + y), (y * 256 + x) * 4);
      tiles.push({ col, row, width: 256, height: 256, compression: 'raw', data: px.toString('base64') });
    }
  }
  await api(token, 'POST', `/api/canvases/${canvasId}/layers/${layerId}/tiles`, { tiles });
}

let failures = 0;
const near = (got: number[], want: number[], tol = 4) => got.every((v, i) => Math.abs(v - want[i]) <= tol);
const check = (name: string, got: number[], want: number[]) => {
  const ok = near(got, want);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}: got (${got.join(',')}), want (${want.join(',')})`);
};

async function main() {
  if (!CHROME) throw new Error('Chrome not found');
  const run = Date.now().toString(36).slice(-5);
  const { token } = await api(null, 'POST', '/api/auth/register', { username: `px_${run}`, password: 'password123', displayName: 'pixels' });
  const { canvas } = await api(token, 'POST', '/api/canvases', { title: `pixels ${run}`, width: SIZE, height: SIZE });
  const url = `/api/canvases/${canvas.id}/layers`;
  const make = async (body: Record<string, unknown>) => (await api(token, 'POST', url, body)).layer.id as string;
  const base = await make({ name: 'base' });
  const mul = await make({ name: 'mul', blendMode: 'multiply' });
  const mulMask = await make({ name: 'mul mask', layerType: 'mask', parentId: mul });
  const ovl = await make({ name: 'ovl', blendMode: 'overlay' });
  const ovlMask = await make({ name: 'ovl mask', layerType: 'mask', parentId: ovl });
  const ORANGE: [number, number, number, number] = [200, 100, 50, 255];
  const BLUE: [number, number, number, number] = [128, 128, 255, 255];
  await paint(token, canvas.id, base, () => ORANGE);
  // multiply covers the top half, overlay the bottom half; masks show the left half only
  await paint(token, canvas.id, mul, (_x, y) => (y < SIZE / 2 ? BLUE : [0, 0, 0, 0]));
  await paint(token, canvas.id, ovl, (_x, y) => (y >= SIZE / 2 ? BLUE : [0, 0, 0, 0]));
  const halfWhite = (x: number): [number, number, number, number] => (x < SIZE / 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
  await paint(token, canvas.id, mulMask, halfWhite);
  await paint(token, canvas.id, ovlMask, halfWhite);

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
    await page.goto(BASE);
    await page.waitForFunction((n) => (window as any).__debugPixi?.layerManager?.getLayers().length >= n, 6, { timeout: 30000 });
    await page.waitForTimeout(2500); // replay lands, layers settle

    // What the screen shows (the composite the export / thumbnails use, same scene graph)
    const at = (pts: Array<[number, number]>) => page.evaluate((points) => {
      const lm = (window as any).__debugPixi.layerManager;
      const c = lm.renderCompositeCanvas() as HTMLCanvasElement;
      const ctx2 = c.getContext('2d')!;
      return points.map(([x, y]) => Array.from(ctx2.getImageData(x, y, 1, 1).data).slice(0, 3));
    }, pts);
    const q = SIZE / 4;
    const [mulIn, mulOut, ovlIn, ovlOut] = await at([[q, q], [3 * q, q], [q, 3 * q], [3 * q, 3 * q]]);
    // multiply: 200×128/255, 100×128/255, 50×255/255
    check('色彩增值＋蒙版（白）＝相乘', mulIn, [100, 50, 50]);
    check('色彩增值＋蒙版（黑）＝底圖', mulOut, [200, 100, 50]);
    // overlay with the base as backdrop: r 1−2(1−.784)(1−.502)=.785, g 2·.392·.502=.394, b 2·.196·1=.392
    check('覆蓋＋蒙版（白）＝覆蓋', ovlIn, [200, 100, 100]);
    check('覆蓋＋蒙版（黑）＝底圖', ovlOut, [200, 100, 50]);

    // Merge the multiply layer down (Ctrl+E on it) and read the base layer's own pixels
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-layer-id]')].find((r) => r.textContent?.includes('mul') && !r.textContent?.includes('mask'));
      (row as HTMLElement | undefined)?.click();
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true })));
    await page.waitForTimeout(1200);
    const merged = await page.evaluate(([b, s]) => {
      const d = (window as any).__debugPixi;
      const item = d.layerManager.getLayerItem(b);
      const read = (x: number, y: number) => Array.from(d.tileEngine.readRegion(item.renderTexture, x, y, 1, 1) as Uint8Array).slice(0, 3);
      return { gone: !d.layerManager.getLayerItem(s), inside: read(128, 128), outside: read(384, 128) };
    }, [base, mul]);
    if (!merged.gone) {
      failures++;
      console.log('❌ 向下合併沒有執行（色彩增值圖層還在）');
    } else {
      check('向下合併後底圖（蒙版白處）＝相乘', merged.inside, [100, 50, 50]);
      check('向下合併後底圖（蒙版黑處）＝原色', merged.outside, [200, 100, 50]);
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n❌ ${failures} 項像素檢查失敗` : '\n✅ 畫面像素測試全部通過');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ pixels test failed:', err);
  process.exit(1);
});

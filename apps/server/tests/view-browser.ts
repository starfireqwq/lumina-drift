/**
 * View regression checks in a real (headless) Chrome: canvas pixels turn into sharp squares from 200 %
 * zoom (nearest sampling), the lasso outline and marching ants keep one on-screen width at any zoom,
 * and the outline brush leaves no see-through gap between a stroke and its ring.
 *
 *   PORT=3100 DATA_DIR=<throwaway> node dist/server.js        (after pnpm -r build)
 *   npx tsx tests/view-browser.ts http://127.0.0.1:3100
 *
 * Creates its own account and canvas: point it at a throwaway server only. Screenshots go to the OS temp dir.
 */
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-view-'));
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

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

async function main() {
  const tag = Date.now().toString(36).slice(-6);
  const A = await api(null, 'POST', '/api/auth/register', { username: `vu_${tag}`, password: 'password123', displayName: 'V' });
  const { canvas } = await api(A.token, 'POST', '/api/canvases', { title: `vu ${tag}`, width: 1024, height: 1024 });
  const url = `/api/canvases/${canvas.id}/layers`;
  const { layer: checker } = await api(A.token, 'POST', url, { name: 'Checker' });
  const { layer: ink } = await api(A.token, 'POST', url, { name: 'Ink' });
  // 1 px black / transparent checkerboard in tile (1, 1)
  const px = Buffer.alloc(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if ((x + y) % 2 === 0) px[(y * 256 + x) * 4 + 3] = 255;
  await api(A.token, 'POST', `${url}/${checker.id}/tiles`, { tiles: [{ col: 1, row: 1, width: 256, height: 256, compression: 'raw', data: px.toString('base64') }] });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
    await ctx.addInitScript(([t, c]: string[]) => {
      localStorage.setItem('atelier_token', t);
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_active_canvas_id', c);
      localStorage.setItem('atelier_outline_brush', JSON.stringify({ enabled: true, width: 4, color: '#ff2020' }));
    }, [A.token, canvas.id]);
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e: Error) => errors.push(e.message));
    await p.goto(BASE);
    await p.locator(`[data-layer-id="${ink.id}"]`).waitFor({ timeout: 30000 });
    await p.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 4, null, { timeout: 30000 });
    await p.waitForFunction((id: string) => {
      const lm = (window as any).__debugPixi.layerManager;
      return lm.occupiedTiles(id)?.length > 0 || Boolean(lm.getLayerItem(id)?.rt);
    }, checker.id, { timeout: 20000 });
    await p.waitForTimeout(800);

    const focus = (x: number, y: number, zoom: number) => p.evaluate(([x, y, z]: number[]) => {
      const d = (window as any).__debugPixi;
      d.viewport.setZoom(z);
      const c = d.viewport.canvasToScreen(x, y);
      d.viewport.panBy(d.app.screen.width / 2 - c.x + 0.37, d.app.screen.height / 2 - c.y + 0.21); // off the pixel grid on purpose
    }, [x, y, zoom]).then(() => p.waitForTimeout(300)).then(() => p.evaluate(() => (window as any).__debugPixi.layerManager.pixelated as boolean));
    const grayShare = async (file: string) => {
      const box = await p.evaluate(() => {
        const r = (window as any).__debugPixi.app.canvas.getBoundingClientRect();
        return { x: r.left + r.width / 2 - 100, y: r.top + r.height / 2 - 100, width: 200, height: 200 };
      });
      const png = await p.screenshot({ clip: box });
      fs.writeFileSync(`${OUT}/${file}`, png);
      // decode via the page (createImageBitmap) to count mid-gray pixels
      return p.evaluate(async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        let gray = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 40 && d[i] < 215) gray++;
        return gray / (d.length / 4);
      }, png.toString('base64'));
    };

    // 1. Sharp pixels from 200 %
    const pix8 = await focus(384, 384, 8);
    await p.waitForTimeout(400);
    const gray8 = await grayShare('zoom8.png');
    const pageFilter = await p.evaluate(() => {
      const lm = (window as any).__debugPixi.layerManager;
      const pages = (lm.atlas.pages as any[]).filter(Boolean);
      return pages.map((pg) => pg.rt.source.magFilter).join(',');
    });
    check('放大 800%：圖層取樣改為 nearest（銳利像素）', pix8 === true && /nearest/.test(pageFilter) && !/linear/.test(pageFilter), `pages=${pageFilter}`);
    check('放大 800%：1px 棋盤格呈現純黑白方塊，幾乎沒有模糊灰階', gray8 < 0.02, `gray ${(gray8 * 100).toFixed(2)}%`);
    const pix15 = await focus(384, 384, 1.5);
    await p.waitForTimeout(400);
    const gray15 = await grayShare('zoom150.png');
    check('150% 時維持平滑取樣（linear）', pix15 === false, `gray ${(gray15 * 100).toFixed(1)}%`);
    const pix2 = await focus(384, 384, 2);
    check('200% 起切換為銳利像素', pix2 === true);

    // 2. Lasso width stays ~1.5 screen px at 0.25× and 4×
    await p.evaluate(() => (document.querySelector('nav[aria-label="工具"] button[aria-label^="套索選取"]') as HTMLButtonElement).click());
    const lassoWidths: Record<string, unknown> = {};
    for (const z of [0.25, 1, 4]) {
      await focus(512, 512, z);
      await p.waitForTimeout(200);
      const w = await p.evaluate(async (zoom: number) => {
        const d = (window as any).__debugPixi;
        const el = document.querySelector('.atelier-canvas-viewport')!;
        const s = (x: number, y: number) => { const q = d.viewport.canvasToScreen(x, y); const r = d.app.canvas.getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; };
        const fire = (type: string, x: number, y: number, btns: number) => { const q = s(x, y); el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: q.x, clientY: q.y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: btns, pressure: btns ? 0.5 : 0 })); };
        const r = 40 / zoom; // 40 screen px around the centre
        fire('pointerdown', 512 - r, 512 - r, 1);
        for (const [x, y] of [[512 + r, 512 - r], [512 + r, 512 + r], [512 - r, 512 + r]]) { fire('pointermove', x, y, 1); await new Promise((res) => setTimeout(res, 30)); }
        await new Promise((res) => setTimeout(res, 120));
        const g = d.selectionEngine.selectionGraphic;
        const widths = (g.context.instructions as any[]).filter((i) => i.action === 'stroke').map((i) => i.data.style.width * zoom);
        return widths;
      }, z);
      await p.waitForTimeout(150);
      fs.writeFileSync(`${OUT}/lasso_${z}.png`, await p.screenshot({ clip: await p.evaluate(() => { const r = (window as any).__debugPixi.app.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2 - 70, y: r.top + r.height / 2 - 70, width: 140, height: 140 }; }) }));
      await p.evaluate(() => {
        const el = document.querySelector('.atelier-canvas-viewport')!;
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 0, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }));
      });
      await p.waitForTimeout(300);
      await p.keyboard.press('Control+d');
      lassoWidths[String(z)] = w;
    }
    const inner = Object.values(lassoWidths).map((w: any) => w[w.length - 1]);
    check('套索草稿線在 25%／100%／400% 的螢幕線寬都是 1.5 px', inner.every((w) => Math.abs(w - 1.5) < 0.01), JSON.stringify(lassoWidths));
    await p.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true, bubbles: true })));
    await p.waitForTimeout(600);
    const ants = await p.evaluate(() => {
      const se = (window as any).__debugPixi.selectionEngine;
      se.setViewScale(4);
      const w4 = (se.marchingAntsGraphic.context.instructions as any[]).filter((i) => i.action === 'stroke').map((i) => i.data.style.width * 4);
      se.setViewScale(0.25);
      const w025 = (se.marchingAntsGraphic.context.instructions as any[]).filter((i) => i.action === 'stroke').map((i) => i.data.style.width * 0.25);
      se.setViewScale((window as any).__debugPixi.viewport.getState().zoom);
      return { w4, w025 };
    });
    check('選區螞蟻線在 400%／25% 都是 1 px', ants.w4.length > 0 && ants.w025.length > 0 && [...ants.w4, ...ants.w025].every((w: number) => Math.abs(w - 1) < 0.01), JSON.stringify(ants));

    // 3. Outline brush: no see-through seam between the stroke and its ring
    await focus(512, 700, 1);
    await p.locator(`[data-layer-id="${ink.id}"]`).click({ position: { x: 140, y: 20 } });
    await p.evaluate(() => (document.querySelector('nav[aria-label="工具"] button[aria-label^="筆刷"]') as HTMLButtonElement).click());
    await p.waitForTimeout(300);
    const outlineOn = await p.locator('label:has-text("描邊") input[type="checkbox"]').first().isChecked().catch(() => false);
    await p.evaluate(async () => {
      const d = (window as any).__debugPixi;
      const el = document.querySelector('.atelier-canvas-viewport')!;
      const s = (x: number, y: number) => { const q = d.viewport.canvasToScreen(x, y); const r = d.app.canvas.getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; };
      const fire = (type: string, x: number, y: number, btns: number) => { const q = s(x, y); el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: q.x, clientY: q.y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: btns, pressure: btns ? 0.9 : 0 })); };
      fire('pointerdown', 400, 700, 1);
      for (let x = 410; x <= 640; x += 10) { fire('pointermove', x, 700, 1); await new Promise((r) => setTimeout(r, 12)); }
      fire('pointerup', 640, 700, 0);
    });
    await p.waitForTimeout(1500);
    const profile = await p.evaluate(async (id: string) => {
      const lm = (window as any).__debugPixi.layerManager;
      const [col] = await lm.readAsync(id, [{ x: 520, y: 640, w: 1, h: 120 }]);
      const out: Array<[number, number, number, number]> = [];
      for (let i = 0; i < 120; i++) out.push([col[i * 4], col[i * 4 + 1], col[i * 4 + 2], col[i * 4 + 3]]);
      return out;
    }, ink.id);
    const alphas = profile.map((q) => q[3]);
    const first = alphas.findIndex((a) => a >= 250);
    const last = alphas.length - 1 - [...alphas].reverse().findIndex((a) => a >= 250);
    const inside = first >= 0 ? alphas.slice(first, last + 1) : [];
    const minInside = inside.length ? Math.min(...inside) : -1;
    const ringPx = profile.filter((q) => q[3] >= 250 && q[0] > 200 && q[1] < 60 && q[2] < 60).length;
    check('描邊已開啟並畫出描邊色', outlineOn && ringPx >= 4, `outline=${outlineOn}, ring px=${ringPx}`);
    check('描邊與筆身之間沒有透明縫（剖面內最小 α ≥ 250）', inside.length > 10 && minInside >= 250, `α profile ${alphas.filter((a) => a > 0).join(',')}`);
    fs.writeFileSync(`${OUT}/outline_profile.json`, JSON.stringify(profile));
    await focus(520, 700, 6);
    await p.waitForTimeout(400);
    fs.writeFileSync(`${OUT}/outline_zoom6.png`, await p.screenshot({ clip: await p.evaluate(() => { const r = (window as any).__debugPixi.app.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2 - 160, y: r.top + r.height / 2 - 160, width: 320, height: 320 }; }) }));
    check('沒有頁面錯誤', errors.length === 0, errors.join('; '));
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} check(s) failed` : 'all UI checks passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

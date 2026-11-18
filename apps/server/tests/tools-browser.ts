/**
 * Tool regression test in a real (headless) Chrome, on sparse layers (the active layer is no longer
 * one canvas-sized texture): brush, fill, selection, transform, liquify, vector editing, layer
 * operations, and touch shortcuts. Also checks undo and pixel sync between two painters.
 *
 *   PORT=3100 DATA_DIR=<throwaway> node dist/server.js        (after pnpm -r build)
 *   npx tsx tests/tools-browser.ts http://127.0.0.1:3100
 *
 * Creates its own accounts and canvas: point it at a throwaway server only.
 */
import { chromium, type Page } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const SIZE = 1024;

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

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

/** Page helpers, installed once per page */
const HELPERS = `
window.__t = {
  d: () => window.__debugPixi,
  item: (name) => window.__debugPixi.layerManager.getLayers().find((l) => l.model.name === name),
  async opaque(name, x = 0, y = 0, w = ${SIZE}, h = ${SIZE}) {
    const it = window.__t.item(name); if (!it) return -1;
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x, y, w, h }]);
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++; return n;
  },
  async hash(name, x = 0, y = 0, w = ${SIZE}, h = ${SIZE}) {
    const it = window.__t.item(name); if (!it) return 'missing';
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x, y, w, h }]);
    let hash = 2166136261; for (const byte of px) { hash ^= byte; hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16);
  },
  pt(x, y) { const d = window.__debugPixi; const p = d.viewport.canvasToScreen(x, y); const r = d.app.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; },
  ev(type, x, y, buttons, extra = {}) { const c = window.__t.pt(x, y); document.querySelector('.atelier-canvas-viewport').dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: c.x, clientY: c.y, buttons, button: 0, pressure: 0.8, ...extra })); },
  frame: () => new Promise((r) => requestAnimationFrame(() => r())),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  async drag(pts) { const t = window.__t; t.ev('pointerdown', pts[0][0], pts[0][1], 1); for (const [x, y] of pts.slice(1)) { t.ev('pointermove', x, y, 1); await t.frame(); } const l = pts[pts.length - 1]; t.ev('pointerup', l[0], l[1], 0); await t.wait(600); },
  key(key, opts = {}) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, ...opts })); },
  tool(label) { const b = document.querySelector('nav[aria-label="工具"] button[aria-label^="' + label + '"]'); b?.click(); return Boolean(b); },
  select(name) { const row = [...document.querySelectorAll('[data-layer-id]')].find((r) => r.querySelector('[title^="' + name + '（"]')); row?.click(); return Boolean(row); },
  async undo() { window.__t.key('z', { ctrlKey: true }); await window.__t.wait(700); },
  strokes(name) { return JSON.stringify(window.__t.d().vectorEngine.getStrokes(window.__t.item(name).model.id)); },
  selectionBounds() { return window.__t.d().selectionEngine.getMaskData()?.bounds ?? null; },
};`;

async function open(browser: any, token: string, canvasId: string, base = BASE, mobile = false): Promise<Page> {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(([t, c]: string[]) => {
    localStorage.setItem('atelier_token', t);
    localStorage.setItem('atelier_gateway_resolved', '1');
    localStorage.setItem('atelier_active_canvas_id', c);
    localStorage.setItem('atelier_brush_tools', JSON.stringify({ brush: { spacing: 0.02, stabilizerLevel: 0 } }));
  }, [token, canvasId]);
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => console.log('pageerror:', e.message));
  await page.goto(base);
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 2, null, { timeout: 30000 });
  await page.addScriptTag({ content: HELPERS });
  await page.waitForTimeout(1500);
  return page;
}

/** Playwright waitForFunction 會將 async 函式回傳的 Promise 直接視為 truthy，需在 Node 端輪詢 await 結果 */
async function waitUntil<T>(page: Page, fn: (arg: T) => Promise<boolean> | boolean, arg: T, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn as (arg: T) => Promise<boolean> | boolean, arg)) return;
    await page.waitForTimeout(80);
  }
  throw new Error(`waitUntil timed out after ${timeout}ms`);
}

async function moveTransform(page: Page, dy: number) {
  // A browser tab never receives Ctrl+T (new tab): free transform is Ctrl+Alt+T there
  await page.evaluate(`__t.key('t', { ctrlKey: true, altKey: true })`);
  const surface = page.getByAltText('transform-preview').locator('..');
  await surface.waitFor({ state: 'visible' });
  const box = await surface.boundingBox();
  if (!box) throw new Error('Transform move surface has no bounding box');
  const delta = await page.evaluate(`(() => {
    const p = __t.pt(0, 0), q = __t.pt(0, ${dy});
    return { x: q.x - p.x, y: q.y - p.y };
  })()`) as { x: number; y: number };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta.x, y + delta.y, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(`__t.key('Enter')`);
  await surface.waitFor({ state: 'hidden' });
}

async function main() {
  if (!CHROME) throw new Error('Chrome not found');
  const run = Date.now().toString(36).slice(-5);
  const A = await api(null, 'POST', '/api/auth/register', { username: `ta_${run}`, password: 'password123', displayName: 'A' });
  const B = await api(null, 'POST', '/api/auth/register', { username: `tb_${run}`, password: 'password123', displayName: 'B' });
  const { canvas } = await api(A.token, 'POST', '/api/canvases', { title: `tools ${run}`, width: SIZE, height: SIZE });
  await api(B.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
  const url = `/api/canvases/${canvas.id}/layers`;
  await api(A.token, 'POST', url, { name: 'L1' });
  await api(A.token, 'POST', url, { name: 'L2' });
  await api(B.token, 'POST', url, { name: 'B1' });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
  try {
    const a = await open(browser, A.token, canvas.id);
    const secondOrigin = new URL(BASE);
    if (secondOrigin.hostname === '127.0.0.1') secondOrigin.hostname = 'localhost';
    const b = await open(browser, B.token, canvas.id, secondOrigin.origin);
    const E = <T>(fn: string) => a.evaluate(fn) as Promise<T>;

    // Brush on L1: stays sparse
    await E(`(async () => { __t.select('L1'); await __t.wait(300); __t.tool('筆刷'); await __t.wait(200);
      await __t.drag(Array.from({ length: 30 }, (_, i) => [100 + i * 20, 200 + Math.sin(i / 3) * 30])); })()`);
    const brushPx = await E<number>(`__t.opaque('L1')`);
    const resident = await E<boolean>(`Boolean(__t.item('L1').rt)`);
    check('筆刷畫在稀疏圖層（不轉成整張貼圖）', brushPx > 1000 && !resident, `${brushPx} px, resident=${resident}`);

    await E(`(async () => { __t.select('L2'); await __t.wait(200); await __t.drag([[100, 460], [495, 460], [895, 460]]); })()`);
    const fastCoverage = await E<number>(`__t.opaque('L2', 100, 460, 775, 1)`);
    check('快速移動的筆刷沒有斷點', fastCoverage === 775, `${fastCoverage}/775 px`);
    await E(`__t.undo()`);

    // Bucket fill an empty area of L2 (reference: current layer) → whole layer filled
    await E(`(async () => { __t.select('L2'); await __t.wait(300); __t.tool('油漆桶'); await __t.wait(200);
      __t.ev('pointerdown', 500, 700, 1); __t.ev('pointerup', 500, 700, 0); await __t.wait(1500); })()`);
    const fillPx = await E<number>(`__t.opaque('L2')`);
    check('油漆桶填滿空圖層', fillPx > SIZE * SIZE * 0.9, `${fillPx} px`);
    await E(`__t.undo()`);
    const fillUndo = await E<number>(`__t.opaque('L2')`);
    check('油漆桶可復原', fillUndo === 0, `${fillUndo} px after undo`);

    // Select a box on L1 with the lasso and delete it
    const before = await E<number>(`__t.opaque('L1', 90, 150, 300, 120)`);
    await E(`(async () => { __t.select('L1'); await __t.wait(300); __t.tool('套索'); await __t.wait(200);
      await __t.drag([[90, 150], [390, 150], [390, 270], [90, 270], [90, 151]]); __t.key('Delete'); await __t.wait(1200); })()`);
    const after = await E<number>(`__t.opaque('L1', 90, 150, 300, 120)`);
    const elsewhere = await E<number>(`__t.opaque('L1', 400, 150, 300, 120)`);
    check('選取後刪除只清掉選取範圍', before > 0 && after === 0 && elsewhere > 0, `inside ${before}→${after}, outside ${elsewhere}`);
    await E(`__t.undo()`);
    check('刪除選取內容可復原', (await E<number>(`__t.opaque('L1', 90, 150, 300, 120)`)) === before);
    await E(`(async () => { __t.key('d', { ctrlKey: true }); await __t.wait(200); })()`);

    // Sync: B has L1 exactly as A
    await b.waitForTimeout(1500);
    const [ha, hb] = [await E<string>(`__t.hash('L1')`), await b.evaluate(`__t.hash('L1')`) as string];
    check('第二位畫師的 L1 像素與 A 相同', ha === hb, `${ha} / ${hb}`);
    await b.evaluate(`(async () => { __t.select('B1'); await __t.wait(200); __t.tool('筆刷'); await __t.wait(200); await __t.drag([[440, 520], [480, 540], [520, 550]]); })()`);
    const bPainted = await b.evaluate(`__t.hash('B1')`);
    await waitUntil(a, async (expected) => await (window as any).__t.hash('B1') === expected, bPainted, 10000).catch(() => null);
    check('B 的筆劃同步到 A', bPainted === await E<string>(`__t.hash('B1')`) && (await E<number>(`__t.opaque('B1')`)) > 0);
    await b.evaluate(`__t.undo()`);
    await waitUntil(a, async () => await (window as any).__t.opaque('B1') === 0, null, 10000).catch(() => null);
    check('B 的復原也同步到 A', (await E<number>(`__t.opaque('B1')`)) === 0);

    // Copy + paste L1 (圖層副本): same pixels in the new layer
    await E(`(async () => { __t.select('L1'); await __t.wait(300); __t.key('j', { ctrlKey: true }); await __t.wait(2500); })()`);
    const names = await E<string[]>(`__debugPixi.layerManager.getLayers().map((l) => l.model.name)`);
    const copyName = names.find((n) => n !== 'L1' && n.startsWith('L1'));
    const copyHash = copyName ? await a.evaluate(`__t.hash(${JSON.stringify(copyName)})`) : 'none';
    check('製作圖層副本像素相同', Boolean(copyName) && copyHash === ha, `${copyName}: ${copyHash} vs ${ha}`);

    // Merge the copy down into L1 (normal blend: L1 keeps its pixels)
    if (copyName) {
      await E(`(async () => { __t.select(${JSON.stringify(copyName)}); await __t.wait(300); __t.key('e', { ctrlKey: true }); await __t.wait(2500); })()`);
      const gone = await E<boolean>(`!__t.item(${JSON.stringify(copyName)})`);
      const merged = await E<number>(`__t.opaque('L1')`);
      check('向下合併：上層移除、下層保有內容', gone && merged >= brushPx * 0.95, `${merged} px`);
      await E(`__t.undo()`);
      const back = await E<boolean>(`Boolean(__debugPixi.layerManager.getLayers().find((l) => l.model.name === ${JSON.stringify(copyName)}))`);
      check('向下合併可復原（圖層回來）', back);
    }

    // Drag the actual move surface down by 100 canvas pixels and apply with Enter.
    await a.getByTitle('重設為 100%', { exact: true }).click();
    await E(`(() => { const d = __t.d(); const p = d.viewport.canvasToScreen(390, 200); d.viewport.panBy(d.app.screen.width / 2 - p.x, d.app.screen.height / 2 - p.y); })()`);
    await E(`(async () => { __t.select('L1'); await __t.wait(300); })()`);
    const beforeMove = await E<number>(`__t.opaque('L1')`);
    const lowerBand = await E<number>(`__t.opaque('L1', 0, 255, ${SIZE}, 120)`);
    await moveTransform(a, 100);
    const movedLower = await E<number>(`__t.opaque('L1', 0, 255, ${SIZE}, 120)`);
    const movedTotal = await E<number>(`__t.opaque('L1')`);
    check('變形套用後像素數相同且向下移動', movedTotal === beforeMove && movedLower > lowerBand, `total ${beforeMove}→${movedTotal}, lower ${lowerBand}→${movedLower}`);
    await a.getByTitle('符合視窗並置中', { exact: true }).click();

    // Liquify a few pushes on L1, then undo restores it exactly
    const preLiq = await E<string>(`__t.hash('L1')`);
    await E(`(async () => { if (!__t.tool('液化')) throw new Error('Liquify tool missing'); await __t.wait(200); await __t.drag(Array.from({ length: 15 }, (_, i) => [200 + i * 15, 300])); await __t.wait(800); })()`);
    const liq = await E<string>(`__t.hash('L1')`);
    await E(`__t.undo()`);
    const unLiq = await E<string>(`__t.hash('L1')`);
    check('液化改變像素且可完整復原', liq !== preLiq && unLiq === preLiq, `${preLiq} → ${liq} → ${unLiq}`);

    const { layer: folder } = await api(A.token, 'POST', url, { name: '動畫軌', layerType: 'group', meta: { animation: { fps: 12 } } });
    const { layer: cel } = await api(A.token, 'POST', url, { name: '測試動畫格', parentId: folder.id });
    await a.locator(`[data-layer-id="${folder.id}"]`).waitFor();
    await E(`(async () => { __t.select('L1'); await __t.wait(200); __t.key('c', { ctrlKey: true, altKey: true }); })()`);
    for (const anchor of [folder, cel]) {
      if (anchor === cel) {
        const row = a.locator(`[data-layer-id="${cel.id}"]`);
        if (!(await row.isVisible())) await a.locator(`[data-layer-id="${folder.id}"]`).getByRole('button', { name: /展開|收合/ }).click();
      }
      const { layers: previous } = await api(A.token, 'GET', url);
      const prevIds = new Set(previous.map((l: any) => l.id));
      const prevDrawable = previous.filter((l: any) => l.layerType !== 'group').length;
      await a.locator(`[data-layer-id="${anchor.id}"]`).click();
      await E(`(async () => { await __t.wait(200); __t.key('v', { ctrlKey: true, altKey: true }); })()`);
      await a.waitForFunction((n) => (window as any).__debugPixi.layerManager.getLayers().length > n, prevDrawable);
      const { layers } = await api(A.token, 'GET', url);
      // Where the folder is now: the server renumbers it when cels go in, so its creation-time order is stale
      const folderOrder = layers.find((l: any) => l.id === folder.id).sortOrder;
      const sibling = layers.filter((l: any) => l.parentId === folder.parentId && l.sortOrder > folderOrder)
        .sort((x: any, y: any) => x.sortOrder - y.sortOrder)[0];
      check(`從「${anchor.name}」貼上會插在動畫資料夾正上方`, sibling?.name === 'L1 複製' && !prevIds.has(sibling.id) && layers.filter((l: any) => l.parentId === folder.id).length === 1);
    }

    await E(`(async () => { __t.select('L2'); await __t.wait(200); if (!__t.tool('形狀')) throw new Error('Shape tool missing'); await __t.wait(200); await __t.drag([[120, 520], [220, 575], [360, 630]]); })()`);
    check('形狀落在稀疏圖層', (await E<number>(`__t.opaque('L2', 100, 500, 300, 160)`)) > 0 && !(await E<boolean>(`Boolean(__t.item('L2').rt)`)));
    await E(`__t.undo()`);
    check('形狀可復原', (await E<number>(`__t.opaque('L2')`)) === 0);

    const maskButton = a.getByTitle(/^加圖層蒙版：/);
    await maskButton.click();
    await a.waitForFunction(() => (window as any).__debugPixi.layerManager.getLayers().some((item: any) => item.model.layerType === 'mask'));
    const { layers: maskedLayers } = await api(A.token, 'GET', url);
    const l2 = maskedLayers.find((l: any) => l.name === 'L2');
    const mask = maskedLayers.find((l: any) => l.layerType === 'mask' && l.parentId === l2.id);
    if (mask) await waitUntil(a, async (name) => (await (window as any).__t.opaque(name)) === 1024 * 1024, mask.name);
    check('新增蒙版後整張圖層預設顯示', Boolean(mask) && (await E<number>(`__t.opaque(${JSON.stringify(mask?.name ?? '')})`)) === SIZE * SIZE);

    const { layer: ink } = await api(A.token, 'POST', url, { name: 'Line Art' });
    const { layer: flat } = await api(A.token, 'POST', url, { name: 'Flat' });
    // An opaque black rectangle crossing both tile axes, well away from the canvas origin.
    const tiles = [];
    for (const row of [1, 2]) {
      for (const col of [1, 2]) {
        const pixels = Buffer.alloc(256 * 256 * 4);
        for (let y = 490; y < 580; y++) {
          for (let x = 480; x < 570; x++) {
            if (x >= 485 && x < 565 && y >= 495 && y < 575) continue;
            if ((x >> 8) !== col || (y >> 8) !== row) continue;
            pixels[((y % 256) * 256 + x % 256) * 4 + 3] = 255;
          }
        }
        tiles.push({ col, row, width: 256, height: 256, compression: 'raw', data: pixels.toString('base64') });
      }
    }
    await api(A.token, 'POST', `${url}/${ink.id}/tiles`, { tiles });
    await waitUntil(a, async () => await (window as any).__t.opaque('Line Art', 480, 490, 5, 90) === 450, null);
    const inkHash = await E<string>(`__t.hash('Line Art')`);
    await a.locator(`[data-layer-id="${flat.id}"]`).click();
    await E(`(async () => { if (!__t.tool('智能填色')) throw new Error('Smart fill tool missing');
      await __t.wait(200); await __t.drag([[468, 478], [582, 478], [582, 592], [468, 592], [468, 478]]); })()`);
    const filled = await E<number>(`__t.opaque('Flat')`);
    const inside = await E<number>(`__t.opaque('Flat', 485, 495, 80, 80)`);
    const inBox = await E<number>(`__t.opaque('Flat', 480, 490, 90, 90)`);
    check('智能填色正確對應跨圖塊的局部座標', inside === 6400 && filled === inBox
      && await E<string>(`__t.hash('Line Art')`) === inkHash, `inside ${inside}/6400, box ${inBox}, total ${filled}`);

    await a.getByTitle('重設為 100%', { exact: true }).click();
    await E(`(() => { const d = __t.d(); const p = d.viewport.canvasToScreen(525, 565);
      d.viewport.panBy(d.app.screen.width / 2 - p.x, d.app.screen.height / 2 - p.y); })()`);
    await E(`(async () => { __t.tool('套索選取'); await __t.wait(200);
      await __t.drag([[470, 480], [580, 480], [580, 590], [470, 590], [470, 480]]); })()`);
    type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
    const oldSelection = await E<Bounds | null>(`__t.selectionBounds()`);
    await moveTransform(a, 140);
    const newSelection = await E<Bounds | null>(`__t.selectionBounds()`);
    const shiftedSelection = oldSelection && newSelection
      && Math.abs(newSelection.minX - oldSelection.minX) <= 1 && Math.abs(newSelection.maxX - oldSelection.maxX) <= 1
      && Math.abs(newSelection.minY - oldSelection.minY - 140) <= 1 && Math.abs(newSelection.maxY - oldSelection.maxY - 140) <= 1;
    const oldPixels = await E<number>(`__t.opaque('Flat', 480, 490, 90, 90)`);
    const movedPixels = await E<number>(`__t.opaque('Flat', 480, 630, 90, 90)`);
    check('選區外框與像素一起向下移動', Boolean(shiftedSelection) && oldPixels === 0 && movedPixels === filled && filled > 0,
      `${JSON.stringify(oldSelection)} → ${JSON.stringify(newSelection)}, ${movedPixels}/${filled} px`);
    await E(`(async () => { __t.key('Delete'); await __t.wait(700); })()`);
    check('移動後的選區可清除移動後的像素', await E<number>(`__t.opaque('Flat')`) === 0);
    await E(`__t.key('d', { ctrlKey: true })`);
    await a.getByTitle('符合視窗並置中', { exact: true }).click();

    const { layer: vector } = await api(A.token, 'POST', url, { name: 'Vector', layerType: 'vector' });
    await a.locator(`[data-layer-id="${vector.id}"]`).click();
    await E(`(async () => { if (!__t.tool('向量筆')) throw new Error('Vector pen missing'); await __t.wait(200);
      await __t.drag([[270, 375], [315, 375], [360, 375], [410, 375]]); })()`);
    const originalStrokes = await E<string>(`__t.strokes('Vector')`);
    const originalVectorPixels = await E<string>(`__t.hash('Vector')`);
    const anchor = JSON.parse(originalStrokes)[0]?.anchors[0];
    if (!anchor) throw new Error('Vector pen did not create an anchor for editing');
    await E(`(async () => { if (!__t.tool('節點編輯')) throw new Error('Vector node tool missing'); await __t.wait(200);
      await __t.drag([[${anchor.x}, ${anchor.y}], [${anchor.x}, ${anchor.y + 38}], [${anchor.x}, ${anchor.y + 75}]]); })()`);
    const editedStrokes = await E<string>(`__t.strokes('Vector')`);
    const editedVectorPixels = await E<string>(`__t.hash('Vector')`);
    const editedAnchor = JSON.parse(editedStrokes)[0]?.anchors[0];
    const movedAnchor = editedAnchor && Math.abs(editedAnchor.x - anchor.x) <= 1 && Math.abs(editedAnchor.y - anchor.y - 75) <= 1;
    if (movedAnchor) await b.waitForFunction((expected) => Boolean((window as any).__t.item('Vector')) && (window as any).__t.strokes('Vector') === expected, editedStrokes);
    await E(`__t.undo()`);
    const restoredStrokes = await E<string>(`__t.strokes('Vector')`);
    check('向量節點編輯與復原同步還原向量及像素', Boolean(movedAnchor) && editedVectorPixels !== originalVectorPixels
      && restoredStrokes === originalStrokes && await E<string>(`__t.hash('Vector')`) === originalVectorPixels);
    await b.waitForFunction((expected) => Boolean((window as any).__t.item('Vector')) && (window as any).__t.strokes('Vector') === expected, originalStrokes);
    check('另一位畫師同步收到向量復原後的像素', await b.evaluate(`__t.hash('Vector')`) === originalVectorPixels);

    const { layer: shared } = await api(A.token, 'POST', url, { name: 'Shared', aclMode: 'shared_all' });
    await a.locator(`[data-layer-id="${shared.id}"]`).click();
    await b.locator(`[data-layer-id="${shared.id}"]`).click();
    await E(`(async () => { __t.tool('筆刷'); await __t.wait(200); await __t.drag([[620, 760], [680, 760], [740, 760], [800, 760]]); })()`);
    const aStroke = await E<string>(`__t.hash('Shared')`);
    const overlapColor = `__t.hash('Shared', 720, 760, 1, 1)`;
    const aColor = await E<string>(overlapColor);
    await waitUntil(b, async (expected) => await (window as any).__t.hash('Shared') === expected, aStroke);
    await b.evaluate(`(async () => { __t.tool('筆刷'); await __t.wait(200); await __t.drag([[720, 700], [720, 740], [720, 780], [720, 820]]); })()`);
    const bStroke = await b.evaluate(`__t.hash('Shared')`);
    await waitUntil(a, async (expected) => await (window as any).__t.hash('Shared') === expected, bStroke);
    const aOnly = `__t.opaque('Shared', 670, 760, 1, 1)`;
    const overlap = `__t.opaque('Shared', 720, 760, 1, 1)`;
    const bOnly = `__t.opaque('Shared', 720, 800, 1, 1)`;
    const beforeUndo = await E<number[]>(`Promise.all([${aOnly}, ${overlap}, ${bOnly}])`);
    const bColor = await E<string>(overlapColor);
    await E(`__t.undo()`);
    const afterUndo = await E<number[]>(`Promise.all([${aOnly}, ${overlap}, ${bOnly}])`);
    const sharedHash = await E<string>(`__t.hash('Shared')`);
    await waitUntil(b, async (expected) => await (window as any).__t.hash('Shared') === expected, sharedHash);
    check('同色交疊筆劃復原後保留另一位畫師的像素', aStroke !== bStroke && beforeUndo.every((n) => n === 1)
      && aColor === bColor && await E<string>(overlapColor) === bColor
      && afterUndo.join(',') === '0,1,1', `${beforeUndo.join(',')} → ${afterUndo.join(',')}`);

    const mobileLayer = `手機測試 ${run}`;
    const { layer: mobileModel } = await api(A.token, 'POST', url, { name: mobileLayer });
    const mobile = await open(browser, A.token, canvas.id, BASE, true);
    const rail = mobile.getByRole('button', { name: '圓盤快捷選單', exact: true });
    const wheel = mobile.locator('.atelier-wheel-spin');
    const erase = wheel.getByRole('button', { name: '橡皮擦', exact: true });
    await rail.tap();
    await erase.waitFor({ state: 'visible' });
    check('手機尺寸可開啟圓盤', await wheel.isVisible());
    await erase.tap();
    await wheel.waitFor({ state: 'hidden' });
    await rail.tap();
    await wheel.getByRole('button', { name: '畫筆', exact: true }).tap();
    await mobile.getByRole('button', { name: '圖層', exact: true }).tap();
    const panels = mobile.getByRole('dialog', { name: '圖層', exact: true });
    check('手機圖層面板僅開啟一份', await panels.count() === 1);
    await panels.locator(`[data-layer-id="${mobileModel.id}"]`).tap();
    await panels.getByRole('button', { name: '關閉', exact: true }).tap();

    const viewport = mobile.locator('.atelier-canvas-viewport');
    await viewport.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 190, clientY: 360 });
    await wheel.waitFor({ state: 'visible' });
    check('畫布右鍵可開啟圓盤', await wheel.isVisible());
    await wheel.getByRole('button', { name: '翻轉', exact: true }).tap();

    const touch = await mobile.context().newCDPSession(mobile);
    const tapFingers = async (count: number, hold = 0) => {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: Array.from({ length: count }, (_, i) => ({ x: 160 + i * 25, y: 360, id: i + 1 })),
      });
      if (hold) await mobile.waitForTimeout(hold);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await tapFingers(1, 650);
    await wheel.waitFor({ state: 'visible' });
    check('手機長按畫布可開啟圓盤', await wheel.isVisible());
    await wheel.getByRole('button', { name: '翻轉', exact: true }).tap();
    await mobile.evaluate(`__t.drag([[370, 550], [420, 550], [470, 550], [520, 550]])`);
    const mobileHash = () => mobile.evaluate(`__t.hash(${JSON.stringify(mobileLayer)})`);
    const drawn = await mobileHash();
    check('手機畫布可作畫', (await mobile.evaluate(`__t.opaque(${JSON.stringify(mobileLayer)})`) as number) > 0);
    await tapFingers(2);
    await mobile.waitForTimeout(800);
    check('雙指輕點復原', (await mobile.evaluate(`__t.opaque(${JSON.stringify(mobileLayer)})`)) === 0);
    await tapFingers(3);
    await mobile.waitForTimeout(800);
    check('三指輕點重做', (await mobileHash()) === drawn);
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n❌ ${failures} 項工具檢查失敗` : '\n✅ 工具回歸測試全部通過');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ tools test failed:', err);
  process.exit(1);
});

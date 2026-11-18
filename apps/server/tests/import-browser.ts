/**
 * 匯入圖片 in a real (headless) Chrome: images dropped on the canvas, on the layer list (above /
 * below a row, inside a group, under every row), several at once, too big, not an image, and
 * 檔案 → 匯入圖片…; undo (Ctrl+Z) / redo (Ctrl+Shift+Z, Ctrl+Y) of an import and of the transform
 * after it; the second painter sees the same pixels.
 *
 *   PORT=3105 DATA_DIR=<throwaway> node dist/server.js        (after building the client)
 *   npx tsx tests/import-browser.ts http://127.0.0.1:3105
 *
 * Creates its own accounts and canvas: point it at a throwaway server only.
 */
import { chromium, type Page } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3105';
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

const HELPERS = `
window.__t = {
  d: () => window.__debugPixi,
  models: () => window.__debugPixi.layerManager.getLayers().map((l) => l.model),
  item: (name) => window.__debugPixi.layerManager.getLayers().find((l) => l.model.name === name),
  count: (name) => window.__debugPixi.layerManager.getLayers().filter((l) => l.model.name === name).length,
  async opaque(name, x = 0, y = 0, w = ${SIZE}, h = ${SIZE}) {
    const it = window.__t.item(name); if (!it) return -1;
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x, y, w, h }]);
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++; return n;
  },
  async bbox(name) {
    const it = window.__t.item(name); if (!it) return null;
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x: 0, y: 0, w: ${SIZE}, h: ${SIZE} }]);
    let x0 = ${SIZE}, y0 = ${SIZE}, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < ${SIZE}; y++) for (let x = 0; x < ${SIZE}; x++) if (px[(y * ${SIZE} + x) * 4 + 3]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n } : { n: 0 };
  },
  /** A solid w×h block at (x, y), give or take a pixel (screen ↔ canvas rounding) */
  async at(name, x, y, w, h) { const b = await window.__t.bbox(name); return Boolean(b && b.n && Math.abs(b.x - x) <= 1 && Math.abs(b.y - y) <= 1 && Math.abs(b.w - w) <= 1 && Math.abs(b.h - h) <= 1 && b.n >= (w - 1) * (h - 1)); },
  async pixel(name, x, y) {
    const it = window.__t.item(name); if (!it) return null;
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x, y, w: 1, h: 1 }]);
    return Array.from(px);
  },
  async hash(name) {
    const it = window.__t.item(name); if (!it) return 'missing';
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x: 0, y: 0, w: ${SIZE}, h: ${SIZE} }]);
    let hash = 2166136261; for (const byte of px) { hash ^= byte; hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16);
  },
  pt(x, y) { const d = window.__debugPixi; const p = d.viewport.canvasToScreen(x, y); const r = d.app.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  key(key, opts = {}) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true, ...opts })); },
  async file(name, w, h, color, type = 'image/png') {
    if (type === 'text/plain') return new File(['hello'], name, { type });
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, type));
    return new File([blob], name, { type });
  },
  /** dragenter → dragover → drop on el at a screen point; returns whether the drop was taken (preventDefault) */
  async drop(el, specs, clientX, clientY, stopBefore) {
    const dt = new DataTransfer();
    for (const s of specs) dt.items.add(await window.__t.file(...s));
    let taken = false;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      if (type === stopBefore) break;
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY });
      el.dispatchEvent(ev);
      if (type === 'drop') taken = ev.defaultPrevented;
    }
    return taken;
  },
  async dropCanvas(specs, x, y, stopBefore) {
    const p = window.__t.pt(x, y);
    return window.__t.drop(document.querySelector('.atelier-canvas-viewport'), specs, p.x, p.y, stopBefore);
  },
  async dropRow(specs, id, where) {
    const row = document.querySelector('[data-layer-id="' + id + '"]');
    const r = row.getBoundingClientRect();
    const y = where === 'above' ? r.top + r.height * 0.12 : where === 'below' ? r.bottom - r.height * 0.12 : r.top + r.height / 2;
    return window.__t.drop(row, specs, r.left + 40, y);
  },
  async dropListEnd(specs) {
    const list = document.querySelector('[aria-label="圖層清單"]');
    const r = list.getBoundingClientRect();
    return window.__t.drop(list, specs, r.left + 40, r.bottom - 3);
  },
  transforming: () => Boolean(document.querySelector('img[alt="transform-preview"]')),
  /** Names from the top of the stack down */
  order: () => window.__t.models().filter((m) => m.layerType !== 'mask').sort((a, b) => b.sortOrder - a.sortOrder).map((m) => m.name),
};`;

async function open(browser: any, token: string, canvasId: string, base = BASE): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(([t, c]: string[]) => {
    localStorage.setItem('atelier_token', t);
    localStorage.setItem('atelier_gateway_resolved', '1');
    localStorage.setItem('atelier_active_canvas_id', c);
  }, [token, canvasId]);
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => console.log('pageerror:', e.message));
  page.on('dialog', (d) => { console.log('dialog:', d.message()); void d.dismiss(); });
  await page.goto(base);
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 3, null, { timeout: 30000 });
  await page.addScriptTag({ content: HELPERS });
  await page.waitForTimeout(1500);
  return page;
}

async function waitUntil(page: Page, fn: string, timeout = 15000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function main() {
  if (!CHROME) throw new Error('Chrome not found');
  const run = Date.now().toString(36).slice(-5);
  const A = await api(null, 'POST', '/api/auth/register', { username: `ia_${run}`, password: 'password123', displayName: 'A' });
  const B = await api(null, 'POST', '/api/auth/register', { username: `ib_${run}`, password: 'password123', displayName: 'B' });
  const { canvas } = await api(A.token, 'POST', '/api/canvases', { title: `import ${run}`, width: SIZE, height: SIZE });
  await api(B.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
  const url = `/api/canvases/${canvas.id}/layers`;
  const made = async (body: object) => { const r = await api(A.token, 'POST', url, body); return r.layer ?? r; };
  await made({ name: 'L1' });
  const l2 = await made({ name: 'L2' });
  const group = await made({ name: 'G1', layerType: 'group' });
  await made({ name: 'G1child', parentId: group.id, aboveLayerId: l2.id });
  await api(B.token, 'POST', url, { name: 'B1' });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
  try {
    const a = await open(browser, A.token, canvas.id);
    const second = new URL(BASE);
    second.hostname = second.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
    const b = await open(browser, B.token, canvas.id, second.origin);
    const E = <T>(fn: string) => a.evaluate(fn) as Promise<T>;
    const sameOnB = async (name: string) => {
      const want = await E<string>(`__t.hash('${name}')`);
      return waitUntil(b, `(async () => (await __t.hash('${name}')) === ${JSON.stringify(want)})()`, 15000);
    };
    const orderText = async () => (await E<string[]>(`__t.order()`)).join(' > ');
    // The server's layer list (groups included), top of the stack first
    const server = async () => {
      const { layers } = await api(A.token, 'GET', url);
      return (layers as any[]).filter((l) => l.layerType !== 'mask').sort((x, y) => y.sortOrder - x.sortOrder);
    };
    const serverOrder = async () => (await server()).map((l) => l.name);
    const idOf = async (name: string) => (await server()).find((l) => l.name === name)?.id as string;
    const bbox = (name: string) => E<any>(`__t.bbox('${name}')`).then((b) => JSON.stringify(b));
    console.log('起始圖層：', (await serverOrder()).join(' > '));

    // ---- Drop overlay
    await E(`__t.dropCanvas([['x.png', 10, 10, '#000']], 500, 500, 'drop')`);
    const overlay = await E<boolean>(`document.body.innerText.includes('放開以新增圖層')`);
    await E(`document.querySelector('.atelier-canvas-viewport').parentElement.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null }))`);
    await a.waitForTimeout(100);
    const overlayGone = !(await E<boolean>(`document.body.innerText.includes('放開以新增圖層')`));
    check('拖到畫布上時出現提示框，離開後消失', overlay && overlayGone);

    // ---- Canvas drop: one image, centred on the drop point, new layer of its own, transform box
    await E(`(async () => { [...document.querySelectorAll('[data-layer-id]')].find((r) => r.querySelector('[title^="L2（"]'))?.click(); await __t.wait(400); })()`);
    const taken = await E<boolean>(`__t.dropCanvas([['red-box.png', 300, 200, '#ff0000']], 600, 400)`);
    const made = await waitUntil(a, `__t.count('red-box') === 1`);
    const boxShown = await waitUntil(a, `__t.transforming()`, 8000);
    check('拖到畫布：建立「red-box」新圖層並出現變形框', taken && made && boxShown);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    const redAt = await E<boolean>(`__t.at('red-box', 450, 300, 300, 200)`);
    const redColor = await E<number[]>(`__t.pixel('red-box', 600, 400)`);
    check('圖片以放開處為中心、原尺寸、Esc 後仍保留', redAt && redColor?.join() === '255,0,0,255', `${await bbox('red-box')}, ${redColor}`);
    let order = await E<string[]>(`__t.order()`);
    check('新圖層在目前圖層（L2）正上方', order.indexOf('red-box') === order.indexOf('L2') - 1, order.join(' > '));
    const redOwner = await E<boolean>(`__t.item('red-box').model.ownerId === ${JSON.stringify(A.user.id)}`);
    check('匯入的圖層屬於匯入的畫師', redOwner);
    check('另一位畫師看到一樣的像素', await sameOnB('red-box'));

    // ---- Undo / redo of the import
    await E(`__t.key('z', { ctrlKey: true })`);
    const undone = await waitUntil(a, `__t.count('red-box') === 0`);
    const undoneB = await waitUntil(b, `__t.count('red-box') === 0`);
    check('Ctrl+Z：整張匯入的圖層被拿掉（兩邊都是）', undone && undoneB);
    await E(`__t.key('Z', { ctrlKey: true, shiftKey: true })`);
    const redone = await waitUntil(a, `(async () => __t.count('red-box') === 1 && (await __t.at('red-box', 450, 300, 300, 200)))()`);
    check('Ctrl+Shift+Z：圖層帶著圖片回來', redone, await bbox('red-box'));
    check('重做後另一位畫師也看到圖片', await sameOnB('red-box'));
    await a.waitForTimeout(600);
    order = await E<string[]>(`__t.order()`);
    check('重做後回到原來的位置', order.indexOf('red-box') === order.indexOf('L2') - 1, order.join(' > '));
    await E(`__t.key('z', { ctrlKey: true })`);
    await waitUntil(a, `__t.count('red-box') === 0`);
    await E(`__t.key('y', { ctrlKey: true })`);
    check('Ctrl+Z 後 Ctrl+Y 也能重做', await waitUntil(a, `(async () => (await __t.opaque('red-box')) === 60000)()`));

    // ---- The transform after an import is its own undo step
    await E(`__t.dropCanvas([['blue.png', 200, 200, '#0000ff']], 300, 300)`);
    await waitUntil(a, `__t.count('blue') === 1 && __t.transforming()`);
    const surface = a.getByAltText('transform-preview').locator('..');
    const box = await surface.boundingBox();
    const delta = await E<{ x: number; y: number }>(`(() => { const p = __t.pt(0, 0), q = __t.pt(0, 150); return { x: q.x - p.x, y: q.y - p.y }; })()`);
    if (box) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await a.mouse.move(x, y);
      await a.mouse.down();
      await a.mouse.move(x + delta.x, y + delta.y, { steps: 8 });
      await a.mouse.up();
    }
    await E(`__t.key('Enter')`);
    await waitUntil(a, `!__t.transforming()`);
    const moved = await waitUntil(a, `__t.at('blue', 200, 350, 200, 200)`);
    check('匯入後直接拖動變形框，Enter 套用', moved, await bbox('blue'));
    await a.waitForTimeout(800);
    await E(`__t.key('z', { ctrlKey: true })`);
    const backToDrop = await waitUntil(a, `__t.at('blue', 200, 200, 200, 200)`);
    check('第一次 Ctrl+Z：只復原變形（圖片回到放開的位置）', backToDrop, await bbox('blue'));
    await E(`__t.key('z', { ctrlKey: true })`);
    check('第二次 Ctrl+Z：圖層移除', await waitUntil(a, `__t.count('blue') === 0`));
    await E(`__t.key('Z', { ctrlKey: true, shiftKey: true })`);
    const r1 = await waitUntil(a, `__t.at('blue', 200, 200, 200, 200)`);
    await a.waitForTimeout(600);
    await E(`__t.key('Z', { ctrlKey: true, shiftKey: true })`);
    const r2 = await waitUntil(a, `__t.at('blue', 200, 350, 200, 200)`);
    check('Ctrl+Shift+Z 兩次：圖層回來、變形也回來', r1 && r2, await bbox('blue'));
    check('另一位畫師看到變形後的圖片', await sameOnB('blue'));

    // ---- Layer list drops
    const l1 = await idOf('L1');
    await E(`__t.dropRow([['above-L1.png', 64, 64, '#00ff00']], '${l1}', 'above')`);
    await waitUntil(a, `__t.count('above-L1') === 1 && __t.transforming()`);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    order = await serverOrder();
    check('拖到圖層列上半：放在該圖層上方', order.indexOf('above-L1') === order.indexOf('L1') - 1, order.join(' > '));
    const centred = await E<number>(`__t.opaque('above-L1')`);
    check('拖到圖層清單：圖片放在畫面中央、原尺寸', centred === 4096, `${centred} px`);

    await E(`__t.dropRow([['below-L1.png', 64, 64, '#00ffff']], '${l1}', 'below')`);
    await waitUntil(a, `__t.count('below-L1') === 1 && __t.transforming()`);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    order = await serverOrder();
    check('拖到圖層列下半：放在該圖層下方', order.indexOf('below-L1') === order.indexOf('L1') + 1, order.join(' > '));

    const g1 = await idOf('G1');
    await E(`__t.dropRow([['in-G1.png', 64, 64, '#ff00ff']], '${g1}', 'inside')`);
    await waitUntil(a, `__t.count('in-G1') === 1 && __t.transforming()`);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    const list = await server();
    const inG1 = list.find((l) => l.name === 'in-G1');
    order = list.map((l) => l.name);
    check('拖到圖層組中間：放進組裡最上面', inG1?.parentId === g1 && order.indexOf('in-G1') === order.indexOf('G1') + 1, order.join(' > '));

    await E(`__t.dropRow([['above-G1.png', 64, 64, '#ff8800']], '${g1}', 'above')`);
    await waitUntil(a, `__t.count('above-G1') === 1 && __t.transforming()`);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    const aboveG1 = (await server()).find((l) => l.name === 'above-G1');
    order = await serverOrder();
    check('拖到圖層組上緣：放在組外、組的上方', !aboveG1?.parentId && order.indexOf('above-G1') === order.indexOf('G1') - 1, order.join(' > '));

    await E(`__t.dropListEnd([['bottom.png', 64, 64, '#888888']])`);
    await waitUntil(a, `__t.count('bottom') === 1 && __t.transforming()`);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    await a.waitForTimeout(800);
    const listB = await server();
    order = listB.map((l) => l.name);
    check('拖到清單下方空白處：放在最底層', order[order.length - 1] === 'bottom' && !listB[listB.length - 1].parentId, order.join(' > '));
    await E(`__t.key('z', { ctrlKey: true })`);
    check('清單拖入的圖層也能 Ctrl+Z', await waitUntil(a, `__t.count('bottom') === 0`));
    await E(`__t.key('Z', { ctrlKey: true, shiftKey: true })`);
    await waitUntil(a, `__t.count('bottom') === 1`);
    await a.waitForTimeout(800);
    order = await serverOrder();
    check('重做後仍在最底層', order[order.length - 1] === 'bottom', order.join(' > '));

    // ---- Several at once: one layer each, stacked in drop order, no transform box
    await E(`__t.dropCanvas([['m1.png', 50, 50, '#111111'], ['m2.png', 60, 60, '#222222']], 800, 800)`);
    const both = await waitUntil(a, `__t.count('m1') === 1 && __t.count('m2') === 1`);
    await a.waitForTimeout(800);
    order = await serverOrder();
    const noBox = !(await E<boolean>(`__t.transforming()`));
    check('一次拖兩張：各成一層、後面的在上面、不出現變形框', both && order.indexOf('m2') === order.indexOf('m1') - 1 && noBox, order.join(' > '));

    // ---- Too big: scaled down to fit
    await E(`__t.dropCanvas([['wide.png', 2048, 1024, '#ffaa00']], 512, 512)`);
    await waitUntil(a, `__t.count('wide') === 1 && __t.transforming()`);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    const widePx = await E<number>(`__t.opaque('wide')`);
    check('比畫布大的圖等比縮到畫布內（2048×1024 → 1024×512）', widePx === 1024 * 512, `${widePx} px`);

    // ---- Not an image
    const before = await E<number>(`__t.models().length`);
    await E(`__t.dropCanvas([['notes.txt', 0, 0, '', 'text/plain']], 500, 500)`);
    await a.waitForTimeout(800);
    const warned = await E<boolean>(`document.body.innerText.includes('只能匯入圖片檔')`);
    check('拖入非圖片檔：不建立圖層並提示', warned && (await E<number>(`__t.models().length`)) === before);

    // ---- A file dropped outside any target: the browser does not open it
    const outside = await E<boolean>(`(async () => {
      const dt = new DataTransfer(); dt.items.add(await __t.file('o.png', 8, 8, '#000'));
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      document.querySelector('header').dispatchEvent(ev);
      const ev2 = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      document.querySelector('header').dispatchEvent(ev2);
      return ev.defaultPrevented && ev2.defaultPrevented && dt.dropEffect === 'none';
    })()`);
    check('拖到其他地方放開：瀏覽器不會打開圖片離開畫布', outside && a.url().startsWith(BASE));

    // ---- 檔案 → 匯入圖片…
    const pngB64 = await E<string>(`(async () => { const f = await __t.file('menu.png', 120, 80, '#00aa00'); const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); })()`);
    await a.getByRole('button', { name: /^檔案/ }).first().click();
    const chooserP = a.waitForEvent('filechooser');
    await a.getByRole('menuitem', { name: '匯入圖片…' }).click();
    const chooser = await chooserP;
    await chooser.setFiles({ name: 'from-menu.png', mimeType: 'image/png', buffer: Buffer.from(pngB64, 'base64') });
    const viaMenu = await waitUntil(a, `__t.count('from-menu') === 1 && __t.transforming()`);
    await E(`__t.key('Escape')`);
    await waitUntil(a, `!__t.transforming()`);
    check('檔案 → 匯入圖片…：建立新圖層', viaMenu && (await E<number>(`__t.opaque('from-menu')`)) === 9600);

    // ---- The other painter's view of the whole thing
    await a.waitForTimeout(1500);
    const namesA = await orderText();
    const namesB = (await b.evaluate(`__t.order()`) as string[]).join(' > ');
    check('兩位畫師的圖層順序一致', namesA === namesB, namesA === namesB ? namesA : `A: ${namesA} | B: ${namesB}`);
    for (const n of ['above-L1', 'in-G1', 'm2', 'wide', 'from-menu']) check(`B 看到「${n}」的像素一致`, await sameOnB(n));

    // ---- After a reload everything is still there
    await a.reload();
    await a.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 3, null, { timeout: 30000 });
    await a.addScriptTag({ content: HELPERS });
    await a.waitForTimeout(2500);
    const afterReload = await waitUntil(a, `(async () => (await __t.at('red-box', 450, 300, 300, 200)) && (await __t.opaque('wide')) === ${1024 * 512})()`, 20000);
    check('重新整理後匯入的圖都還在', afterReload);
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

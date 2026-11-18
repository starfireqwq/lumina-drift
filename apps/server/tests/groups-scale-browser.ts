/**
 * Groups / animation folders and 介面縮放 in a real (headless) Chrome:
 *  - an animation folder lists its cels below it (new folders, and old canvases put in order on load)
 *  - deleting a group / animation folder deletes what is inside it (another painter's cel stays,
 *    moved out); Ctrl+Z brings the whole tree back with its pixels and order, redo deletes it again;
 *    a repeated cel points at the restored cel again
 *  - 新增圖層 / 新增圖層組 can be undone (a group with layers put in it: only the group goes)
 *  - 介面縮放 150 %: root font size, dock width, strokes still land where the cursor is
 *
 *   PORT=3105 DATA_DIR=<throwaway> node dist/server.js        (after building the client)
 *   npx tsx tests/groups-scale-browser.ts http://127.0.0.1:3105 <throwaway>/atelier.db [shots dir]
 *
 * Creates its own accounts and canvas and edits that throwaway database: never point it at real data.
 */
import { chromium, type Page } from 'playwright-core';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3105';
const DB_PATH = process.argv[3];
const SHOTS = process.argv[4];
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
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

type L = { id: string; name: string; parentId: string | null; sortOrder: number; layerType: string; meta?: any; ownerId?: string; createdAt?: number };
/** Top first, as the panel lists them, indented by depth */
const tree = (ls: L[]) => {
  const byId = new Map(ls.map((l) => [l.id, l]));
  return ls
    .filter((l) => l.layerType !== 'mask')
    .sort((a, b) => b.sortOrder - a.sortOrder)
    .map((l) => {
      let d = 0;
      for (let p = l.parentId ? byId.get(l.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) d++;
      return `${'  '.repeat(d)}${l.name}`;
    });
};
/** Every group sits right above its content */
const contiguous = (ls: L[]) => {
  const desc = ls.filter((l) => l.layerType !== 'mask').sort((a, b) => b.sortOrder - a.sortOrder);
  const byId = new Map(desc.map((l) => [l.id, l]));
  const within = (l: L, g: string) => { for (let p = l.parentId; p; p = byId.get(p)?.parentId ?? null) if (p === g) return true; return false; };
  for (const g of desc.filter((l) => l.layerType === 'group')) {
    const i = desc.indexOf(g);
    const n = desc.filter((l) => within(l, g.id)).length;
    for (let k = 1; k <= n; k++) if (!desc[i + k] || !within(desc[i + k], g.id)) return false;
  }
  return true;
};

const rawTile = (col: number, row: number, rgba: [number, number, number, number], w = 256, h = 256) => {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) buf.set(rgba, i * 4);
  return { col, row, width: w, height: h, compression: 'raw', data: buf.toString('base64') };
};

const HELPERS = `
window.__t = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  key(key, opts = {}) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true, ...opts })); },
  item: (name) => window.__debugPixi.layerManager.getLayers().find((l) => l.model.name === name),
  async opaque(name) {
    const it = window.__t.item(name); if (!it) return -1;
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x: 0, y: 0, w: ${SIZE}, h: ${SIZE} }]);
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++; return n;
  },
  async bbox(name) {
    const it = window.__t.item(name); if (!it) return null;
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x: 0, y: 0, w: ${SIZE}, h: ${SIZE} }]);
    let x0 = ${SIZE}, y0 = ${SIZE}, x1 = -1, y1 = -1;
    for (let y = 0; y < ${SIZE}; y++) for (let x = 0; x < ${SIZE}; x++) if (px[(y * ${SIZE} + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  },
  row: (id) => document.querySelector('[data-layer-id="' + id + '"]'),
  rowIds: () => Array.from(document.querySelectorAll('[role="listbox"][aria-label="圖層清單"] [data-layer-id]')).map((e) => e.getAttribute('data-layer-id')),
  click(sel) { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) throw new Error('no ' + sel); el.click(); },
  async dragCanvas(pts) {
    const d = window.__debugPixi;
    const s = (x, y) => { const p = d.viewport.canvasToScreen(x, y); const r = d.app.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; };
    const el = document.querySelector('.atelier-canvas-viewport');
    const fire = (type, x, y, btns) => { const p = s(x, y); el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: btns, pressure: btns ? 0.8 : 0 })); };
    fire('pointerdown', pts[0][0], pts[0][1], 1);
    for (let i = 1; i < pts.length; i++) { fire('pointermove', pts[i][0], pts[i][1], 1); await new Promise((r) => setTimeout(r, 8)); }
    fire('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1], 0);
    await new Promise((r) => setTimeout(r, 400));
  },
};`;

async function open(browser: any, token: string, canvasId: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  await ctx.addInitScript(([t, c]: string[]) => {
    localStorage.setItem('atelier_token', t);
    localStorage.setItem('atelier_gateway_resolved', '1');
    localStorage.setItem('atelier_active_canvas_id', c);
  }, [token, canvasId]);
  const page: Page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE);
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 1, null, { timeout: 30000 });
  await page.evaluate(HELPERS);
  await page.waitForTimeout(800);
  return page;
}

async function main() {
  if (!DB_PATH) throw new Error('usage: groups-scale-browser.ts <base url> <throwaway atelier.db> [shots dir]');
  const run = Date.now().toString(36);
  const A = await api(null, 'POST', '/api/auth/register', { username: `ga_${run}`, password: 'password123', displayName: 'A' });
  const B = await api(null, 'POST', '/api/auth/register', { username: `gb_${run}`, password: 'password123', displayName: 'B' });
  const { canvas } = await api(A.token, 'POST', '/api/canvases', { title: `groups ${run}`, width: SIZE, height: SIZE });
  await api(B.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
  const url = `/api/canvases/${canvas.id}/layers`;
  const layers = async (): Promise<L[]> => (await api(A.token, 'GET', url)).layers;
  const make = async (token: string, body: any) => (await api(token, 'POST', url, body)).layer as L;
  const paint = async (id: string, col: number, row: number, rgba: [number, number, number, number]) => api(A.token, 'POST', `${url}/${id}/tiles`, { tiles: [rawTile(col, row, rgba)] });

  // ---------- 1. A new animation folder: cels below it (as the timeline makes them) ----------
  const base = await make(A.token, { name: '底圖' });
  const folder = await make(A.token, { name: '動畫 1', layerType: 'group', meta: { animation: { fps: 12 } } });
  const cel1 = await make(A.token, { name: '1', aboveLayerId: folder.id, parentId: folder.id });
  const cel2 = await make(A.token, { name: '2', aboveLayerId: cel1.id, parentId: folder.id });
  let ls = await layers();
  const t1 = tree(ls);
  check('animation folder lists its cels below it, newest on top', t1.indexOf('動畫 1') >= 0 && t1.indexOf('動畫 1') + 1 === t1.indexOf('  2') && t1.indexOf('  2') + 1 === t1.indexOf('  1'), t1.join(' / '));

  // ---------- 2. An old canvas (cels above the folder) is put in order on load ----------
  // (parent_id is ON DELETE SET NULL: a deleted group's layers never point at it, so no orphans to test)
  const db = new Database(DB_PATH);
  const so = (id: string) => (db.prepare('SELECT sort_order AS s FROM layers WHERE id = ?').get(id) as any).s as number;
  db.prepare('UPDATE layers SET sort_order = ? WHERE id = ?').run(so(folder.id) - 30, folder.id); // folder below its cels (the old bug)
  db.close();
  ls = await layers();
  const t2 = tree(ls);
  check('old canvas: folder put back above its cels on load', t2.indexOf('動畫 1') + 1 === t2.indexOf('  2') && contiguous(ls), t2.join(' / '));
  const orphan = await make(A.token, { name: '孤兒' });

  // ---------- 3. A group tree with pixels; B adds a cel to A's shared folder; a repeated cel ----------
  await api(A.token, 'PATCH', `${url}/${folder.id}`, { meta: { animation: { fps: 12, shared: true } } });
  const bCel = await make(B.token, { name: 'B的格', aboveLayerId: cel2.id, parentId: folder.id });
  await make(A.token, { name: '↻ 1', layerType: 'group', aboveLayerId: bCel.id, parentId: folder.id, meta: { cel: { ref: cel1.id } } });
  await paint(cel1.id, 0, 0, [255, 0, 0, 255]);
  await paint(cel2.id, 1, 0, [0, 255, 0, 255]);
  const G = await make(A.token, { name: '組', layerType: 'group', aboveLayerId: orphan.id });
  const r1 = await make(A.token, { name: 'r1', aboveLayerId: G.id, parentId: G.id });
  const G2 = await make(A.token, { name: '子組', layerType: 'group', aboveLayerId: r1.id, parentId: G.id });
  const r3 = await make(A.token, { name: 'r3', aboveLayerId: G2.id, parentId: G2.id });
  const r2 = await make(A.token, { name: 'r2', aboveLayerId: G2.id, parentId: G.id });
  await paint(r1.id, 0, 1, [0, 0, 255, 255]);
  await paint(r2.id, 1, 1, [255, 255, 0, 255]);
  await paint(r3.id, 2, 2, [255, 0, 255, 255]);
  ls = await layers();
  const before = tree(ls);
  check('tree is contiguous before the tests', contiguous(ls), before.join(' / '));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
  const page = await open(browser, A.token, canvas.id);
  const shot = async (name: string, clip?: { x: number; y: number; width: number; height: number }) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip });
  };
  const panelIds = () => page.evaluate(() => (window as any).__t.rowIds() as string[]);
  const t3 = await panelIds();
  check('layer panel: folder row right above its cels', t3.indexOf(folder.id) >= 0 && t3.indexOf(folder.id) < t3.indexOf(cel2.id) && t3.indexOf(cel2.id) < t3.indexOf(cel1.id));
  await shot('01-panel');
  const opaque = (name: string) => page.evaluate((n) => (window as any).__t.opaque(n), name);
  const px0 = { r1: await opaque('r1'), r2: await opaque('r2'), r3: await opaque('r3') };
  check('pixels loaded', px0.r1 === 65536 && px0.r2 === 65536 && px0.r3 === 65536, JSON.stringify(px0));

  const select = (id: string) => page.evaluate((i) => (window as any).__t.row(i).click(), id);
  const del = () => page.evaluate(() => (window as any).__t.click('button[aria-label="刪除目前圖層"]'));
  const undo = () => page.evaluate(() => (window as any).__t.key('z', { ctrlKey: true }));
  const redo = () => page.evaluate(() => (window as any).__t.key('z', { ctrlKey: true, shiftKey: true }));
  const settle = async (pred: (ls: L[]) => boolean, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const l = await layers();
      if (pred(l)) return l;
      await page.waitForTimeout(250);
    }
    return layers();
  };
  const names = (l: L[]) => new Set(l.map((x) => x.name));
  const groupNames = ['組', 'r1', 'r2', '子組', 'r3'];

  // ---------- 4. Delete a group: everything inside goes; Ctrl+Z brings the whole tree back ----------
  await select(G.id);
  await page.waitForTimeout(300);
  await del();
  ls = await settle((l) => !names(l).has('組'));
  check('deleting a group deletes its content (nested group too)', groupNames.every((n) => !names(ls).has(n)), tree(ls).join(' / '));
  await page.waitForTimeout(500);
  await undo();
  ls = await settle((l) => groupNames.every((n) => names(l).has(n)) && contiguous(l) && JSON.stringify(tree(l)) === JSON.stringify(before));
  const after = tree(ls);
  check('Ctrl+Z restores the group with its layers, nesting and order', JSON.stringify(after) === JSON.stringify(before), after.join(' / '));
  await page.waitForTimeout(1500);
  const px1 = { r1: await opaque('r1'), r2: await opaque('r2'), r3: await opaque('r3') };
  check('Ctrl+Z restores the pixels of every layer inside', JSON.stringify(px1) === JSON.stringify(px0), JSON.stringify(px1));
  await redo();
  ls = await settle((l) => !names(l).has('組'));
  check('redo deletes the group and its content again', groupNames.every((n) => !names(ls).has(n)));
  await page.waitForTimeout(500);
  await undo();
  ls = await settle((l) => groupNames.every((n) => names(l).has(n)) && contiguous(l) && JSON.stringify(tree(l)) === JSON.stringify(before));
  check('undo after redo brings it all back again', JSON.stringify(tree(ls)) === JSON.stringify(before), tree(ls).join(' / '));

  // ---------- 5. Delete the shared animation folder: B's cel stays (moved out), undo restores A's part ----------
  const folderNow = ls.find((l) => l.name === '動畫 1')!;
  await select(folderNow.id);
  await page.waitForTimeout(300);
  await del();
  ls = await settle((l) => !names(l).has('動畫 1'));
  const bLeft = ls.find((l) => l.id === bCel.id);
  check('deleting an animation folder deletes its cels', !names(ls).has('1') && !names(ls).has('2') && !names(ls).has('↻ 1'), tree(ls).join(' / '));
  check("another painter's cel stays, moved out of the folder", Boolean(bLeft) && bLeft!.parentId === null);
  const toast = await page.evaluate(() => document.body.innerText.includes('別人的'));
  check('a message says their layer was kept', toast);
  await page.waitForTimeout(500);
  await undo();
  ls = await settle((l) => ['動畫 1', '1', '2', '↻ 1'].every((n) => names(l).has(n)) && contiguous(l));
  await page.waitForTimeout(1000);
  ls = await layers();
  const f2 = ls.find((l) => l.name === '動畫 1')!;
  const c1 = ls.find((l) => l.name === '1')!;
  const rep = ls.find((l) => l.name === '↻ 1')!;
  const t5 = tree(ls);
  check('Ctrl+Z restores the folder with its cels below it, in order', Boolean(f2) && t5.indexOf('動畫 1') + 1 === t5.indexOf('  ↻ 1') && t5.indexOf('  ↻ 1') + 1 === t5.indexOf('  2') && t5.indexOf('  2') + 1 === t5.indexOf('  1') && Boolean(f2.meta?.animation), t5.join(' / '));
  check("Ctrl+Z leaves the other painter's cel where it went (still theirs)", ls.find((l) => l.id === bCel.id)?.parentId === null && ls.find((l) => l.id === bCel.id)?.ownerId === B.user.id);
  check('the repeated cel points at the restored cel', rep?.meta?.cel?.ref === c1?.id, `${rep?.meta?.cel?.ref} vs ${c1?.id}`);
  await page.waitForTimeout(1000);
  check('cel pixels restored', (await opaque('1')) === 65536 && (await opaque('2')) === 65536);
  await redo();
  ls = await settle((l) => !names(l).has('動畫 1'));
  await page.waitForTimeout(500);
  await undo();
  ls = await settle((l) => ['動畫 1', '1', '2', '↻ 1'].every((n) => names(l).has(n)) && contiguous(l));
  await page.waitForTimeout(1000);
  ls = await layers();
  check('after redo + undo the repeated cel still points at the cel', ls.find((l) => l.name === '↻ 1')?.meta?.cel?.ref === ls.find((l) => l.name === '1')?.id);

  // ---------- 6. 新增圖層 / 新增圖層組 can be undone ----------
  const count = async () => (await layers()).length;
  let n0 = await count();
  await page.evaluate(() => (window as any).__t.click('button[aria-label="新增點陣圖層"]'));
  await settle((l) => l.length === n0 + 1);
  check('新增點陣圖層 adds a layer', (await count()) === n0 + 1);
  await page.waitForTimeout(400);
  await undo();
  await settle((l) => l.length === n0);
  check('Ctrl+Z removes the new layer', (await count()) === n0);
  await redo();
  await settle((l) => l.length === n0 + 1);
  check('redo brings the new layer back', (await count()) === n0 + 1);
  n0 = await count();
  await page.evaluate(() => (window as any).__t.click('button[aria-label="新增圖層組"]'));
  ls = await settle((l) => l.length === n0 + 1);
  const newGroup = ls.filter((l) => l.layerType === 'group').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  await api(A.token, 'PATCH', `${url}/${base.id}`, { parentId: newGroup.id }); // a layer put into the new group
  await page.waitForTimeout(600);
  await undo();
  ls = await settle((l) => !l.some((x) => x.id === newGroup.id));
  check('Ctrl+Z of a new group that got a layer: the group goes, the layer stays', !ls.some((x) => x.id === newGroup.id) && ls.find((x) => x.id === base.id)?.parentId === null);

  // ---------- 7. Up / down move a group with its content ----------
  ls = await layers();
  const gNow = ls.find((l) => l.name === '組')!;
  await select(gNow.id);
  await page.waitForTimeout(300);
  const t7a = tree(ls);
  await page.evaluate(() => (window as any).__t.click('button[aria-label="下移一層"]'));
  ls = await settle((l) => JSON.stringify(tree(l)) !== JSON.stringify(t7a));
  check('下移一層 moves the group past its sibling with all its content', contiguous(ls) && JSON.stringify(tree(ls)) !== JSON.stringify(t7a), tree(ls).join(' / '));

  // ---------- 8. 介面縮放 ----------
  /** The same stroke on a new layer: where its pixels land */
  const strokeBox = async () => {
    await page.evaluate(() => (window as any).__t.click('button[aria-label="新增點陣圖層"]'));
    await page.waitForTimeout(1200);
    const name = await page.evaluate(() => (window as any).__debugPixi.layerManager.getLayers().map((l: any) => l.model).filter((m: any) => m.layerType === 'raster').sort((a: any, b: any) => b.createdAt - a.createdAt)[0].name as string);
    await page.evaluate(() => (document.querySelector('nav[aria-label="工具"] button[aria-label^="筆刷"]') as HTMLElement | null)?.click());
    await page.evaluate(() => (window as any).__t.dragCanvas([[300, 300], [350, 300], [400, 300], [450, 300]]));
    return page.evaluate((n) => (window as any).__t.bbox(n), name);
  };
  const bb100 = await strokeBox();
  await shot('02-topbar', { x: 900, y: 0, width: 540, height: 48 });
  await page.evaluate(() => (window as any).__t.click('button[aria-label="設定"]'));
  await page.waitForSelector('input[aria-label="介面縮放百分比"]');
  await shot('03-settings-100');
  const dock100 = await page.evaluate(() => document.querySelector('[data-dock-side="right"]')!.getBoundingClientRect().width);
  const wheel100 = await page.evaluate(() => {
    const c = document.querySelector('[data-panel="color"] canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, bmpW: c.width, bmpH: c.height };
  });
  await page.fill('input[aria-label="介面縮放百分比"]', '150');
  await page.press('input[aria-label="介面縮放百分比"]', 'Enter');
  await page.waitForTimeout(500);
  const fs150 = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const dock150 = await page.evaluate(() => document.querySelector('[data-dock-side="right"]')!.getBoundingClientRect().width);
  const wheel150 = await page.evaluate(() => {
    const c = document.querySelector('[data-panel="color"] canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, bmpW: c.width, bmpH: c.height };
  });
  check('150 %: root font size 24px', fs150 === '24px', fs150);
  check('150 %: right dock 1.5× as wide', Math.abs(dock150 / dock100 - 1.5) < 0.05, `${dock100} → ${dock150}`);
  check(
    '150 %: color wheel scales 1.5× and stays square',
    Math.abs(wheel150.w / wheel100.w - 1.5) < 0.05 && Math.abs(wheel150.w - wheel150.h) <= 1 && wheel150.bmpW > wheel100.bmpW,
    `${wheel100.w}×${wheel100.h} (${wheel100.bmpW}) → ${wheel150.w}×${wheel150.h} (${wheel150.bmpW})`
  );
  await shot('04-settings-150');
  const persisted = await page.evaluate(() => localStorage.getItem('atelier_ui_scale'));
  check('the scale is remembered', persisted === '1.5', String(persisted));
  // A stroke still lands under the cursor
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const bb150 = await strokeBox();
  const same = bb100 && bb150 && ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(bb100[k] - bb150[k]) <= 2);
  check('the same stroke lands on the same pixels at 100 % and 150 %', Boolean(same), `${JSON.stringify(bb100)} vs ${JSON.stringify(bb150)}`);
  await shot('05-workspace-150');
  // Reload keeps it; the 100% button puts it back
  await page.reload();
  await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 1, null, { timeout: 30000 });
  check('after reload still 150 %', (await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)) === '24px');
  await page.evaluate(() => (document.querySelector('button[aria-label="設定"]') as HTMLElement).click());
  await page.waitForSelector('input[aria-label="介面縮放百分比"]');
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '100%')!.click());
  await page.waitForTimeout(400);
  check('100% button resets', (await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)) === '16px');

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

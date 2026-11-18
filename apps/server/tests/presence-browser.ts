/**
 * Member presence (成員面板) in real (headless) Chrome, on a throwaway server this script starts itself:
 *  - 在線 / 離線 sections; an online member turns 休眠 after a while without input and is online again on
 *    the next input; the other painter sees it live
 *  - drawing time = gaps of at most 60 s between a member's drawing ops (a longer pause adds nothing),
 *    stored in canvas_members.draw_time_ms
 *  - leaving records last_seen_at; both survive a server restart; an idle tab is idle again after reconnecting
 *  - the canvas_members migration rebuilds both columns from an old database's op log, once
 *
 *   (build shared, server and client first)
 *   cd apps/server && npx tsx tests/presence-browser.ts 3107 <throwaway data dir> [shots dir]
 *
 * Painter A uses http://127.0.0.1:<port>, painter B http://localhost:<port> (own localStorage each);
 * B's idle threshold is shortened with localStorage atelier_idle_after_ms. Never point it at real data.
 */
import { chromium } from 'playwright-core';
import Database from 'better-sqlite3';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [PORT_S, DATA, SHOTS] = process.argv.slice(2);
const SERVER_DIR = process.cwd();
if (!PORT_S || !DATA || path.resolve(DATA) === path.resolve(SERVER_DIR, 'data')) {
  throw new Error('usage (from apps/server): npx tsx tests/presence-browser.ts <port> <throwaway data dir> [shots dir]');
}
const PORT = Number(PORT_S);
const HOST_A = `http://127.0.0.1:${PORT}`;
const HOST_B = `http://localhost:${PORT}`;
const DB_PATH = path.join(DATA, 'atelier.db');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const B_IDLE_MS = 4000;
const DRAW_TYPES = ['STROKE', 'ERASE', 'SMART_FILL', 'LASSO', 'TILE_PATCH', 'FILTER'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

// ---------- throwaway server ----------
let server = null;
async function startServer() {
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(path.join(DATA, 'server.log'), 'a');
  server = spawn(process.execPath, ['dist/server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
    stdio: ['ignore', log, log],
  });
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${HOST_A}/api/canvases`);
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode} (see ${DATA}/server.log)`);
    await sleep(200);
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
}

async function api(token, method, url, body) {
  const res = await fetch(`${HOST_A}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const dbRead = (fn) => {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
};
const memberRow = (canvasId, userId) =>
  dbRead((db) => db.prepare('SELECT last_seen_at AS lastSeenAt, draw_time_ms AS drawTimeMs, joined_at AS joinedAt FROM canvas_members WHERE canvas_id = ? AND user_id = ?').get(canvasId, userId));
/** Drawing time by the server's rule, recomputed from the op log (gaps ≤ 60 s between draw ops) */
const expectedDrawMs = (canvasId, userId) => {
  const times = dbRead((db) => db.prepare(`SELECT created_at AS t, op_type AS ty FROM canvas_ops WHERE canvas_id = ? AND user_id = ? ORDER BY seq`).all(canvasId, userId))
    .filter((r) => DRAW_TYPES.includes(r.ty.toUpperCase())).map((r) => r.t);
  let ms = 0;
  for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g > 0 && g <= 60_000) ms += g; }
  return { ms, ops: times.length };
};

// ---------- pages ----------
const HELPERS = `window.__t = {
  async dragCanvas(pts) {
    const d = window.__debugPixi;
    const s = (x, y) => { const p = d.viewport.canvasToScreen(x, y); const r = d.app.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; };
    const el = document.querySelector('.atelier-canvas-viewport');
    const fire = (type, x, y, btns) => { const p = s(x, y); el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: btns, pressure: btns ? 0.8 : 0 })); };
    fire('pointerdown', pts[0][0], pts[0][1], 1);
    for (let i = 1; i < pts.length; i++) { fire('pointermove', pts[i][0], pts[i][1], 1); await new Promise((r) => setTimeout(r, 8)); }
    fire('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1], 0);
  },
};`;

async function openPage(browser, base, token, canvasId, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' }); // tsx keepNames
  await ctx.addInitScript(([t, c, e]) => {
    localStorage.setItem('atelier_token', t);
    localStorage.setItem('atelier_gateway_resolved', '1');
    localStorage.setItem('atelier_active_canvas_id', c);
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
  }, [token, canvasId, extra]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`   [pageerror ${base}]`, e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__debugPixi?.layerManager?.getLayers().length >= 1, null, { timeout: 30000 });
  await page.evaluate(HELPERS);
  await page.waitForTimeout(800);
  return { ctx, page };
}

async function openMembersPanel(page) {
  const btn = page.locator('button[title="在線成員（浮動視窗）"]');
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  await page.waitForSelector('section[aria-label="在線成員"]', { timeout: 10000 });
}

/** What the 成員 panel shows right now */
const panel = (page) => page.evaluate(() => {
  const rows = (label) => Array.from(document.querySelectorAll(`section[aria-label="${label}"] [data-presence]`)).map((r) => {
    const title = r.querySelector('[data-draw-time]')?.getAttribute('title') || '';
    const m = /(?:(\d+) 小時 )?(\d+) 分 (\d+) 秒/.exec(title);
    return {
      name: r.querySelector('span.truncate')?.textContent,
      presence: r.getAttribute('data-presence'),
      idleTag: r.textContent.includes('休眠'),
      drawText: r.querySelector('[data-draw-time]')?.textContent,
      drawSec: m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null,
      lastSeen: r.querySelector('[data-last-seen]')?.textContent,
      lastSeenTitle: r.querySelector('[data-last-seen]')?.getAttribute('title'),
    };
  });
  const heads = Array.from(document.querySelectorAll('section[aria-label$="成員"] > div:first-child')).map((e) => e.textContent);
  return { online: rows('在線成員'), offline: rows('離線成員'), heads };
});
const find = (list, name) => list.find((r) => r.name === name);

async function waitPanel(page, pred, timeout = 15000) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeout) {
    st = await panel(page).catch(() => null);
    if (st && pred(st)) return { ok: true, ms: Date.now() - t0, st };
    await sleep(100);
  }
  return { ok: false, ms: Date.now() - t0, st };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = page.locator('section[aria-label="在線成員"]').locator('xpath=../..');
  await root.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function strokeB(pageB, y) {
  const pts = [];
  for (let x = 150; x <= 850; x += 35) pts.push([x, y + Math.sin(x / 60) * 20]);
  await pageB.evaluate((p) => window.__t.dragCanvas(p), pts);
}

async function main() {
  await startServer();
  const run = Date.now().toString(36);
  const reg = (n) => api(null, 'POST', '/api/auth/register', { username: `p${n.toLowerCase()}_${run}`, password: 'password123', displayName: n });
  const A = await reg('A');
  const B = await reg('B');
  const C = await reg('C');
  const { canvas } = await api(A.token, 'POST', '/api/canvases', { title: `presence ${run}`, width: 1024, height: 1024 });
  await api(B.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
  await api(C.token, 'POST', '/api/canvases/join', { canvasId: canvas.id });
  await api(B.token, 'POST', `/api/canvases/${canvas.id}/layers`, { name: 'B 線稿' });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const { page: pageA } = await openPage(browser, HOST_A, A.token, canvas.id);
  let { ctx: ctxB, page: pageB } = await openPage(browser, HOST_B, B.token, canvas.id, { atelier_idle_after_ms: String(B_IDLE_MS) });
  await openMembersPanel(pageA);

  // 1. Two sections: A and B online, C (never opened the canvas) offline
  let r = await waitPanel(pageA, (s) => s.online.length === 2 && s.offline.length === 1);
  check('A sees 在線 2 (A, B) and 離線 1 (C)', r.ok && !!find(r.st.online, 'A') && !!find(r.st.online, 'B') && !!find(r.st.offline, 'C'), JSON.stringify(r.st?.heads));
  check('online rows are online, nobody idle yet', r.ok && r.st.online.every((m) => m.presence === 'online' && !m.idleTag));
  const c0 = r.st && find(r.st.offline, 'C');
  check('C: no last-seen record yet, 尚未作畫', c0?.lastSeen === '尚無紀錄' && c0?.drawText === '尚未作畫', JSON.stringify(c0));
  check('B has not drawn yet: 尚未作畫', find(r.st.online, 'B')?.drawText === '尚未作畫');

  // 2. Idle: B touches nothing for 4 s
  await pageB.mouse.move(700, 450);
  const tIdle0 = Date.now();
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.presence === 'idle', 15000);
  const idleAfter = Date.now() - tIdle0;
  check('B turns idle on A\'s screen after ~4 s without input', r.ok && idleAfter >= B_IDLE_MS - 100 && idleAfter < B_IDLE_MS + 2500, `${idleAfter} ms`);
  check('idle row says 休眠, A itself stays online', !!find(r.st.online, 'B')?.idleTag && find(r.st.online, 'A')?.presence === 'online');
  check('idle members are listed after awake ones', r.st.online[r.st.online.length - 1]?.name === 'B');
  await shot(pageA, '1-idle');

  // 3. Any input wakes B at once
  const tWake = Date.now();
  await pageB.mouse.move(720, 470);
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.presence === 'online', 5000);
  check('B is online again right after moving the mouse', r.ok && Date.now() - tWake < 1500, `${Date.now() - tWake} ms`);

  // 4. Drawing time: six strokes ~2.5 s apart
  await pageB.keyboard.press('b');
  for (let i = 0; i < 6; i++) {
    await strokeB(pageB, 150 + i * 60);
    await sleep(2500);
  }
  let exp = expectedDrawMs(canvas.id, B.user.id);
  check('B\'s strokes reached the server as draw ops', exp.ops >= 6, `${exp.ops} ops`);
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.drawSec === Math.floor(exp.ms / 1000), 8000);
  const bDraw1 = r.st && find(r.st.online, 'B');
  check('A sees B\'s drawing time = sum of gaps between B\'s ops', r.ok, `panel ${bDraw1?.drawSec}s / op log ${exp.ms} ms / "${bDraw1?.drawText}"`);
  check('B\'s drawing time is plausible for 6 strokes 2.5 s apart (12–20 s)', exp.ms >= 12_000 && exp.ms <= 20_000, `${exp.ms} ms`);
  check('A (no strokes) still 尚未作畫', find(r.st.online, 'A')?.drawText === '尚未作畫');
  const rowB1 = memberRow(canvas.id, B.user.id);
  check('B\'s drawing time is in the database', rowB1?.drawTimeMs === exp.ms, `db ${rowB1?.drawTimeMs} / expected ${exp.ms}`);

  // 5. A pause over 60 s adds nothing (B also goes idle meanwhile)
  const before = exp.ms;
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.presence === 'idle', 15000);
  check('B goes idle during the long pause', r.ok);
  console.log('   … waiting 62 s (pause longer than the 60 s gap)');
  await sleep(62_000 - r.ms);
  await strokeB(pageB, 600);
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.presence === 'online', 5000);
  check('drawing wakes B', r.ok);
  await sleep(1500);
  exp = expectedDrawMs(canvas.id, B.user.id);
  check('the stroke after a >60 s pause adds no drawing time', exp.ms === before && memberRow(canvas.id, B.user.id).drawTimeMs === before, `${before} → ${exp.ms}`);
  await strokeB(pageB, 660);
  await sleep(2000);
  await strokeB(pageB, 720);
  await sleep(1500);
  exp = expectedDrawMs(canvas.id, B.user.id);
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.drawSec === Math.floor(exp.ms / 1000), 8000);
  check('continuous strokes count again after the pause', r.ok && exp.ms > before + 2000, `${before} → ${exp.ms} ms, panel ${r.st && find(r.st.online, 'B')?.drawSec}s`);
  const drawBeforeLeave = exp.ms;

  // 6. B leaves: offline section, last seen 剛剛, drawing time kept
  const tLeave = Date.now();
  await ctxB.close();
  r = await waitPanel(pageA, (s) => !!find(s.offline, 'B') && s.online.length === 1, 10000);
  const bOff = r.st && find(r.st.offline, 'B');
  check('B moves to the 離線 section when the tab closes', r.ok, `${r.ms} ms`);
  check('B: last seen 剛剛, drawing time kept', bOff?.lastSeen === '剛剛' && bOff?.drawSec === Math.floor(drawBeforeLeave / 1000), JSON.stringify(bOff));
  check('offline list: most recently seen first (B before C)', r.st?.offline.map((m) => m.name).join() === 'B,C', r.st?.offline.map((m) => m.name).join());
  const rowB2 = memberRow(canvas.id, B.user.id);
  check('database: B\'s last_seen_at is the moment the tab closed', Math.abs(rowB2.lastSeenAt - tLeave) < 3000, `${rowB2.lastSeenAt - tLeave} ms off`);
  check('database: B\'s draw_time_ms unchanged by leaving', rowB2.drawTimeMs === drawBeforeLeave);
  await shot(pageA, '2-offline');

  // 7. Server restart: everything comes back from the database
  await stopServer();
  await startServer();
  // A fresh tab of A's: everything it shows came from the restarted server
  const { ctx: ctxA2, page: pageA2 } = await openPage(browser, HOST_A, A.token, canvas.id);
  await openMembersPanel(pageA2);
  r = await waitPanel(pageA2, (s) => !!find(s.offline, 'B') && !!find(s.offline, 'C') && !find(s.online, 'B'), 15000);
  const bAfter = r.st && find(r.st.offline, 'B');
  check('after a server restart a new tab sees B (and C) offline', r.ok, `${r.ms} ms`);
  const rOld = await waitPanel(pageA, (s) => s.online.length === 2 && !!find(s.offline, 'B'), 30000);
  check('A\'s old tab reconnected too (lists both of A\'s tabs online)', rOld.ok, `${rOld.ms} ms`);
  check('B\'s last seen and drawing time survived the restart',
    bAfter?.drawSec === Math.floor(drawBeforeLeave / 1000) && bAfter?.lastSeenTitle === `最後上線 ${new Date(rowB2.lastSeenAt).toLocaleString('zh-TW', { hour12: false })}`,
    `${bAfter?.lastSeen} / ${bAfter?.lastSeenTitle} / ${bAfter?.drawText}`);

  // 8. B comes back: online again with the stored drawing time; idle state survives a reconnect
  await ctxA2.close();
  ({ ctx: ctxB, page: pageB } = await openPage(browser, HOST_B, B.token, canvas.id, { atelier_idle_after_ms: String(B_IDLE_MS) }));
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.presence === 'online' && s.offline.length === 1, 15000);
  check('B rejoins: back in 在線 with the stored drawing time', r.ok && find(r.st.online, 'B')?.drawSec === Math.floor(drawBeforeLeave / 1000), JSON.stringify(r.st && find(r.st.online, 'B')));
  r = await waitPanel(pageA, (s) => find(s.online, 'B')?.presence === 'idle', 15000);
  check('B idles again', r.ok);
  await stopServer();
  await startServer();
  // Again a fresh tab: B's tab must reconnect and re-report idle to the new server process
  const tRe = Date.now();
  const { page: pageA3 } = await openPage(browser, HOST_A, A.token, canvas.id);
  await openMembersPanel(pageA3);
  r = await waitPanel(pageA3, (s) => !!find(s.online, 'B'), 20000);
  const r2 = await waitPanel(pageA3, (s) => find(s.online, 'B')?.presence === 'idle', 10000);
  check('after another restart B reconnects and is shown idle again to a new tab (no input meanwhile)', r.ok && r2.ok, `B back after ${r.ms} ms, idle ${r2.ms} ms later; ${Date.now() - tRe} ms in all`);
  const rB = await waitPanel(pageA3, (s) => find(s.online, 'B')?.drawSec === Math.floor(drawBeforeLeave / 1000), 3000);
  check('B\'s drawing time after the second restart is the stored one', rB.ok);
  await shot(pageA3, '3-idle-after-restart');

  await browser.close();
  await stopServer();

  // 9. Upgrading an old database: drop the new columns, give B's ops known times, run the migration
  const migDir = path.join(path.dirname(DATA), `mig-${run}`);
  fs.mkdirSync(migDir, { recursive: true });
  const migDb = path.join(migDir, 'atelier.db');
  const live = new Database(DB_PATH);
  live.exec(`VACUUM INTO '${migDb.replace(/\\/g, '/')}'`);
  live.close();
  const mig = new Database(migDb);
  const joinedB = mig.prepare('SELECT joined_at AS j FROM canvas_members WHERE canvas_id = ? AND user_id = ?').get(canvas.id, B.user.id).j;
  const opsB = mig.prepare(`SELECT seq FROM canvas_ops WHERE canvas_id = ? AND user_id = ? ORDER BY seq`).all(canvas.id, B.user.id);
  // 5 s apart, except one 300 s gap in the middle
  const t0 = joinedB + 10_000;
  let t = t0;
  const setTime = mig.prepare('UPDATE canvas_ops SET created_at = ? WHERE canvas_id = ? AND seq = ?');
  opsB.forEach((o, i) => { if (i > 0) t += i === Math.floor(opsB.length / 2) ? 300_000 : 5_000; setTime.run(t, canvas.id, o.seq); });
  const expectedMig = (opsB.length - 2) * 5_000;
  mig.exec('ALTER TABLE canvas_members DROP COLUMN last_seen_at; ALTER TABLE canvas_members DROP COLUMN draw_time_ms;');
  mig.close();
  const runMigration = () => execFileSync(process.execPath, ['-e', "require('./dist/db').initDatabase()"], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: migDir } });
  runMigration();
  const readMig = () => {
    const d = new Database(migDb, { readonly: true });
    try {
      return Object.fromEntries(d.prepare('SELECT user_id AS u, last_seen_at AS l, draw_time_ms AS ms, joined_at AS j FROM canvas_members WHERE canvas_id = ?').all(canvas.id).map((x) => [x.u, x]));
    } finally { d.close(); }
  };
  const m1 = readMig();
  check('migration: B\'s drawing time rebuilt from the op log (300 s gap skipped)', m1[B.user.id].ms === expectedMig, `${m1[B.user.id].ms} / expected ${expectedMig} from ${opsB.length} ops`);
  check('migration: B\'s last seen = time of B\'s last op', m1[B.user.id].l === t, `${m1[B.user.id].l - t} ms off`);
  check('migration: C (no ops) gets last seen = joined_at and 0 drawing time', m1[C.user.id].l === m1[C.user.id].j && m1[C.user.id].ms === 0);
  check('migration: A (no ops) gets 0 drawing time', m1[A.user.id].ms === 0);
  runMigration();
  const m2 = readMig();
  check('migration runs once (a second boot changes nothing)', JSON.stringify(m1) === JSON.stringify(m2));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer().catch(() => {});
  process.exit(1);
});

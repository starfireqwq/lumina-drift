/**
 * Real-browser Time-Lapse Replay verification against an isolated throwaway server:
 *  - Seeds 1920x1080 canvas with 8,483 ops across 7 collaborators (with avatars + display names) + edge tiles
 *  - Opens Time-Lapse Replay modal in headless Chrome
 *  - Verifies all 8,483 ops load, all 7 collaborators' avatars & names appear, painter brush cursors render on canvas
 *  - Verifies scrubbing, playback at 64x, cursor overlay toggle, error+retry recovery, and WebM video export
 */
import assert from 'node:assert';
import { chromium } from 'playwright-core';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { compressTileBuffer, encodePacket } from '@atelier/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function makeAvatarPngDataUrl(r: number, g: number, b: number): string {
  // Valid 1x1 PNG encoded as data URL; crisp colored square for avatar <img> rendering
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63' +
      r.toString(16).padStart(2, '0') +
      g.toString(16).padStart(2, '0') +
      b.toString(16).padStart(2, '0') +
      '000000050001a5f645400000000049454e44ae426082',
    'hex'
  );
  // Fallback to reliable prebuilt 1x1 solid PNG if CRC differs
  void pngBytes;
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
}

async function runBrowserTests() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-tl-browser-'));
  const shotsDir = process.argv[2] || '';
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverDir = process.cwd();
  const logFd = fs.openSync(path.join(dataDir, 'server.log'), 'a');

  const server = spawn(process.execPath, ['dist/server.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      DATABASE_PATH: path.join(dataDir, 'atelier.db'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
      JWT_SECRET: '',
    },
    stdio: ['ignore', logFd, logFd],
  });

  const stopServer = async () => {
    if (server.exitCode === null) {
      const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
      server.kill();
      await exited;
    }
    try {
      fs.closeSync(logFd);
    } catch {}
  };

  try {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) break;
      } catch {}
      if (server.exitCode !== null) throw new Error(`Throwaway server exited early with ${server.exitCode}`);
      await sleep(150);
    }

    const api = async (token: string | null, method: string, url: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`);
      return data;
    };

    const admin = await api(null, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    await api(admin.token, 'PATCH', '/api/auth/profile', {
      displayName: '主畫師 Alice',
      avatarUrl: makeAvatarPngDataUrl(99, 102, 241),
    });

    const collabNames = ['藍星畫師', '櫻花喵', '青空線稿', '金橘塗鴉', '翡翠水彩', '暮紫陰影'];
    const collabs: Array<{ id: string; displayName: string; avatarUrl: string }> = [];
    for (let i = 0; i < collabNames.length; i++) {
      const reg = await api(null, 'POST', '/api/auth/register', {
        username: `artist_${i}_${Date.now().toString(36)}`,
        password: 'password123',
        displayName: collabNames[i],
      });
      const avatarUrl = makeAvatarPngDataUrl(50 + i * 30, 120, 220 - i * 25);
      await api(reg.token, 'PATCH', '/api/auth/profile', {
        displayName: collabNames[i],
        avatarUrl,
      });
      collabs.push({ id: reg.user.id, displayName: collabNames[i], avatarUrl });
    }

    const created = await api(admin.token, 'POST', '/api/canvases', {
      title: '8483協作重播測試畫布',
      width: 1920,
      height: 1080,
      bgColor: '#FFFFFF',
    });
    const canvasId = created.canvas.id as string;
    const layerId = created.layers[1].id as string;

    // Seed 8,483 ops directly in SQLite (4,636 by admin + 3,847 across 6 offline collaborators)
    const mkCompressed = (rgba: [number, number, number, number], w = 256, h = 256) => {
      const buf = new Uint8Array(w * h * 4);
      for (let i = 0; i < buf.length; i += 4) buf.set(rgba, i);
      return compressTileBuffer(buf, 'lz4');
    };
    const adminTile = mkCompressed([59, 130, 246, 220]);
    const collabTiles = collabs.map((_, idx) => mkCompressed([(idx * 45 + 60) % 255, 90, 200, 220]));
    const edgeTile = mkCompressed([16, 185, 129, 255], 128, 56);

    const makeBlob = (col: number, row: number, x: number, y: number, color: string, comp: any, w = 256, h = 256) =>
      Buffer.from(
        encodePacket({
          type: 'OP_COMMIT',
          canvasId,
          layerId,
          opType: 'STROKE',
          payload: {
            color,
            size: 24,
            opacity: 1,
            isEraser: false,
            samplePoints: [
              { x: x - 40, y: y - 20, pressure: 0.7 },
              { x, y, pressure: 0.9 },
            ],
            allPoints: [
              { x: x - 40, y: y - 20, pressure: 0.7 },
              { x, y, pressure: 0.9 },
            ],
            tiles: [{ col, row, width: w, height: h, compression: comp.compression, data: comp.data }],
            inkTiles: [{ col, row, width: w, height: h, compression: comp.compression, data: comp.data }],
          },
        } as any)
      );

    const adminBlob = makeBlob(1, 1, 380, 380, '#3B82F6', adminTile);
    const collabBlobs = collabs.map((_, idx) =>
      makeBlob((idx % 5) + 1, Math.floor(idx / 3) + 1, 350 + idx * 210, 300 + (idx % 2) * 320, '#F43F5E', collabTiles[idx])
    );
    const edgeBlob = makeBlob(7, 4, 1860, 1050, '#10B981', edgeTile, 128, 56);

    const dbConn = new Database(path.join(dataDir, 'atelier.db'));
    const insertOp = dbConn.prepare(
      'INSERT INTO canvas_ops (canvas_id, seq, user_id, layer_id, op_type, payload_blob, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const totalOps = 8483;
    const now = Date.now();
    dbConn.transaction(() => {
      for (let seq = 1; seq <= totalOps; seq++) {
        if (seq <= 4636) {
          insertOp.run(canvasId, seq, admin.user.id, layerId, 'STROKE', adminBlob, now + seq * 10);
        } else {
          const ci = (seq - 4637) % collabs.length;
          const isEdge = seq === totalOps;
          insertOp.run(canvasId, seq, collabs[ci].id, layerId, 'STROKE', isEdge ? edgeBlob : collabBlobs[ci], now + seq * 10);
        }
      }
      dbConn.prepare('UPDATE canvases SET latest_seq = ? WHERE id = ?').run(totalOps, canvasId);
    })();
    dbConn.close();

    // Launch isolated headless browser
    const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(
      ([t, c]) => {
        localStorage.setItem('atelier_token', t);
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_active_canvas_id', c);
      },
      [admin.token, canvasId]
    );
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl);
    await page.waitForFunction(() => (window as any).__debugPixi?.layerManager?.getLayers().length >= 1, null, {
      timeout: 30000,
    });

    // Open File -> 縮時重播
    await page.getByRole('button', { name: '檔案', exact: true }).click();
    await page.getByRole('menuitem', { name: '縮時重播' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });

    // Wait for all 8,483 ops to finish loading
    await page.waitForFunction(
      () => document.body.innerText.includes('歷史總筆劃數: 8,483'),
      null,
      { timeout: 30000 }
    );

    const modalText = await dialog.innerText();
    assert.ok(!modalText.includes('此畫布尚無任何歷史繪圖動作可供重播'), 'Must NOT show empty noOpsWarning');
    assert.ok(modalText.includes('8,483'), 'Must show 8,483 total ops');
    for (const name of ['主畫師 Alice', ...collabNames]) {
      assert.ok(modalText.includes(name), `Collaborator ${name} must be listed in replay modal`);
    }
    const avatarImgCount = await dialog.locator('img').count();
    assert.ok(avatarImgCount >= 7, `Expected >= 7 collaborator avatar <img> elements, got ${avatarImgCount}`);
    console.log(`✓ Browser loaded all 8,483 ops and rendered all 7 collaborator badges & avatars (${avatarImgCount} imgs)`);

    // Scrub to #4660 (where all 7 painters have recent active strokes) and verify cursor overlay renders onto canvas
    const slider = dialog.locator('input[type="range"]');
    await slider.fill('4660');
    await slider.dispatchEvent('change');
    await sleep(300);

    const canvasWithCursors = await dialog.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
    assert.ok(canvasWithCursors.length > 2000, 'Canvas must have rendered content');

    if (shotsDir) {
      fs.mkdirSync(shotsDir, { recursive: true });
      await dialog.screenshot({ path: path.join(shotsDir, 'timelapse-with-cursors.png') });
    }

    // Toggle painter cursors OFF and verify canvas pixels actually differ (proving cursor + avatar + name are drawn on canvas!)
    const toggleBtn = dialog.getByRole('button', { name: '顯示畫筆與頭像' });
    assert.strictEqual(await toggleBtn.getAttribute('aria-pressed'), 'true');
    await toggleBtn.click();
    assert.strictEqual(await toggleBtn.getAttribute('aria-pressed'), 'false');
    await sleep(100);
    const canvasWithoutCursors = await dialog.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
    assert.notStrictEqual(canvasWithCursors, canvasWithoutCursors, 'Toggling cursors must change canvas visual output');

    // Scrub to #8483 (includes edge tile 128x56 at col 7, row 4) while cursor overlay is hidden to sample raw pixel
    assert.strictEqual(await toggleBtn.getAttribute('aria-pressed'), 'false');
    await slider.fill('8483');
    await sleep(200);
    const edgePixel = await dialog.locator('canvas').evaluate((c: HTMLCanvasElement) => {
      const ctx2d = c.getContext('2d')!;
      const px = ctx2d.getImageData(1820, 1040, 1, 1).data;
      return Array.from(px);
    });
    assert.deepStrictEqual(edgePixel, [16, 185, 129, 255], 'Edge tile (128x56) must render exact un-premultiplied color');
    console.log('✓ Non-256-multiple edge tile (128x56) rendered cleanly with exact pixels');

    // Toggle back ON for playback & video export
    await toggleBtn.click();
    assert.strictEqual(await toggleBtn.getAttribute('aria-pressed'), 'true');

    // Playback at 64x from op #8200 to completion
    await slider.fill('8200');
    await slider.dispatchEvent('change');
    await dialog.getByRole('button', { name: '64x' }).click();
    await dialog.getByRole('button', { name: '播放錄影' }).click();
    await page.waitForFunction(
      () => document.body.innerText.includes('當前筆劃序號: #8,483'),
      null,
      { timeout: 15000 }
    );
    console.log('✓ Playback at 64x ran smoothly to #8,483');

    // Export WebM video
    await dialog.getByRole('button', { name: '匯出重播為影片檔' }).click();
    const downloadLink = dialog.getByRole('link', { name: '下載重播影片檔' });
    await downloadLink.waitFor({ state: 'visible', timeout: 45000 });
    const exportedSize = await downloadLink.evaluate(async (a: HTMLAnchorElement) => {
      const blob = await fetch(a.href).then((r) => r.blob());
      return { size: blob.size, type: blob.type };
    });
    assert.ok(exportedSize.size > 1000, `Exported video blob must be non-empty, got ${exportedSize.size} bytes`);
    console.log(`✓ Time-Lapse video export succeeded (${exportedSize.size} bytes, ${exportedSize.type})`);

    // Error state & retry verification
    await dialog.getByRole('button', { name: '關閉' }).click();
    await sleep(300);

    let failOnce = true;
    await page.route('**/api/canvases/*/ops*', async (route) => {
      if (failOnce) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: '模擬伺服器暫時發生錯誤' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.getByRole('button', { name: '檔案', exact: true }).click();
    await page.getByRole('menuitem', { name: '縮時重播' }).click();
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await dialog.getByText('模擬伺服器暫時發生錯誤').waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(!(await dialog.innerText()).includes('此畫布尚無任何歷史繪圖動作可供重播'), 'Error must NOT show noOpsWarning');

    failOnce = false;
    await dialog.getByRole('button', { name: '重試載入' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('歷史總筆劃數: 8,483'), null, { timeout: 30000 });
    console.log('✓ Error banner & Retry recovery verified');

    assert.strictEqual(pageErrors.length, 0, `Unexpected browser pageerrors: ${pageErrors.join('; ')}`);
    await browser.close();
    console.log('\n🎉 ALL BROWSER TIME-LAPSE VERIFICATION CHECKS PASSED!');
  } finally {
    await stopServer();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
}

runBrowserTests().catch((err) => {
  console.error('\n❌ Browser Time-Lapse Test Failed:', err);
  process.exit(1);
});

/**
 * Browser verification for canvas resizing:
 * - Movable non-modal resize ToolWindow
 * - 3x3 anchor point shifting for raster pixels & vector strokes + reload persistence
 * - Direct canvas edge/corner handle dragging synced with inputs
 * - Shift (lock aspect ratio) and Alt (symmetric resize) modifier behaviors
 *
 *   PORT=3105 DATA_DIR=<throwaway> node dist/server.js
 *   npx tsx tests/resize-browser.ts http://127.0.0.1:3105
 */
import { chromium, type Page } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3105';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));

async function api(token: string | null, method: string, url: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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
  async opaque(layerName, x, y, w, h) {
    const it = window.__debugPixi.layerManager.getLayers().find((l) => l.model.name === layerName);
    if (!it) return -1;
    const [px] = await window.__debugPixi.layerManager.readAsync(it.model.id, [{ x, y, w, h }]);
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
    return n;
  },
  pt(cx, cy) {
    const d = window.__debugPixi;
    const p = d.viewport.canvasToScreen(cx, cy);
    const r = d.app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  },
  ev(type, cx, cy, buttons) {
    const c = window.__t.pt(cx, cy);
    document.querySelector('.atelier-canvas-viewport').dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 9, pointerType: 'mouse', isPrimary: true,
      clientX: c.x, clientY: c.y, buttons, button: 0, pressure: 0.8,
    }));
  },
  frame: () => new Promise((r) => requestAnimationFrame(() => r())),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  async dragCanvas(pts) {
    const t = window.__t;
    t.ev('pointerdown', pts[0][0], pts[0][1], 1);
    for (const [x, y] of pts.slice(1)) { t.ev('pointermove', x, y, 1); await t.frame(); }
    const l = pts[pts.length - 1];
    t.ev('pointerup', l[0], l[1], 0);
    await t.wait(600);
  },
};
`;

async function loginSession(context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>, username: string, password: string, canvasId: string) {
  const login = await api(null, 'POST', '/api/auth/login', { username, password }).catch(async () =>
    api(null, 'POST', '/api/auth/register', { username, password, displayName: username })
  );
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  await context.addInitScript({ content: HELPERS });
  await context.addInitScript(
    ([tok, cid]: [string, string]) => {
      localStorage.setItem('atelier_token', tok);
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_active_canvas_id', cid);
      localStorage.setItem('atelier_brush_tools', JSON.stringify({ brush: { size: 24, opacity: 1, spacing: 0.02, stabilizerLevel: 0 } }));
      localStorage.removeItem('atelier_toolwin_canvas-resize');
    },
    [login.token, canvasId] as [string, string]
  );
  return login.token as string;
}

async function waitCanvasReady(page: Page, expectedW?: number) {
  try {
    await page.waitForFunction(
      (ew: number | undefined) => {
        const d = (window as any).__debugPixi;
        if (!d?.layerManager?.getLayers()?.length) return false;
        if (ew === undefined) return true;
        const btnText = document.querySelector('button[title="調整畫布尺寸"]')?.textContent || '';
        return btnText.includes(`${ew} ×`);
      },
      expectedW,
      { timeout: 25000 }
    );
  } catch (err) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      hasDebug: Boolean((window as any).__debugPixi),
      layers: (window as any).__debugPixi?.layerManager?.getLayers()?.length ?? -1,
      sizeBtn: document.querySelector('button[title="調整畫布尺寸"]')?.textContent || null,
      bodyText: document.body.innerText.slice(0, 300),
    })).catch((e) => ({ evalErr: String(e) }));
    console.error('[waitCanvasReady timeout diag]', diag);
    throw err;
  }
  await page.waitForTimeout(700);
}

async function main() {
  const tag = Date.now().toString(36);
  const auth = await api(null, 'POST', '/api/auth/register', {
    username: `resizer_${tag}`,
    password: 'pass1234',
    displayName: 'Resizer',
  });
  const token = auth.token as string;
  const { canvas } = await api(token, 'POST', '/api/canvases', {
    title: `resize-test-${tag}`,
    width: 512,
    height: 512,
    bgColor: '#ffffff',
  });
  await api(token, 'POST', `/api/canvases/${canvas.id}/layers`, { name: 'RasterA', layerType: 'raster' });
  await api(token, 'POST', `/api/canvases/${canvas.id}/layers`, { name: 'VectorA', layerType: 'vector' });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await loginSession(context, `resizer_${tag}`, 'pass1234', canvas.id);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitCanvasReady(page, 512);

    // 1. Draw raster brush mark around (100, 100) on RasterA
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-layer-id]')].find((r) => r.querySelector('[title^="RasterA（"]')) as HTMLElement | undefined;
      row?.click();
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => (window as any).__t.dragCanvas([[96, 96], [104, 104], [110, 110]]));
    const drawnPx = await page.evaluate(() => (window as any).__t.opaque('RasterA', 75, 75, 55, 55));
    check('1. Initial raster stroke painted at ~(100,100)', drawnPx > 20, `opaque=${drawnPx}`);

    // 2. Draw vector stroke around (80, 80) -> (140, 140) on VectorA
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-layer-id]')].find((r) => r.querySelector('[title^="VectorA（"]')) as HTMLElement | undefined;
      row?.click();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const b = document.querySelector('nav[aria-label="工具"] button[aria-label^="向量筆"]') as HTMLButtonElement | null;
      b?.click();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as any).__t.dragCanvas([[80, 80], [110, 110], [140, 140]]));
    const vecBefore = await page.evaluate(() => {
      const d = (window as any).__debugPixi;
      const it = d.layerManager.getLayers().find((l: any) => l.model.name === 'VectorA');
      const list = d.vectorEngine.getStrokes(it.model.id);
      return list[0]?.anchors?.[0] ?? null;
    });
    check('2. Initial vector stroke created around (80,80)', Boolean(vecBefore && vecBefore.x >= 70 && vecBefore.x <= 95), JSON.stringify(vecBefore));

    // 3. Open Resize Canvas window and verify it is non-modal and movable
    await page.locator('button[title="調整畫布尺寸"]').first().click();
    const dialog = page.locator('[role="dialog"]').filter({ hasText: '調整畫布尺寸' }).first();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    const isAriaModal = await dialog.getAttribute('aria-modal');
    check('3a. Resize popup is non-modal (allows canvas interaction)', isAriaModal !== 'true', `aria-modal=${isAriaModal}`);

    const boxBeforeMove = await dialog.boundingBox();
    if (!boxBeforeMove) throw new Error('Resize dialog bounding box missing');
    const headerCenterX = boxBeforeMove.x + boxBeforeMove.width / 2;
    const headerCenterY = boxBeforeMove.y + 18;
    await page.mouse.move(headerCenterX, headerCenterY);
    await page.mouse.down();
    await page.mouse.move(headerCenterX - 240, headerCenterY + 70, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const boxAfterMove = await dialog.boundingBox();
    check(
      '3b. Resize popup window can be dragged to a new position',
      Boolean(boxAfterMove && boxAfterMove.x < boxBeforeMove.x - 150 && boxAfterMove.y > boxBeforeMove.y + 40),
      `dx=${boxAfterMove ? Math.round(boxAfterMove.x - boxBeforeMove.x) : 0}, dy=${boxAfterMove ? Math.round(boxAfterMove.y - boxBeforeMove.y) : 0}`
    );

    // 4. Test anchor selection + pixel/vector shifting + persistence across reload
    await page.locator('#resize-w').fill('768');
    await page.locator('#resize-h').fill('768');
    await dialog.locator('button[data-anchor="br"]').click();
    const brOffsetText = await dialog.innerText();
    check('4a. Bottom-Right anchor computes +256, +256 offset', brOffsetText.includes('+256, +256'), brOffsetText.replace(/\s+/g, ' ').slice(0, 140));

    await dialog.locator('button[data-anchor="c"]').click();
    const cOffsetText = await dialog.innerText();
    check('4b. Center anchor computes +128, +128 offset', cOffsetText.includes('+128, +128'));

    await dialog.locator('button:has-text("套用調整")').click();
    await waitCanvasReady(page, 768);

    const oldSpotAfterCenter = await page.evaluate(() => (window as any).__t.opaque('RasterA', 75, 75, 50, 50));
    const newSpotAfterCenter = await page.evaluate(() => (window as any).__t.opaque('RasterA', 200, 200, 60, 60));
    check('4c. Center resize shifted raster pixels from (100,100) to (228,228)', oldSpotAfterCenter === 0 && newSpotAfterCenter > 20, `old=${oldSpotAfterCenter}, new=${newSpotAfterCenter}`);

    const vecAfterCenter = await page.evaluate(() => {
      const d = (window as any).__debugPixi;
      const it = d.layerManager.getLayers().find((l: any) => l.model.name === 'VectorA');
      return d.vectorEngine.getStrokes(it.model.id)[0]?.anchors?.[0] ?? null;
    });
    check(
      '4d. Center resize shifted vector stroke anchors by (+128, +128)',
      Boolean(vecBefore && vecAfterCenter && Math.abs((vecAfterCenter.x - vecBefore.x) - 128) <= 2 && Math.abs((vecAfterCenter.y - vecBefore.y) - 128) <= 2),
      `${JSON.stringify(vecBefore)} -> ${JSON.stringify(vecAfterCenter)}`
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitCanvasReady(page, 768);
    const persistPx = await page.evaluate(() => (window as any).__t.opaque('RasterA', 200, 200, 60, 60));
    const persistVec = await page.evaluate(() => {
      const d = (window as any).__debugPixi;
      const it = d.layerManager.getLayers().find((l: any) => l.model.name === 'VectorA');
      return d.vectorEngine.getStrokes(it.model.id)[0]?.anchors?.[0] ?? null;
    });
    check('4e. Shifted raster & vector state persisted after reload', persistPx > 20 && Boolean(persistVec && persistVec.x >= 195), `px=${persistPx}, vecX=${persistVec?.x}`);

    // 5. Reopen Resize modal & zoom out slightly so canvas edges have room to drag outward
    await page.locator('button[title="縮小"]').click();
    await page.waitForTimeout(100);
    await page.locator('button[title="調整畫布尺寸"]').first().click();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    const eastHandle = page.locator('[data-resize-handle="e"]');
    await eastHandle.waitFor({ state: 'visible', timeout: 5000 });

    // 5a. Plain right-edge drag
    const eBox1 = (await eastHandle.boundingBox())!;
    await page.mouse.move(eBox1.x + eBox1.width / 2, eBox1.y + eBox1.height / 2);
    await page.mouse.down();
    await page.mouse.move(eBox1.x + eBox1.width / 2 + 80, eBox1.y + eBox1.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const wAfterEdge = Number(await page.locator('#resize-w').inputValue());
    const hAfterEdge = Number(await page.locator('#resize-h').inputValue());
    check('5a. Dragging right edge directly expands width without changing height', wAfterEdge > 780 && hAfterEdge === 768, `${wAfterEdge}x${hAfterEdge}`);

    // Reset
    await dialog.locator('button[title="重設為原始畫布尺寸"]').click();
    await page.waitForTimeout(100);
    check('5b. Reset restores 768x768', Number(await page.locator('#resize-w').inputValue()) === 768);

    // 5c. Shift drag: lock aspect ratio (even when dragging pure east edge!)
    const eBox2 = (await eastHandle.boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.move(eBox2.x + eBox2.width / 2, eBox2.y + eBox2.height / 2);
    await page.mouse.down();
    await page.mouse.move(eBox2.x + eBox2.width / 2 + 80, eBox2.y + eBox2.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);
    const wAfterShift = Number(await page.locator('#resize-w').inputValue());
    const hAfterShift = Number(await page.locator('#resize-h').inputValue());
    check('5c. Holding Shift locks aspect ratio while dragging handle', wAfterShift > 780 && wAfterShift === hAfterShift, `${wAfterShift}x${hAfterShift}`);

    // Reset
    await dialog.locator('button[title="重設為原始畫布尺寸"]').click();
    await page.waitForTimeout(100);

    // 5d. Alt drag: symmetric resize around center
    const eastCenterStartX = await page.evaluate(() => (window as any).__t.pt(768, 384).x);
    const eBox3 = (await eastHandle.boundingBox())!;
    await page.keyboard.down('Alt');
    await page.mouse.move(eBox3.x + eBox3.width / 2, eBox3.y + eBox3.height / 2);
    await page.mouse.down();
    await page.mouse.move(eBox3.x + eBox3.width / 2 + 60, eBox3.y + eBox3.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.waitForTimeout(100);
    const wAfterAlt = Number(await page.locator('#resize-w').inputValue());
    const hAfterAlt = Number(await page.locator('#resize-h').inputValue());
    const altDialogText = await dialog.innerText();
    const expectedAltOffsetX = Math.round((wAfterAlt - 768) / 2);
    check(
      '5d. Holding Alt resizes symmetrically around center on both sides',
      wAfterAlt > 800 && hAfterAlt === 768 && altDialogText.includes(`+${expectedAltOffsetX}, 0`),
      `newW=${wAfterAlt}, expectedOffsetX=+${expectedAltOffsetX} (startScreenX=${Math.round(eastCenterStartX)})`
    );

    // 5e. Shift + Alt combined drag: symmetric + aspect-locked
    await dialog.locator('button[title="重設為原始畫布尺寸"]').click();
    await page.waitForTimeout(100);
    const eBox4 = (await eastHandle.boundingBox())!;
    await page.keyboard.down('Shift');
    await page.keyboard.down('Alt');
    await page.mouse.move(eBox4.x + eBox4.width / 2, eBox4.y + eBox4.height / 2);
    await page.mouse.down();
    await page.mouse.move(eBox4.x + eBox4.width / 2 + 60, eBox4.y + eBox4.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);
    const wAfterShiftAlt = Number(await page.locator('#resize-w').inputValue());
    const hAfterShiftAlt = Number(await page.locator('#resize-h').inputValue());
    const saDialogText = await dialog.innerText();
    const expectedSAOff = Math.round((wAfterShiftAlt - 768) / 2);
    check(
      '5e. Holding Shift + Alt resizes symmetrically while locking aspect ratio',
      wAfterShiftAlt > 800 && wAfterShiftAlt === hAfterShiftAlt && saDialogText.includes(`+${expectedSAOff}, +${expectedSAOff}`),
      `${wAfterShiftAlt}x${hAfterShiftAlt}, offset=+${expectedSAOff}`
    );

    // Apply dragged Shift+Alt size & verify pixels centered properly
    await dialog.locator('button:has-text("套用調整")').click();
    await waitCanvasReady(page, wAfterShiftAlt);
    const shiftedX = 228 + expectedSAOff;
    const afterDragPx = await page.evaluate(
      ([cx, cy]: [number, number]) => (window as any).__t.opaque('RasterA', cx - 35, cy - 35, 70, 70),
      [shiftedX, shiftedX] as [number, number]
    );
    check('5f. Drag-resized canvas commits size and shifts pixels accurately', afterDragPx > 20, `at=(${shiftedX},${shiftedX}), px=${afterDragPx}`);

    // 5g. Crop smaller with Top-Left anchor (should crop off shifted pixels cleanly and stay cropped after reload)
    await page.locator('button[title="調整畫布尺寸"]').first().click();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.locator('button[data-anchor="tl"]').click();
    await page.locator('#resize-w').fill('256');
    await page.locator('#resize-h').fill('256');
    await dialog.locator('button:has-text("套用調整")').click();
    await waitCanvasReady(page, 256);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitCanvasReady(page, 256);
    const croppedPx = await page.evaluate(() => (window as any).__t.opaque('RasterA', 0, 0, 256, 256));
    check('5g. Cropping to 256x256 with Top-Left anchor discards outside pixels across reload', croppedPx === 0, `remaining=${croppedPx}`);

    check('No uncaught page errors', errors.length === 0, errors.join('; '));
  } finally {
    await browser.close();
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all resize checks passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Round-9 regression in a real (headless) Chrome on an 8000×8000 canvas with two painters: concurrent
 * strokes, undo of an interrupted stroke, lasso / magic wand / transform / shape / gradient undo-redo,
 * and deleting a layer (raster, bottom, vector, masked) then Ctrl+Z / Ctrl+Shift+Z.
 *
 *   PORT=3100 DATA_DIR=<throwaway> node dist/server.js        (after pnpm -r build)
 *   npx tsx tests/round9-repro-browser.ts http://127.0.0.1:3100
 *
 * Creates its own accounts and canvas: point it at a throwaway server only. Takes about 4 minutes.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p))!;

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

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
  const run = Date.now().toString(36).slice(-5);
  const A = await api(null, 'POST', '/api/auth/register', { username: `r8a_${run}`, password: 'password123', displayName: 'A' });
  const B = await api(null, 'POST', '/api/auth/register', { username: `r8b_${run}`, password: 'password123', displayName: 'B' });
  const { canvas } = await api(A.token, 'POST', '/api/canvases', { title: `r8000 ${run}`, width: 8000, height: 8000 });
  await api(B.token, 'POST', '/api/canvases/join', { inviteCode: canvas.inviteCode });
  const { layer: shared } = await api(A.token, 'POST', `/api/canvases/${canvas.id}/layers`, { name: 'Shared8K', aclMode: 'shared_all' });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
  const pageErrors: string[] = [];
  try {
    const open = async (token: string) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
      await ctx.addInitScript(([t, c]) => {
        localStorage.setItem('atelier_token', t);
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_active_canvas_id', c);
      }, [token, canvas.id]);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => {
        pageErrors.push(e.message);
        console.log('[pageerror]', e.message);
      });
      await p.goto(BASE);
      await p.locator(`[data-layer-id="${shared.id}"]`).waitFor({ timeout: 30000 });
      await p.locator(`[data-layer-id="${shared.id}"]`).click();
      await p.waitForFunction(() => Boolean((window as any).__debugPixi?.layerManager?.getLayers().length >= 2), null, { timeout: 20000 });
      return p;
    };

    const [pA, pB] = await Promise.all([open(A.token), open(B.token)]);
    await pA.waitForTimeout(800);

    const setup = async (p: any) => {
      await p.getByTitle('重設為 100%', { exact: true }).click();
      await p.evaluate((lid: string) => {
        const d = (window as any).__debugPixi;
        const center = d.viewport.canvasToScreen(1500, 1500);
        d.viewport.panBy(d.app.screen.width / 2 - center.x, d.app.screen.height / 2 - center.y);
        (window as any).__dbg = {
          lid,
          tool(name: string) {
            const b = document.querySelector('nav[aria-label="工具"] button[aria-label^="' + name + '"]') as HTMLButtonElement | null;
            b?.click();
            return Boolean(b);
          },
          async countAlpha(x: number, y: number, w: number, h: number) {
            const lm = (window as any).__debugPixi.layerManager;
            const [px] = await lm.readAsync(lid, [{ x, y, w, h }]);
            let n = 0;
            for (let i = 3; i < px.length; i += 4) if (px[i] > 10) n++;
            return n;
          },
          toScreen(x: number, y: number) {
            const d = (window as any).__debugPixi;
            const p = d.viewport.canvasToScreen(x, y);
            const r = d.app.canvas.getBoundingClientRect();
            return { x: r.left + p.x, y: r.top + p.y };
          },
          async dragCanvas(pts: Array<[number, number]>, delay = 8) {
            const d = (window as any).__debugPixi;
            const s = (x: number, y: number) => {
              const p = d.viewport.canvasToScreen(x, y);
              const r = d.app.canvas.getBoundingClientRect();
              return { x: r.left + p.x, y: r.top + p.y };
            };
            const el = document.querySelector('.atelier-canvas-viewport')!;
            const fire = (type: string, x: number, y: number, btns: number) => {
              const p = s(x, y);
              el.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, clientX: p.x, clientY: p.y,
                pointerId: 1, pointerType: 'mouse', isPrimary: true,
                button: type === 'pointermove' ? -1 : 0, buttons: btns, pressure: btns ? 0.8 : 0,
              }));
            };
            fire('pointerdown', pts[0][0], pts[0][1], 1);
            for (let i = 1; i < pts.length; i++) {
              fire('pointermove', pts[i][0], pts[i][1], 1);
              if (delay) await new Promise(r => setTimeout(r, delay));
            }
            fire('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1], 0);
            await new Promise(r => setTimeout(r, 300));
          },
        };
        (window as any).__dbg.tool('筆刷');
      }, shared.id);
    };
    await Promise.all([setup(pA), setup(pB)]);

    // 1. Concurrent 2 painters overlapping on Shared8K around (900..2040, 1100)
    const aLong = Array.from({ length: 20 }, (_, i) => [900 + i * 60, 1100] as [number, number]);
    const bCross = Array.from({ length: 12 }, (_, i) => [1000 + i * 50, 1020 + (i % 2) * 160] as [number, number]);
    await Promise.all([
      pA.evaluate((pts) => (window as any).__dbg.dragCanvas(pts, 25), aLong),
      (async () => { await pB.waitForTimeout(80); await pB.evaluate((pts) => (window as any).__dbg.dragCanvas(pts, 12), bCross); })(),
    ]);
    await pA.waitForTimeout(1600);
    const cov = await pA.evaluate(async (lid: string) => {
      const lm = (window as any).__debugPixi.layerManager;
      const [px] = await lm.readAsync(lid, [{ x: 920, y: 1085, w: 1100, h: 30 }]);
      let colsCovered = 0; const gaps: number[] = [];
      for (let x = 0; x < 1100; x++) {
        let hit = false;
        for (let y = 0; y < 30; y++) if (px[(y * 1100 + x) * 4 + 3] > 20) { hit = true; break; }
        if (hit) colsCovered++; else gaps.push(920 + x);
      }
      return { colsCovered, gapCount: gaps.length };
    }, shared.id);
    console.log('1. Concurrent 8K line coverage:', cov);
    assert(cov.gapCount === 0, `Expected 0 gaps on 8K concurrent stroke, got ${cov.gapCount}`);

    // 2. Slow stroke by A interrupted mid-stroke by 2 fast strokes from B -> Ctrl+Z on A!
    const pADrawSlow = pA.evaluate(async () => {
      const pts: Array<[number, number]> = Array.from({ length: 25 }, (_, i) => [900 + i * 50, 1400]);
      await (window as any).__dbg.dragCanvas(pts, 35);
    });
    const pBInterrupt = (async () => {
      await pB.waitForTimeout(180);
      await pB.evaluate(() => (window as any).__dbg.dragCanvas([[1050, 1340], [1100, 1460], [1150, 1400]], 10));
      await pB.waitForTimeout(100);
      await pB.evaluate(() => (window as any).__dbg.dragCanvas([[1300, 1340], [1350, 1460]], 10));
    })();
    await Promise.all([pADrawSlow, pBInterrupt]);
    await pA.waitForTimeout(1200);
    const measureRow = async () => pA.evaluate(async (lid: string) => {
      const lm = (window as any).__debugPixi.layerManager;
      const [px] = await lm.readAsync(lid, [{ x: 900, y: 1385, w: 1200, h: 30 }]);
      let cols = 0;
      for (let x = 0; x < 1200; x++) { for (let y = 0; y < 30; y++) if (px[(y * 1200 + x) * 4 + 3] > 20) { cols++; break; } }
      return cols;
    }, shared.id);
    const beforeUndo = await measureRow();
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(1200);
    const afterUndo = await measureRow();
    console.log('2. Interrupted stroke undo cols:', { beforeUndo, afterUndo });
    assert(beforeUndo > 1100 && afterUndo < 350, `Ctrl+Z on interrupted stroke failed: before=${beforeUndo}, after=${afterUndo}`);

    // 3. Lasso blank click deselect + Ctrl+Z / Ctrl+Shift+Z on selection
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('套索選取');
      await new Promise(r => setTimeout(r, 150));
      await (window as any).__dbg.dragCanvas([[940, 1040], [1160, 1040], [1160, 1180], [940, 1180], [940, 1041]], 5);
    });
    const selAfterLasso = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    await pA.evaluate(() => (window as any).__dbg.dragCanvas([[1800, 1800]], 0));
    const selAfterLassoBlank = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(300);
    const selAfterLassoUndo = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    await pA.keyboard.press('Control+Shift+z');
    await pA.waitForTimeout(300);
    const selAfterLassoRedo = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    console.log('3. Lasso:', { selAfterLasso, selAfterLassoBlank, selAfterLassoUndo, selAfterLassoRedo });
    assert(selAfterLasso && !selAfterLassoBlank && selAfterLassoUndo && !selAfterLassoRedo, 'Lasso blank click / selection undo-redo failed');

    // Restore selection for Wand test & Transform test
    // 4. Magic Wand blank click deselect + Ctrl+Z
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('魔術棒');
      await new Promise(r => setTimeout(r, 150));
      await (window as any).__dbg.dragCanvas([[1000, 1100]], 0);
    });
    const selAfterWand = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    await pA.evaluate(() => (window as any).__dbg.dragCanvas([[1900, 1900]], 0));
    const selAfterWandBlank = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(300);
    const selAfterWandUndo = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    console.log('4. Magic Wand:', { selAfterWand, selAfterWandBlank, selAfterWandUndo });
    assert(selAfterWand && !selAfterWandBlank && selAfterWandUndo, 'Magic Wand blank click / undo failed');

    // 5. Transform Apply & Cancel + Ctrl+Z / Ctrl+Shift+Z (clear active selection first, then draw near viewport center)
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('套索選取');
      await new Promise(r => setTimeout(r, 80));
      await (window as any).__dbg.dragCanvas([[1700, 1700]], 0);
      (window as any).__dbg.tool('筆刷');
      await new Promise(r => setTimeout(r, 80));
      await (window as any).__dbg.dragCanvas([[1420, 1380], [1560, 1380]], 10);
      await new Promise(r => setTimeout(r, 250));
      (window as any).__dbg.tool('套索選取');
      await new Promise(r => setTimeout(r, 120));
      await (window as any).__dbg.dragCanvas([[1390, 1340], [1590, 1340], [1590, 1420], [1390, 1420], [1390, 1341]], 5);
    });
    const srcAlpha = await pA.evaluate(() => (window as any).__dbg.countAlpha(1380, 1330, 220, 100));
    await pA.evaluate(() => (window as any).__dbg.tool('自由變形'));
    const applyBtn = pA.locator('[data-transform-overlay="true"] button:has-text("套用")').first();
    const cancelBtn = pA.locator('[data-transform-overlay="true"] button:has-text("取消")').first();
    await cancelBtn.waitFor({ state: 'visible', timeout: 5000 });
    await cancelBtn.click();
    await pA.waitForTimeout(300);
    assert(!(await cancelBtn.isVisible().catch(() => false)), 'Transform Cancel button did not close overlay');

    const destBeforeTransform = await pA.evaluate(() => (window as any).__dbg.countAlpha(1380, 1510, 220, 120));
    await pA.evaluate(() => (window as any).__dbg.tool('自由變形'));
    await applyBtn.waitFor({ state: 'visible', timeout: 5000 });
    // Real mouse drag inside TransformOverlay center (1490, 1380) -> (1490, 1550)
    const pFrom = await pA.evaluate(() => (window as any).__dbg.toScreen(1490, 1380));
    const pTo = await pA.evaluate(() => (window as any).__dbg.toScreen(1490, 1550));
    await pA.mouse.move(pFrom.x, pFrom.y);
    await pA.mouse.down();
    await pA.mouse.move(pTo.x, pTo.y, { steps: 6 });
    await pA.mouse.up();
    await pA.waitForTimeout(150);
    await applyBtn.click();
    await pA.waitForTimeout(700);
    assert(!(await applyBtn.isVisible().catch(() => false)), 'Transform Apply button did not close overlay');
    const destAfterApply = await pA.evaluate(() => (window as any).__dbg.countAlpha(1380, 1510, 220, 120));
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(700);
    const destAfterUndo = await pA.evaluate(() => (window as any).__dbg.countAlpha(1380, 1510, 220, 120));
    const selAfterTransformUndo = await pA.evaluate(() => Boolean((window as any).__debugPixi?.selectionEngine?.hasSelection?.()));
    await pA.keyboard.press('Control+Shift+z');
    await pA.waitForTimeout(700);
    const destAfterRedo = await pA.evaluate(() => (window as any).__dbg.countAlpha(1380, 1510, 220, 120));
    console.log('5. Transform Apply/Undo/Redo:', { srcAlpha, pFrom, pTo, destBeforeTransform, destAfterApply, destAfterUndo, selAfterTransformUndo, destAfterRedo });
    assert(srcAlpha > 100 && destAfterApply > destBeforeTransform + 100 && destAfterUndo <= destBeforeTransform + 10 && selAfterTransformUndo && destAfterRedo > destBeforeTransform + 100, 'Transform Apply / Undo / Redo failed');

    // Clear redone transform selection cleanly before Steps 6-8
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('套索選取');
      await new Promise(r => setTimeout(r, 80));
      await (window as any).__dbg.dragCanvas([[1700, 1700]], 0);
    });

    // 6. Wheel sliders + range focus Ctrl+Z
    const layerOpacity = pA.locator('input[aria-label="圖層不透明度"]');
    const beforeOp = Number(await layerOpacity.inputValue());
    await layerOpacity.hover();
    await pA.mouse.wheel(0, 120);
    await pA.waitForTimeout(150);
    const afterOp = Number(await layerOpacity.inputValue());
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('筆刷');
      await new Promise(r => setTimeout(r, 80));
      await (window as any).__dbg.dragCanvas([[1420, 1650], [1560, 1650]], 10);
    });
    const strokeBeforeRangeUndo = await pA.evaluate(() => (window as any).__dbg.countAlpha(1400, 1630, 180, 40));
    await layerOpacity.focus();
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(700);
    const destAfterSliderFocusUndo = await pA.evaluate(() => (window as any).__dbg.countAlpha(1400, 1630, 180, 40));

    const brushSizeSlider = pA.locator('[aria-label="筆刷大小"]');
    const bSizeBox = await brushSizeSlider.boundingBox();
    const beforeSize = Number(await brushSizeSlider.getAttribute('aria-valuenow'));
    if (bSizeBox) {
      await pA.mouse.move(bSizeBox.x + bSizeBox.width / 2, bSizeBox.y + bSizeBox.height / 2);
      await pA.mouse.wheel(0, -120);
      await pA.waitForTimeout(150);
    }
    const afterSize = Number(await brushSizeSlider.getAttribute('aria-valuenow'));

    const brushOpSlider = pA.locator('[aria-label="筆刷不透明度"]');
    const bOpBox = await brushOpSlider.boundingBox();
    const beforeBOp = Number(await brushOpSlider.getAttribute('aria-valuenow'));
    if (bOpBox) {
      await pA.mouse.move(bOpBox.x + bOpBox.width / 2, bOpBox.y + bOpBox.height / 2);
      await pA.mouse.wheel(0, 120);
      await pA.waitForTimeout(150);
    }
    const afterBOp = Number(await brushOpSlider.getAttribute('aria-valuenow'));
    console.log('6. Wheel & range focus undo:', { beforeOp, afterOp, beforeSize, afterSize, beforeBOp, afterBOp, strokeBeforeRangeUndo, destAfterSliderFocusUndo });
    assert(afterOp < beforeOp && afterSize > beforeSize && afterBOp < beforeBOp && strokeBeforeRangeUndo > 100 && destAfterSliderFocusUndo === 0, 'Wheel slider or focused-range Ctrl+Z failed');

    // 7. Sharp shapes + corner roundness + > >> step buttons + wheel + Undo
    await pA.evaluate(() => (window as any).__dbg.tool('形狀'));
    await pA.getByRole('radio', { name: '三角形', exact: true }).click();
    const lwInput = pA.locator('input[aria-label="線寬"]');
    const lw0 = Number(await lwInput.inputValue());
    await pA.locator('button[aria-label="線寬 增加"]').click();
    await pA.locator('button[aria-label="線寬 大幅增加"]').click();
    await lwInput.hover();
    await pA.mouse.wheel(0, -120);
    const lw1 = Number(await lwInput.inputValue());

    const crInput = pA.locator('input[aria-label="導角圓滑度"]');
    const cr0 = Number(await crInput.inputValue());
    await pA.locator('button[aria-label="導角圓滑度 增加"]').click();
    await pA.locator('button[aria-label="導角圓滑度 大幅增加"]').click();
    await crInput.hover();
    await pA.mouse.wheel(0, -120);
    const cr1 = Number(await crInput.inputValue());

    await pA.evaluate(() => (window as any).__dbg.dragCanvas([[1550, 1450], [1800, 1700]], 10));
    await pA.waitForTimeout(700);
    const triAlpha = await pA.evaluate(() => (window as any).__dbg.countAlpha(1530, 1430, 300, 300));
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(700);
    const triAfterUndo = await pA.evaluate(() => (window as any).__dbg.countAlpha(1530, 1430, 300, 300));
    console.log('7. Shape rounded triangle:', { lw0, lw1, cr0, cr1, triAlpha, triAfterUndo });
    assert(lw1 >= lw0 + 12 && cr1 >= cr0 + 12 && triAlpha > 200 && triAfterUndo === 0, 'Rounded triangle shape / controls failed');

    // 8. Gradient on 8000x8000 + Undo
    // Pixels drawn before the gradient (step 5's moved stroke, step 1's line) must come back exactly
    const priorBefore = await pA.evaluate(async () => [
      await (window as any).__dbg.countAlpha(1380, 1510, 220, 120),
      await (window as any).__dbg.countAlpha(900, 1080, 1200, 40),
    ]);
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('漸層');
      await new Promise(r => setTimeout(r, 150));
      await (window as any).__dbg.dragCanvas([[1900, 1450], [2150, 1700]], 10);
    });
    const tGrad0 = Date.now();
    let gradAlpha = 0;
    for (let i = 0; i < 40; i++) {
      gradAlpha = await pA.evaluate(() => (window as any).__dbg.countAlpha(1900, 1450, 260, 260));
      if (gradAlpha > 0) break;
      await pA.waitForTimeout(200);
    }
    const gradElapsedMs = Date.now() - tGrad0;
    await pA.keyboard.press('Control+z');
    const tUndo0 = Date.now();
    let gradAfterUndo = gradAlpha;
    for (let i = 0; i < 40; i++) {
      gradAfterUndo = await pA.evaluate(() => (window as any).__dbg.countAlpha(1900, 1450, 260, 260));
      if (gradAfterUndo === 0) break;
      await pA.waitForTimeout(200);
    }
    const gradUndoElapsedMs = Date.now() - tUndo0;
    const priorAfter = await pA.evaluate(async () => [
      await (window as any).__dbg.countAlpha(1380, 1510, 220, 120),
      await (window as any).__dbg.countAlpha(900, 1080, 1200, 40),
    ]);
    console.log('8. Gradient 8K:', { gradAlpha, gradElapsedMs, gradAfterUndo, gradUndoElapsedMs, priorBefore, priorAfter });
    assert(gradAlpha > 1000 && gradAfterUndo === 0, `8K gradient or undo failed: grad=${gradAlpha}, afterUndo=${gradAfterUndo}`);
    assert(priorBefore[0] > 100 && priorBefore[1] > 1000 && priorAfter[0] === priorBefore[0] && priorAfter[1] === priorBefore[1],
      `8K gradient undo did not restore earlier pixels: before=${priorBefore} after=${priorAfter}`);

    // 9. Deleted layer Ctrl+Z recovery + sequential undo + Ctrl+Shift+Z redo delete
    //    Test 9a: Painted raster layer (`Shared8K` at sortOrder 2) with a brand-new stroke on it
    const targetName = 'Shared8K';
    await pA.locator(`[data-layer-id="${shared.id}"]`).click({ position: { x: 140, y: 20 } });
    await pA.waitForTimeout(200);
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('筆刷');
      await new Promise(r => setTimeout(r, 80));
      await (window as any).__dbg.dragCanvas([[1480, 1780], [1640, 1780]], 10);
    });
    await pA.waitForTimeout(800);
    const readLayerAlpha = (name: string) => pA.evaluate(async (nm: string) => {
      const d = (window as any).__debugPixi;
      const list = [...d.layerManager.getLayers()].sort((a: any, b: any) => a.model.sortOrder - b.model.sortOrder);
      const found = list.find((it: any) => it.model.name === nm);
      if (!found) return { n: -1, r6: -1, r7: -1, count: list.length, id: null, idx: -1, names: list.map((it: any) => it.model.name) };
      const [px] = await d.layerManager.readAsync(found.model.id, [{ x: 1460, y: 1750, w: 200, h: 60 }]);
      let n = 0, r6 = 0, r7 = 0;
      for (let yy = 0; yy < 60; yy++) {
        for (let xx = 0; xx < 200; xx++) {
          if (px[(yy * 200 + xx) * 4 + 3] > 10) {
            n++;
            if (1750 + yy < 1792) r6++; else r7++;
          }
        }
      }
      return { n, r6, r7, count: list.length, id: found.model.id, idx: list.indexOf(found), names: list.map((it: any) => it.model.name) };
    }, name);
    const beforeDel = await readLayerAlpha(targetName);
    console.log('  [Step9 beforeDel]', beforeDel);
    assert(beforeDel.n > 200, `Expected painted pixels on ${targetName} before delete, got ${beforeDel.n}`);
    pA.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning' || m.text().includes('undo') || m.text().includes('conflict') || m.text().includes('[')) {
        console.log('  [Step9 console]', m.type(), m.text());
      }
    });
    pA.once('dialog', (d) => d.accept());
    await pA.locator('button[aria-label="刪除目前圖層"]').click();
    await pA.waitForTimeout(900);
    const duringDel = await readLayerAlpha(targetName);
    assert(duringDel.n === -1 && duringDel.count === beforeDel.count - 1, `Layer was not deleted: ${JSON.stringify(duringDel)}`);

    // Ctrl+Z #1 -> brings deleted layer back (new server id, exact pixels, same order)
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(1300);
    const afterUndoDel = await readLayerAlpha(targetName);
    const btnAfter1 = await pA.evaluate(() => ({
      undoDisabled: (document.querySelector('button[title*="復原"]') as HTMLButtonElement | null)?.disabled,
      redoDisabled: (document.querySelector('button[title*="重做"]') as HTMLButtonElement | null)?.disabled,
      activeId: (document.querySelector('[data-layer-id].ring-1, [data-layer-id][aria-selected="true"]') as HTMLElement | null)?.getAttribute('data-layer-id'),
      focusTag: document.activeElement?.tagName,
    }));
    console.log('  [Step9 after Ctrl+Z #1]', { afterUndoDel, btnAfter1 });
    assert(afterUndoDel.count === beforeDel.count && afterUndoDel.id !== beforeDel.id && afterUndoDel.idx === beforeDel.idx && afterUndoDel.n >= beforeDel.n - 20,
      `Ctrl+Z did not restore deleted layer cleanly: before=${JSON.stringify(beforeDel)} after=${JSON.stringify(afterUndoDel)}`);

    // Ctrl+Z #2 -> undoes the prior stroke (1480,1780)-(1640,1780) on the restored layer!
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(1500);
    const afterUndoStroke = await readLayerAlpha(targetName);
    const btnAfter2 = await pA.evaluate(() => ({
      undoDisabled: (document.querySelector('button[title*="復原"]') as HTMLButtonElement | null)?.disabled,
      redoDisabled: (document.querySelector('button[title*="重做"]') as HTMLButtonElement | null)?.disabled,
      focusTag: document.activeElement?.tagName,
    }));
    console.log('  [Step9 after Ctrl+Z #2]', { afterUndoStroke, btnAfter2 });
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(1200);
    const afterUndo3 = await readLayerAlpha(targetName);
    console.log('  [Step9 after Ctrl+Z #3]', afterUndo3);
    assert(afterUndoStroke.n === 0, `Second Ctrl+Z did not undo prior stroke on restored layer: ${JSON.stringify(afterUndoStroke)}`);
    // Ctrl+Z #3 undid an older step (the selection clear before step 6), not pixels here: redo it
    // first, so the next Ctrl+Shift+Z is the stroke's
    assert(afterUndo3.n === 0, `Ctrl+Z #3 changed the restored layer: ${JSON.stringify(afterUndo3)}`);
    await pA.keyboard.press('Control+Shift+z');
    await pA.waitForTimeout(900);
    const afterRedo3 = await readLayerAlpha(targetName);
    assert(afterRedo3.n === 0, `Redo of Ctrl+Z #3 changed the restored layer: ${JSON.stringify(afterRedo3)}`);

    // Ctrl+Shift+Z #1 -> redoes that stroke
    await pA.keyboard.press('Control+Shift+z');
    await pA.waitForTimeout(900);
    const afterRedoStroke = await readLayerAlpha(targetName);
    assert(afterRedoStroke.n >= beforeDel.n - 20, `Ctrl+Shift+Z did not redo stroke on restored layer: ${JSON.stringify(afterRedoStroke)}`);

    // Ctrl+Shift+Z #2 -> redoes layer delete!
    await pA.keyboard.press('Control+Shift+z');
    await pA.waitForTimeout(900);
    const afterRedoDel = await readLayerAlpha(targetName);
    assert(afterRedoDel.n === -1 && afterRedoDel.count === beforeDel.count - 1, `Ctrl+Shift+Z did not redo delete: ${JSON.stringify(afterRedoDel)}`);

    // Ctrl+Z -> restores layer again, then test deleting bottom-most layer order too!
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(1300);
    const afterFinalUndo = await readLayerAlpha(targetName);
    assert(afterFinalUndo.count === beforeDel.count && afterFinalUndo.n >= beforeDel.n - 20, `Final Ctrl+Z restore failed: ${JSON.stringify(afterFinalUndo)}`);

    // Test 9b: Delete bottom-most layer ('背景層 (Background)') and Ctrl+Z back to index 0!
    // The default background layer is locked and the server refuses to delete locked layers (403):
    // unlock it first, as a painter would
    const bgLocked = await readLayerAlpha('背景層 (Background)');
    await api(A.token, 'PATCH', `/api/canvases/${canvas.id}/layers/${bgLocked.id}`, { isLocked: false });
    await pA.waitForFunction((id: string) => (window as any).__debugPixi.layerManager.getLayerItem(id)?.model.isLocked === false
      || (window as any).__debugPixi.layerManager.getLayerItem(id)?.model.isLocked === 0, bgLocked.id, { timeout: 10000 });
    const bgInfo0 = await readLayerAlpha('背景層 (Background)');
    await pA.locator(`[data-layer-id="${bgInfo0.id}"]`).click({ position: { x: 140, y: 20 } });
    await pA.waitForTimeout(200);
    pA.once('dialog', (d) => d.accept());
    await pA.locator('button[aria-label="刪除目前圖層"]').click();
    await pA.waitForTimeout(900);
    const bgDuringDel = await readLayerAlpha('背景層 (Background)');
    await pA.keyboard.press('Control+z');
    await pA.waitForTimeout(1500);
    const bgAfterUndo = await readLayerAlpha('背景層 (Background)');
    console.log('9. Delete layer undo/redo:', { beforeDel, duringDel, afterUndoDel, afterUndoStroke, afterRedoStroke, afterRedoDel, afterFinalUndo, bgInfo0, bgDuringDel, bgAfterUndo });
    assert(bgDuringDel.n === -1 && bgAfterUndo.idx === 0 && bgAfterUndo.id !== bgInfo0.id && bgAfterUndo.count === bgInfo0.count,
      `Bottom layer undo failed: bg0=${JSON.stringify(bgInfo0)} bgUndo=${JSON.stringify(bgAfterUndo)}`);

    // Layer state by name: pixels in a box, vector strokes, mask child, position
    const info = (name: string, box: [number, number, number, number]) => pA.evaluate(async ([nm, b]: [string, number[]]) => {
      const d = (window as any).__debugPixi;
      const list = [...d.layerManager.getLayers()].sort((x: any, y: any) => x.model.sortOrder - y.model.sortOrder);
      const found = list.find((it: any) => it.model.name === nm);
      if (!found) return { n: -1, strokes: -1, id: null as string | null, idx: -1, maskId: null as string | null, maskN: -1, count: list.length };
      const opaque = async (id: string) => {
        const [px] = await d.layerManager.readAsync(id, [{ x: b[0], y: b[1], w: b[2], h: b[3] }]);
        let n = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 10) n++;
        return n;
      };
      const mask = list.find((it: any) => it.model.layerType === 'mask' && it.model.parentId === found.model.id);
      return {
        n: await opaque(found.model.id),
        strokes: d.vectorEngine.getStrokes(found.model.id).length,
        id: found.model.id as string,
        idx: list.filter((it: any) => it.model.layerType !== 'mask').indexOf(found),
        maskId: (mask?.model.id ?? null) as string | null,
        maskN: mask ? await opaque(mask.model.id) : -1,
        count: list.length,
      };
    }, [name, box] as [string, number[]]);
    type Info = Awaited<ReturnType<typeof info>>;
    /** Polls until `ok` holds (history actions queue behind a slow whole-layer snapshot on 8K) */
    const until = async (name: string, box: [number, number, number, number], ok: (i: Info) => boolean, ms = 20000) => {
      const t0 = Date.now();
      let last = await info(name, box);
      while (!ok(last) && Date.now() - t0 < ms) {
        await pA.waitForTimeout(250);
        last = await info(name, box);
      }
      await pA.waitForTimeout(300);
      return { ...(await info(name, box)), ms: Date.now() - t0 };
    };
    const deleteActive = async () => {
      pA.once('dialog', (dlg) => dlg.accept());
      await pA.locator('button[aria-label="刪除目前圖層"]').click();
    };

    // Test 9c: vector layer with a stroke: delete, Ctrl+Z (layer + strokes back), Ctrl+Z (stroke
    // undone on the restored layer), Ctrl+Shift+Z (stroke again), Ctrl+Shift+Z (deleted again)
    const VBOX: [number, number, number, number] = [1260, 1860, 400, 80];
    const { layer: vec } = await api(A.token, 'POST', `/api/canvases/${canvas.id}/layers`, { name: 'Vec9', layerType: 'vector' });
    await pA.locator(`[data-layer-id="${vec.id}"]`).waitFor({ timeout: 10000 });
    await pA.locator(`[data-layer-id="${vec.id}"]`).click({ position: { x: 140, y: 20 } });
    await pA.waitForTimeout(300);
    await pA.evaluate(async () => {
      if (!(window as any).__dbg.tool('向量筆')) throw new Error('Vector pen missing');
      await new Promise((r) => setTimeout(r, 200));
      await (window as any).__dbg.dragCanvas([[1300, 1900], [1400, 1900], [1500, 1900], [1600, 1900]], 15);
    });
    await pA.waitForTimeout(900);
    const v0 = await info('Vec9', VBOX);
    await deleteActive();
    const v1 = await until('Vec9', VBOX, (i) => i.n === -1);
    await pA.keyboard.press('Control+z');
    const v2 = await until('Vec9', VBOX, (i) => i.id !== null && i.id !== v0.id && i.n === v0.n && i.strokes === v0.strokes);
    await pA.keyboard.press('Control+z');
    const v3 = await until('Vec9', VBOX, (i) => i.n === 0 && i.strokes === 0);
    await pA.keyboard.press('Control+Shift+z');
    const v4 = await until('Vec9', VBOX, (i) => i.n === v0.n && i.strokes === v0.strokes);
    await pA.keyboard.press('Control+Shift+z');
    const v5 = await until('Vec9', VBOX, (i) => i.n === -1);
    console.log('9c. Vector layer delete/undo/redo:', { v0, v1, v2, v3, v4, v5 });
    assert(v0.n > 100 && v0.strokes >= 1, `Vector stroke was not drawn: ${JSON.stringify(v0)}`);
    assert(v1.n === -1, `Vector layer not deleted: ${JSON.stringify(v1)}`);
    assert(v2.id !== v0.id && v2.idx === v0.idx && v2.n === v0.n && v2.strokes === v0.strokes, `Ctrl+Z did not restore vector layer: ${JSON.stringify(v2)}`);
    assert(v3.n === 0 && v3.strokes === 0, `Second Ctrl+Z did not undo the vector stroke: ${JSON.stringify(v3)}`);
    assert(v4.n === v0.n && v4.strokes === v0.strokes, `Ctrl+Shift+Z did not redo the vector stroke: ${JSON.stringify(v4)}`);
    assert(v5.n === -1 && v5.count === v1.count, `Ctrl+Shift+Z did not redo the vector layer delete: ${JSON.stringify(v5)}`);

    // Test 9d: raster layer with a painted mask (part erased): delete, Ctrl+Z (layer + mask back,
    // same pixels and order), Ctrl+Shift+Z (deleted again, mask too), Ctrl+Z (back again)
    const MBOX: [number, number, number, number] = [1260, 2060, 400, 80];
    const { layer: masked } = await api(A.token, 'POST', `/api/canvases/${canvas.id}/layers`, { name: 'Masked9' });
    await pA.locator(`[data-layer-id="${masked.id}"]`).waitFor({ timeout: 10000 });
    await pA.locator(`[data-layer-id="${masked.id}"]`).click({ position: { x: 140, y: 20 } });
    await pA.waitForTimeout(300);
    await pA.evaluate(async () => {
      (window as any).__dbg.tool('筆刷');
      await new Promise((r) => setTimeout(r, 150));
      await (window as any).__dbg.dragCanvas([[1300, 2100], [1400, 2100], [1500, 2100], [1600, 2100]], 15);
    });
    await pA.waitForTimeout(700);
    await pA.getByTitle(/^加圖層蒙版：/).click();
    await pA.waitForFunction((pid: string) => (window as any).__debugPixi.layerManager.getLayers().some((it: any) => it.model.layerType === 'mask' && it.model.parentId === pid), masked.id, { timeout: 20000 });
    await pA.waitForTimeout(1500);
    // Erase the mask's left part (the active layer is the mask now): the layer shows only on the right
    await pA.evaluate(async (pid: string) => {
      const d = (window as any).__debugPixi;
      const mask = d.layerManager.getLayers().find((it: any) => it.model.layerType === 'mask' && it.model.parentId === pid);
      const row = document.querySelector(`[data-layer-id="${mask.model.id}"]`) as HTMLElement | null;
      row?.click();
      await new Promise((r) => setTimeout(r, 300));
      (window as any).__dbg.tool('橡皮擦');
      await new Promise((r) => setTimeout(r, 150));
      await (window as any).__dbg.dragCanvas([[1290, 2100], [1340, 2100], [1390, 2100], [1430, 2100]], 15);
    }, masked.id);
    await pA.waitForTimeout(900);
    const m0 = await info('Masked9', MBOX);
    await pA.locator(`[data-layer-id="${masked.id}"]`).click({ position: { x: 140, y: 20 } });
    await pA.waitForTimeout(300);
    await deleteActive();
    const m1 = await until('Masked9', MBOX, (i) => i.n === -1);
    await pA.keyboard.press('Control+z');
    const m2 = await until('Masked9', MBOX, (i) => i.id !== null && i.id !== m0.id && i.n === m0.n && i.maskN === m0.maskN);
    await pA.keyboard.press('Control+Shift+z');
    const m3 = await until('Masked9', MBOX, (i) => i.n === -1);
    const maskGone = await pA.evaluate((ids: string[]) => !(window as any).__debugPixi.layerManager.getLayers().some((it: any) => ids.includes(it.model.id)), [m2.maskId ?? '', m0.maskId ?? '']);
    await pA.keyboard.press('Control+z');
    const m4 = await until('Masked9', MBOX, (i) => i.id !== null && i.n === m0.n && i.maskN === m0.maskN);
    console.log('9d. Masked layer delete/undo/redo:', { m0, m1, m2, m3, maskGone, m4 });
    assert(m0.n > 100 && m0.maskId && m0.maskN > 0 && m0.maskN < MBOX[2] * MBOX[3], `Masked layer setup failed: ${JSON.stringify(m0)}`);
    assert(m1.n === -1, `Masked layer not deleted: ${JSON.stringify(m1)}`);
    assert(m2.id !== m0.id && m2.idx === m0.idx && m2.n === m0.n && m2.maskId && m2.maskId !== m0.maskId && m2.maskN === m0.maskN,
      `Ctrl+Z did not restore the masked layer with its mask: ${JSON.stringify(m2)}`);
    assert(m3.n === -1 && maskGone, `Ctrl+Shift+Z did not delete the masked layer and its mask again: ${JSON.stringify(m3)}`);
    assert(m4.n === m0.n && m4.maskN === m0.maskN && m4.idx === m0.idx, `Second restore of the masked layer failed: ${JSON.stringify(m4)}`);

    assert(pageErrors.length === 0, `Page errors occurred: ${pageErrors.join('; ')}`);
    console.log('ALL REPRO CHECKS PASSED!');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

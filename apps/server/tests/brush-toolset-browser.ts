import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, chromium, type Page } from 'playwright-core';

const work = mkdtempSync(join(tmpdir(), 'lumina-brush-toolset-'));
process.env.DATA_DIR = work;
process.env.DATABASE_PATH = join(work, 'test.db');
const client = resolve(__dirname, '../../client');
process.env.CLIENT_DIST_PATH = join(client, 'dist');

function sampledAbr() {
  const size = 32;
  const abr = Buffer.alloc(24 + size * size, 0);
  abr.writeInt16BE(2, 0);
  abr.writeInt16BE(1, 2);
  abr.writeInt16BE(2, 4);
  abr.writeInt32BE(14 + size * size, 6);
  abr.writeInt16BE(size, 18);
  abr.writeInt16BE(size, 20);
  abr.writeInt16BE(8, 22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      abr[24 + y * size + x] = Math.hypot(x - 16, (y - 16) * 1.4) < 12 ? 0 : 255;
    }
  }
  return abr;
}

async function main() {
  const { buildApp } = await import('../dist/app');
  const app = await buildApp();
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const user = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'toolsettest', password: 'brush-toolset-test' } });
    assert.equal(user.statusCode, 201);
    const { token } = user.json();
    const created = await app.inject({
      method: 'POST', url: '/api/canvases', headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Brush toolset check', width: 512, height: 512 },
    });
    assert.equal(created.statusCode, 201);
    const { canvas } = created.json();
    const { canvases } = (await app.inject({ url: '/api/canvases' })).json();
    const rememberedId = canvases.find((entry: { id: string }) => entry.id !== canvas.id).id;
    const desktop = process.env.LUMINA_TEST_DESKTOP;
    let page: Page;
    if (desktop) {
      const [appData, localAppData, userData] = ['appdata', 'localappdata', 'userdata'].map((name) => join(work, name));
      for (const dir of [appData, localAppData, userData]) mkdirSync(dir);
      electron = await _electron.launch({
        executablePath: desktop,
        args: [`--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
        env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData, VITE_DEV_SERVER_URL: '' },
      });
      page = await electron.firstWindow();
    } else {
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        args: ['--enable-unsafe-swiftshader'], headless: true,
      });
      page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
      const guest = await browser.newPage();
      await guest.goto(`${origin}/?room=${canvas.id}`);
      await guest.getByRole('tab', { name: /^Brush toolset check/, selected: true }).waitFor();
      await guest.close();
    }
    await page.addInitScript(({ token, id, origin, desktop }) => {
      localStorage.setItem('atelier_language', 'en-US');
      localStorage.setItem('atelier_token', token);
      localStorage.setItem('atelier_active_canvas_id', id);
      localStorage.setItem('atelier_gateway_resolved', '1');
      localStorage.setItem('atelier_server_url', origin);
      if (!desktop) localStorage.setItem('atelier_session_mode', 'offline');
      if (!localStorage.getItem('brush-e2e-fixture')) {
        localStorage.setItem('brush-e2e-fixture', '1');
        localStorage.setItem('atelier_user_brush_presets', JSON.stringify([{
          id: 'legacy', name: 'Legacy brush', category: 'Legacy', version: '1.0',
          properties: { size: 12, minSize: 1, color: '#fff', opacity: 1, flow: 1, hardness: 0.8, spacing: 0.1, isEraser: false, stabilizerLevel: 0, scatter: 0 },
          createdAt: 1,
        }]));
      }
    }, { token, id: desktop ? canvas.id : rememberedId, origin, desktop: Boolean(desktop) });
    if (electron) await page.reload();
    else await page.goto(`${origin}/?room=${canvas.id}`);
    const toolsetTab = page.getByRole('tab', { name: 'Brush toolset', exact: true });
    const toolProps = page.getByRole('tab', { name: '工具屬性' });
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const locateToolset = () => page.locator('[data-panel="brushToolset"], [data-float-group="brushToolset"]');
    await page.getByRole('tab', { name: /^Brush toolset check/, selected: true }).waitFor();
    await toolsetTab.waitFor();
    await toolProps.click();
    assert.equal(await toolProps.getAttribute('aria-selected'), 'true');
    await toolsetTab.click();
    await button('Legacy brush').waitFor();
    await button('俐落勾線筆 (Crisp Inking Pen)').waitFor();
    await button('濕染水彩筆 (Wet Watercolor)').waitFor();

    const abrArgs = process.argv.indexOf('--abr-files');
    if (abrArgs !== -1) {
      const expectedGroups: [string, number][] = [];
      for (const path of process.argv.slice(abrArgs + 1)) {
        const group = path.split(/[\\/]/).at(-1)!.replace(/\.abr$/i, '');
        const expected = group === '駿恆工具預設集筆刷' ? 225 : 1233;
        await locateToolset().locator('input[type=file]').setInputFiles(path);
        await button(group).waitFor({ timeout: 240_000 });
        await button(group).click();
        assert.equal(await locateToolset().getByRole('button', { name: /^筆刷尖形 #/ }).count(), expected);
        assert.equal(await locateToolset().getByRole('button', { name: /^筆刷尖形 #1 / }).getAttribute('aria-pressed'), 'true');
        expectedGroups.push([group, expected]);
        console.log(`${group}: imported ${expected} brush tips into its own group.`);
      }
      await page.reload();
      await toolsetTab.click();
      for (const [group, expected] of expectedGroups) {
        await button(group).click({ timeout: 120_000 });
        assert.equal(await locateToolset().getByRole('button', { name: /^筆刷尖形 #/ }).count(), expected);
      }
      console.log('Both ABR groups and all tips survived reopening.');
      return;
    }

    if (process.argv.includes('--paint-and-wheel')) {
      const layer = await app.inject({
        method: 'POST', url: `/api/canvases/${canvas.id}/layers`,
        headers: { authorization: `Bearer ${token}` }, payload: { name: 'Airbrush test' },
      });
      const layerId = layer.json().layer.id as string;
      await page.locator(`[data-layer-id="${layerId}"]`).click();
      await button('柔和羽化噴槍 (Soft Airbrush)').click();
      await page.evaluate(() => {
        const { app, viewport } = (window as any).__debugPixi;
        const surface = document.querySelector('.atelier-canvas-viewport')!;
        const rect = app.canvas.getBoundingClientRect();
        for (let i = 0; i <= 54; i++) {
          const first = i === 0, last = i === 54;
          const point = viewport.canvasToScreen(40 + i * 8, 230);
          surface.dispatchEvent(new PointerEvent(first ? 'pointerdown' : last ? 'pointerup' : 'pointermove', {
            bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 12, isPrimary: true,
            clientX: rect.left + point.x, clientY: rect.top + point.y, button: first || last ? 0 : -1,
            buttons: last ? 0 : 1, pressure: last ? 0 : 1,
          }));
        }
      });
      await page.waitForFunction(() => (window as any).__debugPixi.undo.getUndoCount() === 1);
      const profile = await page.evaluate(async id => {
        const w = 64;
        const { layerManager } = (window as any).__debugPixi;
        const [pixels] = await layerManager.readAsync(id, [{ x: 226, y: 230, w, h: 62 }]);
        return Array.from({ length: 62 }, (_, y) => {
          let sum = 0;
          for (let x = 0; x < w; x++) sum += pixels[(y * w + x) * 4 + 3];
          return Math.round(sum / w);
        });
      }, layerId);
      console.log('Airbrush radial alpha:', profile.join(','));
      assert.ok(profile[0] >= 35, 'The stroke has a visible centre');
      assert.equal(profile.at(-1), 0, 'The outside of the stroke is transparent');
      assert.ok(profile[48] >= 2, 'Fine coverage persists where 8-bit dab rounding used to cut off the tail');
      assert.ok(profile.slice(1).every((alpha, i) => alpha <= profile[i] && profile[i] - alpha <= 4),
        'The stroke fades monotonically without large alpha steps');

      const surface = page.locator('.atelier-canvas-viewport');
      const wheel = page.locator('.atelier-wheel-spin');
      for (const reducedMotion of ['no-preference', 'reduce', 'no-preference'] as const) {
        await page.emulateMedia({ reducedMotion });
        await surface.click({ button: 'right' });
        await wheel.waitFor();
        const animation = await wheel.evaluate(el => ({
          name: getComputedStyle(el).animationName,
          keyframes: el.getAnimations()[0]?.effect instanceof KeyframeEffect
            ? (el.getAnimations()[0].effect as KeyframeEffect).getKeyframes().length
            : 0,
        }));
        assert.equal(animation.name, reducedMotion === 'reduce' ? 'atelierWheelFadeIn' : 'atelierWheelSpinIn');
        assert.ok(animation.keyframes >= 2, `Wheel should animate when reopened (${reducedMotion})`);
        await page.keyboard.press('Escape');
        await wheel.waitFor({ state: 'detached' });
      }
      console.log('Airbrush gradient and right-click wheel opening verified with both motion preferences.');
      return;
    }

    await button('New group').click();
    await page.getByRole('textbox', { name: 'New group' }).fill('Inking');
    await page.getByRole('textbox', { name: 'New group' }).press('Enter');
    await button('Inking').waitFor();
    await button('All Brushes').click();
    await button('Legacy brush').dragTo(button('Inking'));
    await button('Legacy brush').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename brush' }).click();
    const rename = page.getByRole('textbox', { name: 'Rename brush' });
    await rename.fill('Ink line');
    await rename.press('Enter');
    await button('Ink line').click();
    assert.equal(await button('Ink line').getAttribute('aria-pressed'), 'true');
    await button('Ink line').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate brush' }).click();
    await button('Ink line copy').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete Brush', exact: false }).click();
    await button('Ink line copy').waitFor({ state: 'detached' });
    await button('Legacy').click();
    await button('Legacy brush').waitFor();
    assert.equal(await button('Ink line').count(), 0);

    await button('Inking').click();
    await locateToolset().locator('input[type=file]').setInputFiles({ name: 'sampled.abr', mimeType: 'application/octet-stream', buffer: sampledAbr() });
    await button('sampled').waitFor();
    await button('PS Brush #1 (32x32)').waitFor();
    await button('sampled').click({ button: 'right' });
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('menuitem', { name: 'Delete group', exact: true }).click();
    await button('PS Brush #1 (32x32)').waitFor();
    await button('sampled').click({ button: 'right' });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('menuitem', { name: 'Delete group', exact: true }).click();
    await button('sampled').waitFor({ state: 'detached' });
    assert.equal(await button('PS Brush #1 (32x32)').count(), 0);
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('lumina_brush_library');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('library', 'readwrite');
        const store = tx.objectStore('library');
        for (const [id, name] of [['preset_csp_gpen', '經典 G 筆 (G-Pen)'], ['preset_csp_watercolor', 'My personal wash']]) {
          const request = store.get(`brush/${id}`);
          request.onsuccess = () => store.put({ ...request.result, name }, `brush/${id}`);
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    });
    await page.reload();
    assert.equal(await button('sampled').count(), 0);
    await button('俐落勾線筆 (Crisp Inking Pen)').waitFor();
    await button('My personal wash').waitFor();
    await button('Inking').click();
    await button('Ink line').waitFor();
    await locateToolset().getByRole('button', { name: '面板位置' }).click();
    await page.getByRole('menuitemradio', { name: '浮動視窗' }).click();
    await page.locator('[data-float-group="brushToolset"]').waitFor();
    await button('Inking').click();
    await button('Ink line').waitFor();
    const screenshot = join(work, 'brush-toolset.png');
    await page.screenshot({ path: screenshot });
    console.log(`Brush toolset verified in ${desktop ? 'packaged Electron' : 'Chrome'} at ${origin}: ${screenshot}`);
  } finally {
    await electron?.close();
    await browser?.close();
    await app.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { RoomMemberInfo } from '@atelier/shared';
import { chromium } from 'playwright-core';
import { roomMemberCards } from '../../client/src/utils/roomMembers';
import { RulerManager } from '../../client/src/engine/RulerManager';

const origins = ['http://localhost:3100', 'http://localhost:3101'];
const password = 'browser-test-password';

async function main() {
  const connection: RoomMemberInfo = {
    socketId: 'idle-tab', userId: 'one-account', displayName: 'Painter', isGuest: false,
    serverRole: 'admin', joinedAt: 1, presence: 'idle',
  };
  const awake = { ...connection, socketId: 'awake-tab', presence: 'online' as const };
  const guests = ['guest-a', 'guest-b'].map((socketId) => ({ ...connection, socketId, isGuest: true }));
  assert.deepEqual(roomMemberCards([connection, awake, ...guests]).map((member) => member.socketId), ['awake-tab', 'guest-a', 'guest-b']);
  assert.equal(roomMemberCards([connection])[0].presence, 'idle');
  console.log('Presence: one card per account, active tab preferred, guests remain independent');

  const ruler = RulerManager.getInstance();
  ruler.initDimensions(1000, 800);
  ruler.setMode('perspective');
  ruler.updatePerspective({ vp1: { x: 0, y: 400 }, vp2: { x: 1000, y: 400 } });
  ruler.onStrokeStart({ x: 500, y: 700 });
  assert.equal(ruler.snapPoint({ x: 450, y: 670 }).axisLabel, 'VP1');
  assert.equal(ruler.snapPoint({ x: 550, y: 670 }).axisLabel, 'VP1', 'direction stays locked during the stroke');
  ruler.onStrokeEnd();
  ruler.updatePerspective({ vp2: { x: 1020, y: 410 } });
  assert.equal(ruler.state.perspective.vp1.y, 410);
  ruler.setMode('symmetry');
  ruler.updateSymmetry({ mode: '2-axis', axesCount: 2 });
  assert.equal(ruler.getSymmetryPoints({ x: 250, y: 250 }).length, 4);
  console.log('Rulers: perspective direction stays locked, vanishing points share the horizon, two axes mirror into four quadrants');
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'lumina-workflow-'));
  const { buildApp } = await import('../src/app');
  const { config } = await import('../src/config');
  config.jwtSecret = 'round-11-first-test-server';
  const first = await buildApp();
  config.jwtSecret = 'round-11-second-test-server';
  const second = await buildApp();
  const apps = [first, second];

  async function call(app: FastifyInstance, method: InjectOptions['method'], url: string, token?: string, payload?: object) {
    const response = await app.inject({ method, url, headers: token ? { Authorization: 'Bearer ' + token } : {}, payload });
    assert.ok(response.statusCode < 300, `${method} ${url}: ${response.body}`);
    return response.json();
  }

  const owner = await call(first, 'POST', '/api/auth/register', undefined, { username: 'folderowner', password });
  const painter = await call(first, 'POST', '/api/auth/register', undefined, { username: 'firstpainter', password });
  const remote = await call(second, 'POST', '/api/auth/register', undefined, { username: 'secondpainter', password });
  const { canvas } = await call(first, 'POST', '/api/canvases', owner.token, { title: 'Round 11 Studio', width: 512, height: 512 });
  const layerUrl = `/api/canvases/${canvas.id}/layers`;
  const { layer: root } = await call(first, 'POST', layerUrl, painter.token, { name: 'My root layer' });
  const { layer: group } = await call(first, 'POST', layerUrl, owner.token, { name: 'Ordinary folder', layerType: 'group' });
  const { layer: animation } = await call(first, 'POST', layerUrl, owner.token, {
    name: 'Private animation', layerType: 'group', meta: { animation: { fps: 12 } },
  });
  for (const folder of [group, animation]) {
    const url = `${layerUrl}/${folder.id}/folder-access`;
    await call(first, 'POST', url, painter.token);
    await call(first, 'PATCH', `${url}/${painter.user.id}`, owner.token, { approved: true });
  }
  assert.equal((await second.inject({ url: '/api/auth/me', headers: { Authorization: 'Bearer ' + painter.token } })).statusCode, 401);

  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(({ token, canvasId }) => {
      (window as any).__name = (f: unknown) => f;
      const audio = { notes: 0, input: '', output: '' };
      (window as any).testAudio = audio;
      const media = navigator.mediaDevices;
      const capture = media.getUserMedia.bind(media);
      media.getUserMedia = (constraints) => {
        const device = typeof constraints?.audio === 'object' ? constraints.audio.deviceId : null;
        if (device && typeof device === 'object' && 'exact' in device && typeof device.exact === 'string') audio.input = device.exact;
        return capture({ audio: true });
      };
      media.enumerateDevices = async () => ([
        { kind: 'audioinput', deviceId: 'second-microphone', label: 'Second Microphone' },
        { kind: 'audiooutput', deviceId: 'second-speaker', label: 'Second Output' },
      ] as MediaDeviceInfo[]);
      Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: async (id: string) => { audio.output = id; } });
      const startTone = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (when) { audio.notes++; return startTone.call(this, when); };
      if (sessionStorage.getItem('test_initialized')) return;
      sessionStorage.setItem('test_initialized', 'true');
      localStorage.setItem('atelier_token', token);
      localStorage.setItem('atelier_gateway_resolved', 'true');
      localStorage.setItem('atelier_active_canvas_id', canvasId);
      localStorage.setItem('atelier_language', 'en-US');
      localStorage.setItem('atelier_ui_scale', '1.3');
    }, { token: painter.token, canvasId: canvas.id });
    await page.routeWebSocket(/\/socket\.io\//, (socket) => {
      socket.send('0{"sid":"round11-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
      socket.onMessage((message) => {
        if (typeof message !== 'string') return;
        if (message.startsWith('40')) socket.send('40{"sid":"round11-socket"}');
        if (message.startsWith('42["join_canvas"')) socket.send('42' + JSON.stringify(['room_state', {
          canvasId: canvas.id, latestSeq: 0, members: [connection, awake], offlineMembers: [],
        }]));
      });
    });
    await page.route('http://localhost:31*/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const app = apps[origins.indexOf(url.origin)];
      if (!app) return route.abort();
      const res = await app.inject({ method: request.method() as InjectOptions['method'], url: url.pathname + url.search,
        headers: request.headers(), payload: request.postDataBuffer() ?? undefined });
      const headers = Object.fromEntries(Object.entries(res.headers).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
      await route.fulfill({ status: res.statusCode, headers, body: res.rawPayload });
    });
    await page.goto(origins[0]);
    const row = (id: string) => page.locator(`[data-layer-id="${id}"]`);
    await row(root.id).waitFor();
    await page.getByText('firstpainter', { exact: true }).first().waitFor();
    const layerModels = () => call(first, 'GET', layerUrl, painter.token).then((data) => data.layers as any[]);
    const waitChange = async (action: () => Promise<unknown>, before: string[], mode: 'add' | 'remove') => {
      await action();
      for (let i = 0; i < 80; i++) {
        const current = await layerModels();
        if (mode === 'add') {
          const added = current.find((layer) => !before.includes(layer.id));
          if (added) { await row(added.id).waitFor({ state: 'attached' }); return added; }
        } else if (before.every((id) => !current.some((layer) => layer.id === id))) {
          await row(before[0]).waitFor({ state: 'detached' });
          return null;
        }
        await page.waitForTimeout(80);
      }
      throw new Error(`Layer did not ${mode}`);
    };

    const checkHistory = async (create: () => Promise<unknown>, parentId: string | null) => {
      const before = (await layerModels()).map((layer) => layer.id);
      const added = await waitChange(create, before, 'add');
      assert.equal(added.parentId, parentId);
      await waitChange(() => page.keyboard.press('Control+z'), [added.id], 'remove');
      const restored = await waitChange(() => page.keyboard.press('Control+Shift+z'), before, 'add');
      assert.equal(restored.name, added.name);
      assert.equal(restored.parentId, parentId);
    };
    const newRaster = () => page.getByRole('button', { name: 'New Raster Layer', exact: true }).click();
    await row(root.id).click();
    await checkHistory(newRaster, null);
    await row(group.id).click();
    await page.getByText('Folder access granted', { exact: true }).waitFor();
    await checkHistory(newRaster, group.id);
    await row(animation.id).click();
    await page.keyboard.press('Control+Shift+a');
    await checkHistory(() => page.getByRole('button', { name: 'New Cel', exact: true }).click(), animation.id);
    const slider = page.getByRole('slider', { name: /frame|timeline/i });
    const firstFrame = await slider.locator('span').filter({ hasText: /^1$/ }).boundingBox();
    const playhead = await page.locator('[data-playhead]').boundingBox();
    assert.ok(firstFrame && playhead && Math.abs(playhead.x - firstFrame.x) < 1, 'playhead and frame label align at 130% scale');
    console.log('Chrome: create / Ctrl+Z / Ctrl+Shift+Z passed at root, in an approved ordinary folder and in an approved animation folder; timeline aligned at 130%');

    await page.getByTitle('Online Artists', { exact: true }).click();
    const roster = page.getByRole('region', { name: 'Online Members' });
    await roster.locator('[data-presence="online"]').waitFor();
    assert.equal(await roster.getByText('Painter', { exact: true }).count(), 1);
    assert.equal(await roster.locator('[data-presence="idle"]').count(), 0);
    await page.getByTitle('Online Artists', { exact: true }).click();
    await page.getByTitle('Join Voice Chat', { exact: true }).click();
    await page.getByTitle('Leave Voice Chat', { exact: true }).waitFor();
    await page.getByTitle('Audio devices', { exact: true }).click();
    await page.getByLabel('Microphone', { exact: true }).selectOption('second-microphone');
    await page.waitForFunction(() => (window as any).testAudio.input === 'second-microphone');
    await page.getByLabel('Audio output', { exact: true }).selectOption('second-speaker');
    await page.waitForFunction(() => (window as any).testAudio.output === 'second-speaker');
    await page.getByTitle('Mute Mic', { exact: true }).click();
    await page.getByTitle('Unmute Mic', { exact: true }).click();
    await page.getByTitle('Leave Voice Chat', { exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).testAudio.notes), 8, 'two notes for each of join, mute, unmute, leave');
    console.log('Chrome: multi-connection member card, simulated microphone and output switching, all four voice cues');

    const gateway = () => page.getByRole('button', { name: /Lumina Drift.*Return to Gateway/ }).click();
    const switchTo = async (origin: string) => {
      await gateway();
      if (origin === origins[1]) {
        await page.getByRole('button', { name: 'Internet', exact: true }).click();
        await page.getByRole('textbox', { name: 'Server URL' }).fill(origin);
      } else await page.getByRole('button', { name: 'This Server', exact: true }).click();
      await page.getByRole('button', { name: /^Join "/ }).click();
    };
    await switchTo(origins[1]);
    const modal = page.getByRole('dialog');
    const username = modal.getByRole('textbox', { name: 'Username' });
    await username.fill(remote.user.username);
    assert.equal(await modal.getByRole('checkbox', { name: 'Remember username' }).isChecked(), true);
    await modal.getByLabel('Password', { exact: true }).fill(password);
    await modal.getByRole('button', { name: 'Sign In', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    await switchTo(origins[0]);
    await page.getByText('firstpainter', { exact: true }).first().waitFor();
    await switchTo(origins[1]);
    await page.getByText('secondpainter', { exact: true }).first().waitFor();
    assert.equal(await modal.isVisible(), false);
    const storage = await page.evaluate(([a, b]) => ({
      first: Boolean(localStorage.getItem(`atelier_token:${a}`)),
      second: Boolean(localStorage.getItem(`atelier_token:${b}`)),
      remembered: localStorage.getItem(`atelier_remembered_username:${b}`),
      legacy: localStorage.getItem('atelier_token'),
    }), origins);
    assert.deepEqual(storage, { first: true, second: true, remembered: 'secondpainter', legacy: null });
    await page.evaluate(([a, b]) => localStorage.setItem(`atelier_token:${b}`, localStorage.getItem(`atelier_token:${a}`)!),
      origins);
    await page.reload();
    await page.waitForFunction((origin) => !localStorage.getItem(`atelier_token:${origin}`), origins[1]);
    await page.getByRole('button', { name: 'Sign In / Register' }).click();
    assert.equal(await username.inputValue(), 'secondpainter');
    assert.equal(await modal.getByLabel('Password', { exact: true }).inputValue(), '');
    await modal.getByRole('checkbox', { name: 'Remember username' }).uncheck();
    await modal.getByLabel('Password', { exact: true }).fill(password);
    await modal.getByRole('button', { name: 'Sign In', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(([a, b]) => [
      Boolean(localStorage.getItem(`atelier_token:${a}`)), localStorage.getItem(`atelier_remembered_username:${b}`),
    ], origins), [true, null]);
    console.log('Chrome: legacy session migrated; two server origins restored their own accounts and remembered username');
  } finally {
    await browser.close();
    await Promise.all(apps.map((app) => app.close()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

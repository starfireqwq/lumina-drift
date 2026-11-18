import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, chromium, type Page } from 'playwright-core';

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'lumina-voice-'));
  process.env.DATA_DIR = join(work, 'server');
  process.env.DATABASE_PATH = join(work, 'server', 'atelier.db');
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin123';
  const { buildApp } = await import('../dist/app');
  const app = await buildApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const post = async (url: string, payload: object, token?: string) => {
      const response = await app.inject({ method: 'POST', url, payload,
        headers: token ? { authorization: `Bearer ${token}` } : {} });
      assert.ok(response.statusCode < 300, response.body);
      return response.json();
    };
    const alice = await post('/api/auth/register', { username: 'alice', password: 'voice-roster-test' });
    const moderator = await post('/api/auth/login', { username: 'admin', password: 'admin123' });
    const { canvas } = await post('/api/canvases', { title: 'Voice room', width: 512, height: 512 }, alice.token);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });

    async function open(token: string, executablePath?: string) {
      let page: Page;
      if (executablePath) {
        const [appdata, localAppdata, userData] = ['appdata', 'localappdata', 'userdata'].map(name => join(work, name));
        for (const dir of [appdata, localAppdata, userData]) mkdirSync(dir);
        desktop = await _electron.launch({ executablePath, args: [`--user-data-dir=${userData}`, '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
          env: { ...process.env, APPDATA: appdata, LOCALAPPDATA: localAppdata } });
        page = await desktop.firstWindow();
      } else {
        page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
      }
      page.on('dialog', async dialog => {
        console.error('Unexpected browser dialog:', dialog.message());
        await dialog.dismiss();
      });
      page.on('console', message => {
        if (message.type() === 'error') console.error(message.text());
      });
      page.on('pageerror', error => console.error(error.message));
      await page.addInitScript(({ token, canvasId, origin }) => {
        (window as any).__name = (value: unknown) => value;
        localStorage.setItem('atelier_language', 'zh-TW');
        localStorage.setItem('atelier_token', token);
        localStorage.setItem('atelier_active_canvas_id', canvasId);
        localStorage.setItem('atelier_gateway_resolved', '1');
        localStorage.setItem('atelier_server_url', origin);
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          const tone = context.createOscillator();
          const volume = context.createGain();
          const mic = context.createMediaStreamDestination();
          volume.gain.value = 0;
          tone.connect(volume);
          volume.connect(mic);
          tone.start();
          void context.resume();
          Object.assign(window, { setVoiceTestTone: (enabled: boolean) => { volume.gain.value = enabled ? 0.12 : 0; } });
          return mic.stream;
        };
      }, { token, canvasId: canvas.id, origin });
      if (executablePath) await page.reload();
      else await page.goto(origin);
      await page.waitForFunction(() => Boolean((window as any).__debugPixi?.layerManager));
      await page.getByRole('button', { name: '即時聊天室', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '即時聊天室' });
      await dialog.getByRole('button', { name: '加入語音', exact: true }).click();
      await dialog.getByRole('button', { name: /語音房間已連接/ }).click();
      return { page, dialog };
    }

    const first = await open(alice.token, process.env.LUMINA_TEST_DESKTOP);
    await first.dialog.getByRole('button', { name: /語音房間已連接 1人/ }).waitFor({ timeout: 6000 });
    const second = await open(alice.token);
    const row = (client: typeof first, userId: string) => client.dialog.locator(`[data-voice-user="${userId}"]`);
    const state = async (client: typeof first, userId: string, text: string) =>
      row(client, userId).getByText(text, { exact: true }).waitFor({ timeout: 6000 });
    const tone = (client: typeof first, enabled: boolean) =>
      client.page.evaluate((value) => (window as any).setVoiceTestTone(value), enabled);
    await state(first, alice.user.id, '麥克風開啟');
    await tone(first, true);
    await state(first, alice.user.id, '發話中…');
    const listener = await open(moderator.token);
    for (const { dialog } of [first, second, listener]) {
      await dialog.getByRole('button', { name: /語音房間已連接 2人/ }).waitFor({ timeout: 6000 });
    }
    assert.equal(await row(listener, alice.user.id).count(), 1);
    await state(listener, alice.user.id, '發話中…');
    const waves = row(listener, alice.user.id).locator('span[aria-hidden="true"] > span');
    assert.deepEqual(await waves.evaluateAll(bars => bars.map(bar => getComputedStyle(bar).animationName)),
      ['voiceWave', 'voiceWave', 'voiceWave']);
    await tone(first, false);
    await state(listener, alice.user.id, '麥克風開啟');
    await tone(second, true);
    await state(listener, alice.user.id, '發話中…');
    await second.dialog.getByTitle('靜音麥克風', { exact: true }).click();
    await state(second, alice.user.id, '靜音中');
    await state(listener, alice.user.id, '麥克風開啟');
    await second.dialog.getByRole('button', { name: '離開', exact: true }).click();
    await first.dialog.getByRole('button', { name: /語音房間已連接 2人/ }).waitFor({ timeout: 6000 });
    await tone(first, true);
    await state(listener, alice.user.id, '發話中…');
    await row(listener, alice.user.id).getByRole('button', { name: '閉麥' }).click();
    await state(listener, alice.user.id, '靜音中');
    await state(first, alice.user.id, '靜音中');
    await row(listener, alice.user.id).getByRole('button', { name: '踢出' }).click();
    await first.dialog.getByRole('button', { name: '加入語音', exact: true }).waitFor();
    await listener.dialog.getByRole('button', { name: /語音房間已連接 1人/ }).waitFor({ timeout: 6000 });
    console.log('Voice roster, same-account connections, live waveform, late join, silence, mute, leave and moderation passed.');
  } finally {
    await desktop?.close();
    await browser?.close();
    await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireServer = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { chromium, _electron } = requireServer('playwright-core');
const dist = path.resolve(process.argv[2] || path.join(__dirname, '../dist'));
const chrome = process.env.LUMINA_TEST_CHROME;
const electronApp = process.env.LUMINA_TEST_ELECTRON_APP;
const electronExecutable = process.env.LUMINA_TEST_ELECTRON_EXE;
const samplePath = path.join(dist, 'plugins/studio-tools.lumina-plugin');

async function check(page) {
  await page.getByRole('button', { name: /Solo Offline Drawing/ }).click();
  await page.getByRole('button', { name: 'Start Solo Drawing', exact: true }).click();
  await page.locator('[data-canvas-presented="true"]').waitFor();
  const menu = () => page.getByRole('button', { name: 'Plugins', exact: true }).click();
  const manage = async () => {
    await menu();
    await page.getByRole('menuitem', { name: 'Manage Plugins…' }).click();
    return page.getByRole('dialog', { name: 'Manage Plugins' });
  };
  const close = async (dialog) => {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  };
  const command = async (name) => {
    await menu();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };

  let dialog = await manage();
  await dialog.locator('input[type=file]').setInputFiles(samplePath);
  await dialog.getByRole('button', { name: 'Install Plugin', exact: true }).click();
  const pluginRow = dialog.locator('section').filter({ hasText: 'Studio Tools' });
  await pluginRow.getByRole('button', { name: 'Enable', exact: true }).waitFor();
  await close(dialog);
  await menu();
  assert.equal(await page.getByRole('menuitem', { name: 'Blue Inking Brush' }).count(), 0);
  await page.keyboard.press('Escape');

  dialog = await manage();
  await dialog.locator('section').filter({ hasText: 'Studio Tools' }).getByRole('button', { name: 'Enable', exact: true }).click();
  await close(dialog);
  await command('Blue Inking Brush');
  await page.waitForFunction(() => [...document.querySelectorAll('input[aria-label="HEX Code"]')].some(input => input.value.toUpperCase() === '#387BE8'));
  await command('New Sketch Layer');
  await page.getByText('Plugin Sketch', { exact: true }).first().waitFor();
  await command('Create Cool Swatches');
  await page.waitForFunction(async () => {
    const { layerManager } = window.__debugPixi;
    const layer = layerManager.getLayers().find(item => item.model.name === 'Cool Swatches');
    if (!layer) return false;
    const [pixel] = await layerManager.readAsync(layer.model.id, [{ x: 1024, y: 1024, w: 1, h: 1 }]);
    return pixel[0] === 56 && pixel[1] === 123 && pixel[2] === 232 && pixel[3] === 255;
  });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !window.__debugPixi.layerManager.getLayers().some(item => item.model.name === 'Cool Swatches'));
  await page.keyboard.press('Control+Shift+z');
  await page.getByText('Cool Swatches', { exact: true }).first().waitFor();

  // The VM receives only explicit context, accepts no undeclared actions, and has a time limit.
  const testPlugin = {
    apiVersion: 1, id: 'test.fixture', name: 'Runtime Fixture', version: '1', author: 'Test',
    permissions: [], commands: ['isolation', 'forbidden', 'loop'].map(id => ({ id, label: id })),
    script: `function run(command) {
      if (command === 'loop') { while (true) {} }
      if (command === 'forbidden') return { kind: 'layer', name: 'Unauthorized layer' };
      return { kind: 'message', text: [typeof fetch, typeof document, typeof localStorage, typeof require].join(',') };
    }`,
  };
  dialog = await manage();
  const attachFixture = () => dialog.locator('input[type=file]').setInputFiles({
    name: 'fixture.lumina-plugin', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(testPlugin)),
  });
  await attachFixture();
  await dialog.getByRole('button', { name: 'Install Plugin', exact: true }).click();
  const fixture = dialog.locator('section').filter({ hasText: 'Runtime Fixture' });
  await fixture.getByRole('button', { name: 'Enable', exact: true }).click();
  await close(dialog);
  await command('isolation');
  await page.getByText('undefined,undefined,undefined,undefined', { exact: true }).waitFor();
  await command('forbidden');
  await page.getByText(/Missing permission: layers/).waitFor();
  assert.equal(await page.getByText('Unauthorized layer', { exact: true }).count(), 0);
  await command('loop');
  await page.getByText(/execution limit|timed out/).waitFor();

  await page.reload();
  await page.locator('[data-canvas-presented="true"]').waitFor();
  await command('isolation');
  await page.getByText('undefined,undefined,undefined,undefined', { exact: true }).waitFor();
  dialog = await manage();
  await attachFixture();
  await dialog.getByRole('button', { name: 'Replace Plugin', exact: true }).click();
  await fixture.getByRole('button', { name: 'Enable', exact: true }).waitFor();
  await fixture.getByRole('button', { name: 'Remove', exact: true }).click();
  await fixture.waitFor({ state: 'detached' });
  await close(dialog);
}

async function main() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end('{"status":"ok"}');
    }
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, desktop;
  try {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1500, height: 950 } });
    await page.goto(origin);
    await check(page);
    console.log('Chrome: plugin import, menu, brush, layer, artwork pixels and undo/redo, permission rejection, deadline, persistence, replacement and removal passed.');

    if (electronApp && electronExecutable) {
      const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lumina-plugin-profile-'));
      for (const part of ['roaming', 'local', 'user', 'data']) fs.mkdirSync(path.join(profile, part));
      desktop = await _electron.launch({
        executablePath: electronExecutable,
        args: [electronApp, '--lang=en-US', '--user-data-dir=' + path.join(profile, 'user')],
        env: { ...process.env, APPDATA: path.join(profile, 'roaming'), LOCALAPPDATA: path.join(profile, 'local'),
          DATA_DIR: path.join(profile, 'data'), DATABASE_PATH: path.join(profile, 'data', 'test.db'), PORT: '0',
          LUMINA_TEST_ORIGIN: origin },
      });
      const window = await desktop.firstWindow();
      await window.route('http://127.0.0.1:3000/**', route => route.abort());
      await window.evaluate(() => localStorage.setItem('atelier_language', 'en-US'));
      await window.reload();
      await check(window);
      console.log('Isolated Electron (file origin): all plugin flows passed.');
    }
  } finally {
    await desktop?.close();
    await browser?.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

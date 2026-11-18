const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireServer = createRequire(path.resolve(__dirname, '../../server/package.json'));
const { _electron } = requireServer('playwright-core');

async function main() {
  assert.ok(process.env.APPDATA && process.env.LOCALAPPDATA && process.env.LUMINA_PROFILE);
  const app = await _electron.launch({
    executablePath: process.argv[2],
    args: ['--user-data-dir=' + process.env.LUMINA_PROFILE, '--lang=en-US'],
    timeout: 30_000,
  });
  try {
    const window = await app.firstWindow({ timeout: 20_000 });
    await window.waitForLoadState('domcontentloaded');
    assert.ok(window.url().startsWith('file:'), 'Expected the packaged renderer.');
    await window.evaluate(() => localStorage.setItem('atelier_language', 'en-US'));
    await window.reload();
    await window.getByRole('button', { name: /Solo Offline Drawing/ }).waitFor({ timeout: 20_000 });
    console.log('Packaged Lumina Drift opened the desktop launch screen.');
  } finally {
    const child = app.process();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        // On macOS closing the last window leaves the application running.
        void app.evaluate(({ app }) => { setImmediate(() => app.quit()); }).catch(() => {});
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

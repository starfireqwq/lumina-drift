import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');
const outServerDir = path.resolve(__dirname, '../resources/server');
const outDistDir = path.join(outServerDir, 'dist');

fs.mkdirSync(outDistDir, { recursive: true });
fs.writeFileSync(path.join(outDistDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));

// 1. Locate esbuild binary in workspace node_modules
function findFile(base, filterFn) {
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (filterFn(full, e.name)) {
        return full;
      }
    }
  }
  return null;
}

const pnpmDir = path.join(rootDir, 'node_modules/.pnpm');
const esbuildPlatform = `${process.platform}-${process.arch}`;
const esbuildBinary = process.platform === 'win32'
  ? path.join('@esbuild', esbuildPlatform, 'esbuild.exe')
  : path.join('@esbuild', esbuildPlatform, 'bin', 'esbuild');
const esbuildExe = findFile(pnpmDir, (full) => full.endsWith(esbuildBinary) && fs.statSync(full).isFile());
if (!esbuildExe) {
  throw new Error(`Missing the esbuild binary for ${esbuildPlatform}. Install dependencies on the build platform first.`);
}

console.log('[bundle-server] Bundling apps/server/src/server.ts with esbuild...');
execFileSync(
  esbuildExe,
  [
    path.join(rootDir, 'apps/server/src/server.ts'),
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=cjs',
    '--external:better-sqlite3',
    '--external:@node-rs/argon2*',
    `--outfile=${path.join(outDistDir, 'server.js')}`,
  ],
  { stdio: 'inherit' }
);

for (const worker of ['checkpoint', 'share-preview']) {
  console.log(`[bundle-server] Bundling ${worker} worker with esbuild...`);
  execFileSync(
  esbuildExe,
  [
    path.join(rootDir, `apps/server/src/services/${worker}.worker.ts`),
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=cjs',
    '--external:better-sqlite3',
    '--external:@node-rs/argon2*',
    `--outfile=${path.join(outDistDir, `${worker}.worker.js`)}`,
  ],
  { stdio: 'inherit' }
  );
}

// 2. Copy better-sqlite3 JS wrapper and @node-rs/argon2 N-API module
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

const sqlitePkgDir = path.dirname(
  findFile(pnpmDir, (f, n) => n === 'package.json' && f.includes('better-sqlite3@') && f.endsWith(path.join('better-sqlite3', 'package.json')))
);
const argonPkgDir = path.dirname(
  findFile(pnpmDir, (f, n) => n === 'package.json' && f.includes('@node-rs+argon2@') && f.endsWith(path.join('@node-rs', 'argon2', 'package.json')))
);
const argonNativeName = `argon2-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : ''}`;
const argonNativeManifest = findFile(pnpmDir, (f, n) => n === 'package.json' &&
  f.endsWith(path.join('@node-rs', argonNativeName, 'package.json')));
if (!argonNativeManifest) throw new Error(`Missing @node-rs/${argonNativeName}. Install dependencies on the build platform first.`);
const argonNativeDir = path.dirname(argonNativeManifest);

const nmDir = path.join(outServerDir, 'node_modules');
const outSqliteDir = path.join(nmDir, 'better-sqlite3');
for (const stale of ['build', 'node_modules', 'prebuilds']) {
  fs.rmSync(path.join(outSqliteDir, stale), { recursive: true, force: true });
}
copyDirSync(path.join(sqlitePkgDir, 'lib'), path.join(outSqliteDir, 'lib'));
fs.copyFileSync(path.join(sqlitePkgDir, 'package.json'), path.join(outSqliteDir, 'package.json'));

copyDirSync(argonPkgDir, path.join(nmDir, '@node-rs/argon2'));
copyDirSync(argonNativeDir, path.join(nmDir, '@node-rs', argonNativeName));

// 3. Copy ABI-independent N-API prebuild(s) from better-sqlite3 >= 13 (or fallback cleanly if missing)
const sqlitePrebuildsSrc = path.join(sqlitePkgDir, 'prebuilds');
const sqlitePrebuildsDest = path.join(outSqliteDir, 'prebuilds');
fs.mkdirSync(sqlitePrebuildsDest, { recursive: true });
const copiedPrebuilds = [];
if (fs.existsSync(sqlitePrebuildsSrc)) {
  const candidates = process.platform === 'linux'
    ? [`linux-${process.arch}.node`, `linuxmusl-${process.arch}.node`]
    : [`${process.platform}-${process.arch}.node`];
  for (const file of candidates) {
    const srcFile = path.join(sqlitePrebuildsSrc, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(sqlitePrebuildsDest, file));
      copiedPrebuilds.push(file);
    }
  }
}
if (!copiedPrebuilds.length) {
  throw new Error(`Missing better-sqlite3 N-API prebuild for ${process.platform}-${process.arch} in ${sqlitePrebuildsSrc}`);
}
console.log(`[bundle-server] Copied better-sqlite3 N-API prebuild(s): ${copiedPrebuilds.join(', ')}`);

// 4. Copy cloudflared.exe to resources/cloudflared.exe if present in workspace root
const rootCloudflared = path.join(rootDir, 'cloudflared.exe');
const destCloudflared = path.resolve(__dirname, '../resources/cloudflared.exe');
if (fs.existsSync(rootCloudflared) && !fs.existsSync(destCloudflared)) {
  fs.copyFileSync(rootCloudflared, destCloudflared);
  console.log(`[bundle-server] Copied cloudflared.exe to resources/cloudflared.exe`);
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractTarFile(tarBuf, targetSuffix) {
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal || '0', 8);
    const dataStart = offset + 512;
    if (name.endsWith(targetSuffix) && size > 0) {
      return tarBuf.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

if (process.platform === 'darwin') {
  const tunnelBinary = path.resolve(__dirname, '../resources/cloudflared');
  const tunnelArchive = await downloadBuffer(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`);
  const executable = extractTarFile(zlib.gunzipSync(tunnelArchive), 'cloudflared');
  if (!executable) throw new Error('cloudflared was not found in the macOS archive.');
  fs.writeFileSync(tunnelBinary, executable, { mode: 0o755 });
}

console.log('[bundle-server] Embedded server bundle ready in apps/client/resources/server!');

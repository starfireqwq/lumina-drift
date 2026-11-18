import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'apps/client/release');
const archive = new JSZip();

async function add(relative) {
  const absolute = path.join(root, relative);
  const stat = await fs.lstat(absolute);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(absolute)) await add(`${relative}/${entry}`);
  } else if (stat.isFile()) {
    archive.file(relative, await fs.readFile(absolute));
  }
}

// List deliverables explicitly so the archive never includes local profiles or the server database.
for (const entry of [
  'README.md', 'LICENSE', 'Dockerfile', '.dockerignore', 'docker-compose.yml', 'docs/PLUGINS.md',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
  'packages/shared/package.json', 'packages/shared/tsconfig.json', 'packages/shared/src', 'packages/shared/dist',
  'apps/server/package.json', 'apps/server/tsconfig.json', 'apps/server/src', 'apps/server/dist',
  'apps/client/package.json', 'apps/client/tsconfig.json', 'apps/client/tsconfig.node.json',
  'apps/client/index.html', 'apps/client/postcss.config.js', 'apps/client/tailwind.config.js', 'apps/client/vite.config.ts',
  'apps/client/electron/tabletProtocol.ts', 'apps/client/src', 'apps/client/public', 'apps/client/dist', 'apps/client/installer/LICENSE.txt',
  'apps/client/android', 'apps/client/resources/icon.png', 'scripts/package-android.mjs',
]) await add(entry);

archive.file('WEB-START.md', `# Lumina Drift 流光網頁版

解壓後，在套件根目錄使用 Node.js 22 和 pnpm 12.18.0。

1. 執行 \`pnpm install --frozen-lockfile --filter @atelier/server...\`，安裝適用於部署主機的伺服器依賴。
2. 設定 \`DATA_DIR\`、\`PORT\`、\`JWT_SECRET\`、\`ADMIN_USERNAME\` 和 \`ADMIN_PASSWORD\`。
3. 執行 \`pnpm --filter @atelier/server start\`。Fastify 會同時提供網頁、API 和 Socket.IO。

容器部署沿用 README 的 Docker 流程。首次部署時請依主機設定連接埠、資料卷和管理員憑證。
`);
await fs.mkdir(outDir, { recursive: true });
const output = path.join(outDir, `Lumina-Drift-Paint-Web-${version}.zip`);
await fs.writeFile(output, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(output);

import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const snapshotsDir = path.join(dataDir, 'snapshots');

// Ensure data and snapshots directories exist
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(snapshotsDir)) {
  fs.mkdirSync(snapshotsDir, { recursive: true });
}

function readOrCreateSessionSecret() {
  const secretPath = path.join(dataDir, 'session-secret');
  if (!fs.existsSync(secretPath)) {
    try {
      fs.writeFileSync(secretPath, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const secret = fs.readFileSync(secretPath, 'utf8').trim();
  if (!/^[a-f0-9]{96}$/.test(secret)) throw new Error('Invalid session-secret file in DATA_DIR.');
  return secret;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || readOrCreateSessionSecret(),
  dataDir,
  snapshotsDir,
  dbPath: process.env.DATABASE_PATH || path.join(dataDir, 'atelier.db'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  adminDefaultUsername: process.env.ADMIN_USERNAME || 'admin',
  adminDefaultPassword: process.env.ADMIN_PASSWORD,
  adminDefaultDisplayName: process.env.ADMIN_DISPLAY_NAME || '主畫室管理員',
};

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tests = [
  'test-e2e', 'test-phase2-layers', 'test-phase3-tiles', 'test-phase4-engine',
  'test-phase5-replay-export', 'test-phase6-voice-stickers-brushes', 'test-phase7-smart-fill-capsule-p2p',
  'test-phase8-connection-gateway', 'test-phase9-rulers-screentone-liquify-meshwarp', 'test-phase10-vector-and-color-curves',
  'test-phase11-profile-and-canvas-delete', 'test-phase12-avatar-crop', 'test-phase13-layer-groups-rename-shortcuts',
  'test-phase14-animation-mask-text-undo', 'test-phase15-timeline-groupmask-worker', 'test-phase16-parent-permissions',
  'test-phase17-timelapse-replay',
  'test-phase18-adjustment-layers',
  'test-phase19-collab-v2',
];

for (const test of tests) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lumina-server-test-'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/' + test + '.ts'], {
    stdio: 'inherit',
    timeout: 60_000,
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: join(dataDir, 'test.db'), PORT: '0',
      HOST: '127.0.0.1', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin123', JWT_SECRET: '' },
  });
  if (result.error) throw new Error(`${test}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

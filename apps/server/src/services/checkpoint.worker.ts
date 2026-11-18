/**
 * Checkpoint folding off the main thread. Reads the op log through its own read-only SQLite
 * connection (WAL lets it read while the server writes), folds, encodes and writes the snapshot
 * file; the main thread only records the row and tells the room. Built to dist/services.
 */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { encodePacket, type CanvasSnapshotBundle } from '@atelier/shared';
import { foldLayerTiles } from './checkpoint-fold';

export interface CheckpointJob {
  id: number;
  canvasId: string;
  seq: number;
  width: number;
  height: number;
  layers: Array<{ id: string; name: string }>;
}

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
const snapshotsStmt = db.prepare('SELECT seq, storage_path AS storagePath FROM canvas_snapshots WHERE canvas_id = ? ORDER BY seq DESC');
const opsStmt = db.prepare('SELECT seq, layer_id AS layerId, payload_blob AS payloadBlob FROM canvas_ops WHERE canvas_id = ? AND seq > ? ORDER BY seq');

parentPort!.on('message', (job: CheckpointJob) => {
  try {
    const layers = foldLayerTiles({
      snapshots: snapshotsStmt.all(job.canvasId) as Array<{ seq: number; storagePath: string }>,
      opsSince: (since) => opsStmt.all(job.canvasId, since) as Array<{ seq: number; layerId: string | null; payloadBlob: Uint8Array }>,
      layers: job.layers,
    }, job.seq);
    if (!layers || !layers.some((l) => l.tiles.length > 0)) {
      parentPort!.postMessage({ id: job.id, ok: true, skipped: true });
      return;
    }
    const bundle: CanvasSnapshotBundle = { canvasId: job.canvasId, seq: job.seq, tileSize: 256, width: job.width, height: job.height, layers, createdAt: Date.now() };
    const dir = path.join(workerData.snapshotsDir, job.canvasId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `snapshot_${job.seq}.bundle`);
    const encoded = Buffer.from(encodePacket(bundle as any));
    fs.writeFileSync(filePath, encoded);
    parentPort!.postMessage({ id: job.id, ok: true, filePath, byteSize: encoded.byteLength });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
});

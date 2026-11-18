import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { desc, eq, and, gt } from 'drizzle-orm';
import { db } from '../db';
import { canvasOps, canvasSnapshots } from '../db/schema';
import {
  CanvasSnapshotBundle,
  CanvasSnapshotModel,
  decodePacket,
  encodePacket,
  LayerTileSnapshot,
  TileData,
} from '@atelier/shared';
import { config } from '../config';
import { getCanvasById } from './canvas.service';
import { getLayersByCanvasId } from './layer.service';
import { foldLayerTiles, loadLatestBundle } from './checkpoint-fold';

// Not process.cwd(): snapshots must follow DATA_DIR (Docker volume) wherever the server is started from
const SNAPSHOTS_BASE_DIR = config.snapshotsDir;

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Saves a canvas snapshot bundle to disk and records it in SQLite canvas_snapshots
 */
export function saveSnapshot(
  canvasId: string,
  seq: number,
  bundle: CanvasSnapshotBundle | any
): CanvasSnapshotModel {
  const canvasDir = path.join(SNAPSHOTS_BASE_DIR, canvasId);
  ensureDir(canvasDir);

  const filePath = path.join(canvasDir, `snapshot_${seq}.bundle`);
  // The row's seq is authoritative: clients skip every op <= bundle.seq when loading
  const encoded = Buffer.from(encodePacket({ ...bundle, canvasId, seq }));

  fs.writeFileSync(filePath, encoded);
  const byteSize = encoded.byteLength;
  const now = Date.now();
  const snapshotId = `snap_${crypto.randomUUID()}`;

  db.insert(canvasSnapshots)
    .values({
      id: snapshotId,
      canvasId,
      seq,
      storagePath: filePath,
      byteSize,
      createdAt: now,
    })
    .run();

  return {
    id: snapshotId,
    canvasId,
    seq,
    storagePath: filePath,
    byteSize,
    createdAt: now,
  };
}

/**
 * Retrieves the latest snapshot for a canvas from SQLite and disk
 */
export function getLatestSnapshot(
  canvasId: string
): { model: CanvasSnapshotModel; bundle: CanvasSnapshotBundle } | null {
  const rows = db
    .select()
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.canvasId, canvasId))
    .orderBy(desc(canvasSnapshots.seq))
    .all();

  // Old auto-checkpoints were saved with no pixels; loading one hides every op before its seq.
  // Falling back to an older snapshot (or a full replay) is always correct, only slower.
  const found = loadLatestBundle(rows);
  if (!found) return null;
  const row = rows[found.index];
  return {
    model: { id: row.id, canvasId: row.canvasId, seq: row.seq, storagePath: row.storagePath, byteSize: row.byteSize, createdAt: row.createdAt },
    bundle: found.bundle,
  };
}

/**
 * Retrieves canvas operations since a given seq for fast incremental replay
 */
export function getOpsSince(
  canvasId: string,
  sinceSeq: number = 0
): Array<{
  canvasId: string;
  seq: number;
  userId: string;
  layerId: string | null;
  opType: string;
  payload: any;
  createdAt: number;
}> {
  const rows = db
    .select()
    .from(canvasOps)
    .where(and(eq(canvasOps.canvasId, canvasId), gt(canvasOps.seq, sinceSeq)))
    .orderBy(canvasOps.seq)
    .all();

  return rows.map((r) => {
    let payload: any = null;
    try {
      const decodedPacket = decodePacket(r.payloadBlob) as any;
      payload = decodedPacket.payload !== undefined ? decodedPacket.payload : decodedPacket;
    } catch {
      payload = null;
    }

    return {
      canvasId: r.canvasId,
      seq: r.seq,
      userId: r.userId,
      layerId: r.layerId,
      opType: r.opType,
      payload,
      createdAt: r.createdAt,
    };
  });
}

/** Folds the op log (see checkpoint-fold.ts) on this thread */
export function foldOpsIntoLayerTiles(canvasId: string, uptoSeq: number): LayerTileSnapshot[] | null {
  return foldLayerTiles({
    snapshots: db.select().from(canvasSnapshots).where(eq(canvasSnapshots.canvasId, canvasId)).orderBy(desc(canvasSnapshots.seq)).all(),
    opsSince: (since) => db.select({ seq: canvasOps.seq, layerId: canvasOps.layerId, payloadBlob: canvasOps.payloadBlob })
      .from(canvasOps).where(and(eq(canvasOps.canvasId, canvasId), gt(canvasOps.seq, since))).orderBy(canvasOps.seq).all(),
    layers: getLayersByCanvasId(canvasId).map((l) => ({ id: l.id, name: l.name })),
  }, uptoSeq);
}

// ---------- Checkpoints in a worker thread ----------
// The fold decodes every op since the last checkpoint and re-encodes all tiles: on a busy room it
// held the event loop (every painter's previews and ops) for tens to hundreds of ms.
let worker: Worker | null = null;
let workerFailed = false;
let nextJobId = 1;
const pending = new Map<number, (result: { ok: boolean; skipped?: boolean; filePath?: string; byteSize?: number; error?: string }) => void>();

function checkpointWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  // Built server only (dist/services/checkpoint.worker.js); running from source (tsx tests) folds inline
  const file = path.join(__dirname, 'checkpoint.worker.js');
  if (!fs.existsSync(file)) {
    workerFailed = true;
    return null;
  }
  worker = new Worker(file, { workerData: { dbPath: config.dbPath, snapshotsDir: SNAPSHOTS_BASE_DIR } });
  worker.unref(); // never keeps the process alive on shutdown
  worker.on('message', (msg: { id: number }) => {
    pending.get(msg.id)?.(msg as any);
    pending.delete(msg.id);
  });
  const fail = (err: unknown) => {
    console.error('[Checkpoint] worker stopped, folding inline from now on:', err);
    worker = null;
    workerFailed = true;
    for (const resolve of pending.values()) resolve({ ok: false, error: 'worker stopped' });
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => code !== 0 && fail(`exit ${code}`));
  return worker;
}

/**
 * The same checkpoint as autoCreateCheckpoint, folded off the main thread when the worker is
 * available. The main thread only records the row (one SQLite writer).
 */
export async function createCheckpointInBackground(canvasId: string, seq: number): Promise<CanvasSnapshotModel | null> {
  const canvas = getCanvasById(canvasId);
  const w = checkpointWorker();
  if (!canvas || !w) return autoCreateCheckpoint(canvasId, seq);
  const id = nextJobId++;
  const result = await new Promise<{ ok: boolean; skipped?: boolean; filePath?: string; byteSize?: number; error?: string }>((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, canvasId, seq, width: canvas.width, height: canvas.height, layers: getLayersByCanvasId(canvasId).map((l) => ({ id: l.id, name: l.name })) });
  });
  if (!result.ok) return autoCreateCheckpoint(canvasId, seq);
  if (result.skipped || !result.filePath) return null;
  const now = Date.now();
  const model: CanvasSnapshotModel = { id: `snap_${crypto.randomUUID()}`, canvasId, seq, storagePath: result.filePath, byteSize: result.byteSize ?? 0, createdAt: now };
  db.insert(canvasSnapshots).values(model).run();
  return model;
}

/**
 * Creates a checkpoint snapshot at the given seq, folded from the op log unless tiles are supplied
 */
export function autoCreateCheckpoint(
  canvasId: string,
  providedSeq?: number,
  layerTiles?: LayerTileSnapshot[]
): CanvasSnapshotModel | null {
  const canvas = getCanvasById(canvasId);
  if (!canvas) return null;

  const currentSeq = providedSeq !== undefined ? providedSeq : canvas.latestSeq;
  const layers = layerTiles || foldOpsIntoLayerTiles(canvasId, currentSeq);
  if (!layers || !layers.some((l) => l.tiles.length > 0)) return null;

  const bundle: CanvasSnapshotBundle = {
    canvasId,
    seq: currentSeq,
    tileSize: 256,
    width: canvas.width,
    height: canvas.height,
    layers,
    createdAt: Date.now(),
  };

  return saveSnapshot(canvasId, currentSeq, bundle);
}

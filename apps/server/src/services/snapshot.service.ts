import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { desc, eq, and, gt } from 'drizzle-orm';
import { db, sqlite } from '../db';
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

export interface CanvasOpRecord {
  canvasId: string;
  seq: number;
  userId: string;
  layerId: string | null;
  opType: string;
  payload: any;
  createdAt: number;
}

export interface TimeLapseParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface OpsPageResult {
  ops: CanvasOpRecord[];
  hasMore: boolean;
  nextSeq: number;
  totalRemaining: number;
}

function toTileBytes(data: unknown): Uint8Array | null {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') {
    const clean = data.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
    return new Uint8Array((data as { data: number[] }).data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }
  return null;
}

function downsamplePoints(points: any[], maxPoints: number): Array<{ x: number; y: number; pressure?: number }> {
  if (!Array.isArray(points) || points.length === 0) return [];
  const valid = points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (valid.length === 0) return [];
  if (valid.length <= maxPoints) {
    return valid.map((p) => ({
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      ...(Number.isFinite(p.pressure) ? { pressure: Math.round(p.pressure * 100) / 100 } : {}),
    }));
  }
  const out: Array<{ x: number; y: number; pressure?: number }> = [];
  const last = valid.length - 1;
  const step = last / (maxPoints - 1);
  for (let i = 0; i < maxPoints - 1; i++) {
    const p = valid[Math.round(i * step)];
    out.push({
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      ...(Number.isFinite(p.pressure) ? { pressure: Math.round(p.pressure * 100) / 100 } : {}),
    });
  }
  const end = valid[last];
  out.push({
    x: Math.round(end.x * 10) / 10,
    y: Math.round(end.y * 10) / 10,
    ...(Number.isFinite(end.pressure) ? { pressure: Math.round(end.pressure * 100) / 100 } : {}),
  });
  return out;
}

/**
 * Strips heavy live-collaboration fields (`inkTiles`, `historyTiles`, `allPoints`, client bookkeeping)
 * from a decoded op payload so Time-Lapse Replay streams thousands of strokes safely.
 */
export function slimTimeLapsePayload(
  payload: any,
  tileFormat: 'raw' | 'base64' = 'raw'
): any {
  if (!payload || typeof payload !== 'object') return payload;

  const slim: Record<string, any> = {};
  if (typeof payload.color === 'string') slim.color = payload.color;
  if (Number.isFinite(payload.size)) slim.size = payload.size;
  if (Number.isFinite(payload.opacity)) slim.opacity = payload.opacity;
  if (typeof payload.isEraser === 'boolean') slim.isEraser = payload.isEraser;
  if (typeof payload.tool === 'string') slim.tool = payload.tool;
  if (typeof payload.actionDesc === 'string') slim.actionDesc = payload.actionDesc;
  if (typeof payload.isUndo === 'boolean') slim.isUndo = payload.isUndo;
  if (payload.bounds && typeof payload.bounds === 'object') {
    slim.bounds = payload.bounds;
  }

  let hasTiles = false;
  if (Array.isArray(payload.tiles) && payload.tiles.length > 0) {
    const cleanTiles: any[] = [];
    for (const t of payload.tiles) {
      if (!t || !Number.isInteger(t.col) || !Number.isInteger(t.row)) continue;
      const bytes = toTileBytes(t.data);
      if (!bytes || bytes.byteLength === 0) continue;
      cleanTiles.push({
        col: t.col,
        row: t.row,
        width: t.width,
        height: t.height,
        compression: t.compression || 'lz4',
        data: tileFormat === 'base64'
          ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
          : bytes,
      });
    }
    if (cleanTiles.length > 0) {
      slim.tiles = cleanTiles;
      hasTiles = true;
    }
  }

  // Keep full samplePoints (up to 400) only when tiles are absent (legacy rasterization fallback);
  // when authoritative tiles exist, 32 points along the stroke are plenty for cursor tracking.
  const sourcePoints = Array.isArray(payload.samplePoints) && payload.samplePoints.length > 0
    ? payload.samplePoints
    : Array.isArray(payload.allPoints) && payload.allPoints.length > 0
      ? payload.allPoints
      : null;
  if (sourcePoints) {
    slim.samplePoints = downsamplePoints(sourcePoints, hasTiles ? 32 : 400);
  } else if (Array.isArray(payload.vectorAdded) && payload.vectorAdded.length > 0) {
    const anchors = payload.vectorAdded.flatMap((v: any) => (Array.isArray(v?.anchors) ? v.anchors : []));
    if (anchors.length > 0) {
      slim.samplePoints = downsamplePoints(anchors, 32);
    }
  }

  if (!hasTiles) {
    if (Array.isArray(payload.vectorAdded)) slim.vectorAdded = payload.vectorAdded;
    if (Array.isArray(payload.vectorRemovedIds)) slim.vectorRemovedIds = payload.vectorRemovedIds;
    if (payload.vectorStroke) slim.vectorStroke = payload.vectorStroke;
  }

  return slim;
}

function estimateOpPayloadBytes(payload: any, blobLength: number, view: 'full' | 'timelapse', tileFormat: 'raw' | 'base64'): number {
  if (view === 'full') {
    // Buffer/Uint8Array JSON serialization expands raw blobs ~4-9x.
    return Math.max(256, blobLength * 6);
  }
  let bytes = 256;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.tiles)) {
      for (const t of payload.tiles) {
        if (typeof t?.data === 'string') bytes += t.data.length + 64;
        else if (t?.data?.byteLength) bytes += t.data.byteLength + 64;
      }
    }
    if (Array.isArray(payload.samplePoints)) {
      bytes += payload.samplePoints.length * (tileFormat === 'base64' ? 44 : 28);
    }
  }
  return bytes;
}

/**
 * Returns distinct authors (including offline / past collaborators) for ops on a canvas.
 */
export function getCanvasOpParticipants(canvasId: string): Record<string, TimeLapseParticipant> {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT o.user_id AS userId, u.display_name AS displayName, u.avatar_url AS avatarUrl
       FROM canvas_ops o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.canvas_id = ?`
    )
    .all(canvasId) as Array<{ userId: string; displayName: string | null; avatarUrl: string | null }>;

  const map: Record<string, TimeLapseParticipant> = {};
  for (const r of rows) {
    map[r.userId] = {
      userId: r.userId,
      displayName: r.displayName || '畫師',
      avatarUrl: r.avatarUrl || null,
    };
  }
  return map;
}

/**
 * Retrieves a bounded, paginated slice of canvas operations after `sinceSeq` so even canvases with
 * tens of thousands of strokes load reliably without hitting V8 JSON string or heap limits.
 */
export function getOpsPage(
  canvasId: string,
  options: {
    sinceSeq?: number;
    limit?: number;
    view?: 'full' | 'timelapse';
    tileFormat?: 'raw' | 'base64';
    maxBytes?: number;
  } = {}
): OpsPageResult {
  const sinceSeq = Number.isFinite(options.sinceSeq) && (options.sinceSeq ?? 0) > 0 ? Math.floor(options.sinceSeq!) : 0;
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 300)));
  const view = options.view === 'timelapse' ? 'timelapse' : 'full';
  const tileFormat = options.tileFormat === 'base64' ? 'base64' : 'raw';
  const maxBytes = Math.max(256 * 1024, options.maxBytes ?? 4 * 1024 * 1024);

  const countRow = sqlite
    .prepare('SELECT COUNT(*) AS cnt FROM canvas_ops WHERE canvas_id = ? AND seq > ?')
    .get(canvasId, sinceSeq) as { cnt: number } | undefined;
  const totalRemaining = countRow?.cnt ?? 0;

  const stmt = sqlite.prepare(
    `SELECT canvas_id AS canvasId, seq, user_id AS userId, layer_id AS layerId, op_type AS opType, payload_blob AS payloadBlob, created_at AS createdAt
     FROM canvas_ops
     WHERE canvas_id = ? AND seq > ?
     ORDER BY seq
     LIMIT ?`
  );

  const ops: CanvasOpRecord[] = [];
  let approxBytes = 0;
  let hasMore = false;
  let nextSeq = sinceSeq;

  for (const r of stmt.iterate(canvasId, sinceSeq, limit + 1) as Iterable<{
    canvasId: string;
    seq: number;
    userId: string;
    layerId: string | null;
    opType: string;
    payloadBlob: Buffer | Uint8Array;
    createdAt: number;
  }>) {
    if (ops.length >= limit) {
      hasMore = true;
      break;
    }

    let payload: any = null;
    try {
      const decodedPacket = decodePacket(r.payloadBlob) as any;
      const rawPayload = decodedPacket?.payload !== undefined ? decodedPacket.payload : decodedPacket;
      payload = view === 'timelapse' ? slimTimeLapsePayload(rawPayload, tileFormat) : rawPayload;
    } catch {
      payload = null;
    }

    const opBytes = estimateOpPayloadBytes(payload, r.payloadBlob?.byteLength ?? 0, view, tileFormat);
    if (ops.length >= 1 && approxBytes + opBytes > maxBytes) {
      hasMore = true;
      break;
    }

    ops.push({
      canvasId: r.canvasId,
      seq: r.seq,
      userId: r.userId,
      layerId: r.layerId,
      opType: r.opType,
      payload,
      createdAt: r.createdAt,
    });
    approxBytes += opBytes;
    nextSeq = r.seq;
  }

  return { ops, hasMore, nextSeq, totalRemaining };
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

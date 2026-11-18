import { compressTileBuffer, decompressTileBuffer, type TileData } from '@atelier/shared';
import { applyColorOutline, type OutlineSettings } from './colorOutline';
import { bucketMask, paintGradientTiles, type GradientPaint } from './rasterToolPixels';

/**
 * A small pool of workers for commit work (LZ4 tile compression, outline rings). A long stroke on a
 * big canvas used to stall the page ~200 ms at commit doing this on the main thread; the GPU
 * read-back still happens here (WebGL lives on this thread), everything after it does not.
 */
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
const pool: Worker[] = [];
const pending = new Map<number, Pending>();
let nextId = 1;
let broken = typeof Worker === 'undefined';
/** A worker has answered: from then on big inputs are handed over (transferred) instead of copied */
let proven = false;

function workers(): Worker[] {
  if (broken) return [];
  if (!pool.length) {
    const size = Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1));
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL('../workers/commit.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
          const p = pending.get(data.id);
          if (!p) return;
          pending.delete(data.id);
          if (data.error) p.reject(new Error(data.error));
          else {
            proven = true;
            p.resolve(data.result);
          }
        };
        w.onerror = (event) => {
          // A worker that cannot load: everything falls back to the main thread from now on
          broken = true;
          event.preventDefault();
          for (const p of pending.values()) p.reject(new Error(event.message || 'commit worker failed'));
          pending.clear();
        };
        pool.push(w);
      }
    } catch {
      broken = true;
      return [];
    }
  }
  return pool;
}

function run<T>(worker: Worker, message: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

/** Splits work into one chunk per worker (order kept) */
function chunks<T>(items: T[], n: number): T[][] {
  const size = Math.ceil(items.length / n);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function calculateBucketMask(...args: Parameters<typeof bucketMask>): Promise<ReturnType<typeof bucketMask>> {
  const [worker] = workers();
  if (worker && args[0].byteLength >= 1024 * 1024) {
    try {
      return await run(worker, { kind: 'bucket', args }, []);
    } catch (err) {
      console.warn('[commitWorkers] Bucket mask fallback:', err);
    }
  }
  return bucketMask(...args);
}

export async function calculateGradientTiles(tiles: TileData[], options: GradientPaint): Promise<TileData[]> {
  const pool = workers();
  if (pool.length && tiles.length >= 4 && typeof OffscreenCanvas !== 'undefined') {
    try {
      const parts = chunks(tiles, pool.length);
      return (await Promise.all(parts.map((part, i) =>
        run<TileData[]>(pool[i], { kind: 'gradient', tiles: part, options }, [])))).flat();
    } catch (err) {
      console.warn('[commitWorkers] Gradient fallback:', err);
    }
  }
  return paintGradientTiles(tiles, options, document.createElement('canvas'));
}

const compressHere = (t: { col: number; row: number; width: number; height: number; raw: Uint8Array }): TileData => {
  if (t.width <= 0 || t.height <= 0) return { col: t.col, row: t.row, width: 0, height: 0, compression: 'raw', data: new Uint8Array(0) };
  const { compression, data } = compressTileBuffer(t.raw, 'lz4');
  return { col: t.col, row: t.row, width: t.width, height: t.height, compression, data, byteLength: data.byteLength };
};

const ringHere = (r: OutlineRegion, color: string, outline: OutlineSettings): Uint8Array | null => {
  if (!applyColorOutline(r.px, r.bw, r.bh, color, outline)) return null;
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const src = ((y + r.oy) * r.bw + r.ox) * 4;
    out.set(r.px.subarray(src, src + r.w * 4), y * r.w * 4);
  }
  return out;
};

// Inputs are copied to workers that have not answered yet (if one fails the main thread still has
// them and does the work itself, so no commit is lost); once one has, raw tiles are transferred.

/** LZ4 for raw tiles (TileEngine.extractTilesRawAsync / extractTilesBatch(…, 'raw')); the caller gives them up */
export async function compressTiles(raw: TileData[]): Promise<TileData[]> {
  const list = raw.map((t) => ({ col: t.col, row: t.row, width: t.width, height: t.height, raw: t.data as Uint8Array }));
  const pool = workers();
  if (pool.length && list.length) {
    try {
      const parts = chunks(list, pool.length);
      // A whole-buffer view can be handed over; a view into a shared buffer is copied
      const transfer = (part: typeof list) => (proven ? part.filter((t) => t.raw.byteOffset === 0 && t.raw.byteLength === t.raw.buffer.byteLength && t.raw.byteLength > 0).map((t) => t.raw.buffer as ArrayBuffer) : []);
      return (await Promise.all(parts.map((part, i) => run<TileData[]>(pool[i], { kind: 'compress', tiles: part }, transfer(part))))).flat();
    } catch (err) {
      console.warn('[commitWorkers] compressing on the main thread:', err);
    }
  }
  return list.map(compressHere);
}

/**
 * LZ4 → RGBA for cold layer tiles, off the main thread (null = empty tile). The compressed bytes are
 * copied, not handed over: the layer keeps them as its cold copy. Falls back to this thread.
 */
export async function decodeTiles(tiles: Array<{ data: Uint8Array; compression: 'lz4' | 'raw'; w: number; h: number }>): Promise<Array<Uint8Array | null>> {
  const pool = workers();
  if (pool.length && tiles.length) {
    try {
      const parts = chunks(tiles, pool.length);
      return (await Promise.all(parts.map((part, i) => run<Array<Uint8Array | null>>(pool[i], { kind: 'decode', tiles: part }, [])))).flat();
    } catch (err) {
      console.warn('[commitWorkers] decoding on the main thread:', err);
    }
  }
  return tiles.map(decodeHere);
}
const decodeHere = (t: { data: Uint8Array; compression: 'lz4' | 'raw'; w: number; h: number }): Uint8Array | null => {
  const len = t.w * t.h * 4;
  if (len <= 0) return null;
  const raw = t.compression === 'lz4' ? decompressTileBuffer(t.data, 'lz4', len) : t.data.slice(0, len);
  if (!raw || raw.length < len) return null;
  const u = new Uint32Array(raw.buffer, raw.byteOffset, len >> 2);
  for (let i = 0; i < u.length; i++) if (u[i]) return raw;
  return null;
};

/**
 * Starts the workers and has each answer once, so the first real commit already hands its tiles
 * over instead of copying them (a long first stroke on a big canvas copied ~20 MB: one 50 ms frame).
 */
export function warmUpCommitWorkers() {
  const pool = workers();
  for (const w of pool) {
    void run(w, { kind: 'compress', tiles: [{ col: 0, row: 0, width: 1, height: 1, raw: new Uint8Array(4) }] }, []).catch(() => {});
  }
}

export interface OutlineRegion { px: Uint8Array; bw: number; bh: number; ox: number; oy: number; w: number; h: number }

/** The ringed w×h tile for each region, or null where the outline changed nothing */
export async function outlineRings(regions: OutlineRegion[], color: string, outline: OutlineSettings): Promise<Array<Uint8Array | null>> {
  const pool = workers();
  if (pool.length && regions.length) {
    try {
      const parts = chunks(regions, pool.length);
      return (await Promise.all(parts.map((part, i) => run<Array<Uint8Array | null>>(pool[i], { kind: 'outline', regions: part, color, outline }, [])))).flat();
    } catch (err) {
      console.warn('[commitWorkers] outline on the main thread:', err);
    }
  }
  return regions.map((r) => ringHere(r, color, outline));
}

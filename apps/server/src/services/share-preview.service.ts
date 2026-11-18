import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config';
import { sqlite } from '../db';
import { getCanvasById } from './canvas.service';
import { getLayersByCanvasId } from './layer.service';
import { hasPreviewPixels, renderSharePreview, type SharePreviewSource } from './share-preview-render';
import { foldOpsIntoLayerTiles } from './snapshot.service';

const ROOM_ID = /^[\w-]{1,128}$/;
const CACHE_LIMIT = 24;
const PENDING_LIMIT = 4;

/** An invite controls editing. Guests can browse rooms in that mode without a password. */
export function getPublicShareCanvas(id: string) {
  if (!ROOM_ID.test(id)) return null;
  const canvas = getCanvasById(id);
  return canvas && canvas.accessMode === 'invite' && !canvas.roomPassHash ? canvas : null;
}

export function createSharePreviews(brandPath: string) {
  const cache = new Map<string, { revision: string; png: Buffer | null }>();
  const pending = new Map<string, Promise<Buffer | null>>();
  const jobs = new Map<number, { resolve: (png: Buffer | null) => void; reject: (error: Error) => void }>();
  const workerFile = path.join(__dirname, 'share-preview.worker.js');
  const useWorker = existsSync(workerFile);
  let worker: Worker | null = null;
  let nextJob = 0;

  const getState = (id: string) => {
    // Check the current policy before looking up any cached artwork.
    const canvas = getPublicShareCanvas(id);
    if (!canvas) return null;
    const layers = getLayersByCanvasId(id);
    const snap = sqlite.prepare('SELECT id, seq, byte_size FROM canvas_snapshots WHERE canvas_id = ? ORDER BY seq DESC, created_at DESC LIMIT 1').get(id);
    const revision = createHash('sha256').update(JSON.stringify([canvas, layers, snap])).digest('hex').slice(0, 24);
    return { source: { canvas, layers, brandPath }, revision };
  };

  const clearJobs = (stopped: Worker, error: Error) => {
    if (stopped !== worker) return;
    worker = null;
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };

  const render = async (source: SharePreviewSource) => {
    if (!useWorker) {
      const layers = foldOpsIntoLayerTiles(source.canvas.id, source.canvas.latestSeq);
      return layers && hasPreviewPixels(layers) ? renderSharePreview(source, layers, readFileSync(brandPath)) : null;
    }
    if (!worker) {
      const started = new Worker(workerFile, { workerData: { dbPath: config.dbPath } });
      worker = started;
      started.on('message', ({ id, png, error }: { id: number; png: Uint8Array | null; error?: string }) => {
        const job = jobs.get(id);
        jobs.delete(id);
        if (error) job?.reject(new Error(error));
        else job?.resolve(png ? Buffer.from(png) : null);
      });
      started.on('error', (error) => clearJobs(started, error));
      started.on('exit', () => clearJobs(started, new Error('Share preview worker stopped')));
      started.unref();
    }
    const id = ++nextJob;
    return new Promise<Buffer | null>((resolve, reject) => {
      worker!.postMessage({ id, source });
      jobs.set(id, { resolve, reject });
    });
  };

  const get = async (id: string) => {
    const state = getState(id);
    if (!state) return null;
    const { source, revision } = state;
    const hit = cache.get(id);
    if (hit?.revision === revision) {
      cache.delete(id);
      cache.set(id, hit);
      return hit.png ? { title: source.canvas.title, revision, png: hit.png } : null;
    }
    const key = `${id}:${revision}`;
    let task = pending.get(key);
    if (!task) {
      if (pending.size >= PENDING_LIMIT) return null;
      task = render(source).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    const png = await task;
    // A room may be locked, deleted or edited while a thumbnail is rendering.
    if (getState(id)?.revision !== revision) return null;
    cache.delete(id);
    cache.set(id, { revision, png });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return png ? { title: source.canvas.title, revision, png } : null;
  };

  return {
    get,
    close: async () => { await worker?.terminate(); },
  };
}

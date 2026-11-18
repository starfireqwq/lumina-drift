import type { TileCoord, TileData } from '@atelier/shared';
import type { LayerManager } from '../../../engine/LayerManager';
import { compressTiles } from '../../../engine/commitWorkers';

/**
 * Before / after tiles of an edit, without stalling the page: the "before" read is queued, then
 * `modify` does its (synchronous, GPU) edit, then the "after" read is queued. Queued reads hold the
 * pixels as of the moment they were issued, whatever is drawn next; LZ4 happens in the workers.
 * (extractMultipleTiles read synchronously and compressed on the main thread: a merge-down or a
 * transform on 10000×8000 froze the page for seconds.) `before: 'before'` reads the ping-pong state.
 */
export function diffTilesAsync(
  lm: LayerManager,
  layerId: string,
  coords: TileCoord[],
  modify: () => void,
  before: 'after' | 'before' = 'after',
): Promise<{ beforeTiles: TileData[]; afterTiles: TileData[] }> {
  const b = lm.readTilesAsync(layerId, coords, before);
  modify();
  const a = lm.readTilesAsync(layerId, coords, 'after');
  return Promise.all([b, a])
    .then(([bt, at]) => Promise.all([compressTiles(bt), compressTiles(at)]))
    .then(([beforeTiles, afterTiles]) => ({ beforeTiles, afterTiles }));
}

/** Current tiles of a layer, read without stalling and compressed off the main thread */
export function tilesAsync(lm: LayerManager, layerId: string, coords: TileCoord[]): Promise<TileData[]> {
  return lm.readTilesAsync(layerId, coords).then(compressTiles);
}

let chain: Promise<void> = Promise.resolve();
let pending = 0;
const waiters: Array<() => void> = [];

/**
 * Applies results in the order the edits were made (a fill whose tiles arrive after the next
 * fill's must still land first in the undo history and on the wire). Pass a function for an edit
 * that reads, computes and writes back: it starts only once the previous edit has landed, so two
 * quick fills never both read the pixels from before the first.
 */
export function commitInOrder<T>(work: Promise<T> | (() => Promise<T>), apply: (value: T) => void) {
  pending++;
  chain = chain
    .then(() => (typeof work === 'function' ? work() : work))
    .then(apply)
    .catch((err) => console.warn('[tools] commit failed:', err))
    .finally(() => {
      pending--;
      if (pending === 0) waiters.splice(0).forEach((fn) => fn());
    });
}

/** Runs fn once every edit started so far is committed (undo / redo wait for this) */
export function whenToolCommitsDone(fn: () => void) {
  if (pending === 0) fn();
  else waiters.push(fn);
}

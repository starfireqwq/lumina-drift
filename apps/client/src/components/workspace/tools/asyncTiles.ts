import type { TileCoord, TileData } from '@atelier/shared';
import type { LayerManager } from '../../../engine/LayerManager';
import { compressTiles } from '../../../engine/commitWorkers';

const tileKey = ({ col, row }: TileCoord) => `${col}_${row}`;

/** Reuse compressed snapshots and queue only the reads needed for the edit's baseline. */
export async function readBeforeTilesAsync(
  lm: LayerManager,
  layerId: string,
  coords: TileCoord[],
  which: 'after' | 'before',
): Promise<TileData[]> {
  const { cached, missing } = lm.takeBackupCleanTiles(layerId, coords);
  if (which === 'after' && cached.size) {
    // An open backup describes the pre-edit pixels, so read the live tile instead.
    for (const coord of lm.editedSparseTiles(layerId) ?? []) {
      if (cached.delete(tileKey(coord))) missing.push(coord);
    }
  }
  if (cached.size + missing.length < coords.length) {
    // Preserve the placeholders readTilesAsync returns for out-of-bounds coordinates.
    const missingKeys = new Set(missing.map(tileKey));
    for (const coord of coords) {
      const key = tileKey(coord);
      if (cached.has(key) || missingKeys.has(key)) continue;
      missing.push(coord);
      missingKeys.add(key);
    }
  }
  if (missing.length) {
    const tiles = await lm.readTilesAsync(layerId, missing, which).then(compressTiles);
    for (const tile of tiles) cached.set(tileKey(tile), tile);
  }
  return coords.map((coord) => cached.get(tileKey(coord))!);
}

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
  const beforeRead = readBeforeTilesAsync(lm, layerId, coords, before);
  modify();
  const item = lm.getLayerItem(layerId);
  const afterVersion = lm.getLayerVersion(layerId);
  const afterRead = lm.readTilesAsync(layerId, coords, 'after').then(compressTiles).then((tiles) => {
    if (lm.getLayerItem(layerId) === item) lm.recordCleanTiles(layerId, tiles, afterVersion);
    return tiles;
  });
  return Promise.all([beforeRead, afterRead]).then(([beforeTiles, afterTiles]) => ({ beforeTiles, afterTiles }));
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

import { TileData } from '../types/tiles';
import { compressTileBuffer, decompressTileBuffer } from './tile-compress';

/**
 * Three-way undo/redo for a shared layer. `mine` is what this op left behind, `target` what undo
 * (or redo) wants back, `current` what the layer holds now. A pixel goes back to `target` only
 * while it still equals `mine`; a pixel someone painted over since is kept, so undo never wipes
 * another painter's later work in the same tile. `conflicts` counts the pixels kept that way.
 */
export function mergeUndoPixels(
  target: Uint8Array,
  mine: Uint8Array,
  current: Uint8Array,
  /** 1 per pixel another painter touched since (their brush footprint): kept even when the bytes match mine */
  foreign?: Uint8Array
): { pixels: Uint8Array; conflicts: number } {
  const pixels = new Uint8Array(current);
  let conflicts = 0;
  const n = Math.min(target.length, mine.length, current.length);
  for (let i = 0; i < n; i += 4) {
    const untouched = !(foreign && foreign[i >> 2]) &&
      current[i] === mine[i] && current[i + 1] === mine[i + 1] && current[i + 2] === mine[i + 2] && current[i + 3] === mine[i + 3];
    if (untouched) {
      pixels[i] = target[i];
      pixels[i + 1] = target[i + 1];
      pixels[i + 2] = target[i + 2];
      pixels[i + 3] = target[i + 3];
    } else if (
      target[i] !== mine[i] || target[i + 1] !== mine[i + 1] || target[i + 2] !== mine[i + 2] || target[i + 3] !== mine[i + 3]
    ) {
      conflicts++;
    }
  }
  return { pixels, conflicts };
}

export function tileToRgba(tile: TileData): Uint8Array {
  const raw = tile.data instanceof Uint8Array ? tile.data : new Uint8Array(0);
  return tile.compression === 'lz4' ? decompressTileBuffer(raw, 'lz4', tile.width * tile.height * 4) : raw;
}

/** mergeUndoPixels for one tile; `current` is the layer's RGBA for the same tile bounds */
export function mergeUndoTile(
  target: TileData,
  mine: TileData | undefined,
  current: Uint8Array,
  foreign?: Uint8Array
): { tile: TileData; conflicts: number } {
  if (!mine) return { tile: target, conflicts: 0 };
  const { pixels, conflicts } = mergeUndoPixels(tileToRgba(target), tileToRgba(mine), current, foreign);
  const { compression, data } = compressTileBuffer(pixels, 'lz4');
  return { tile: { ...target, compression, data, byteLength: data.byteLength }, conflicts };
}

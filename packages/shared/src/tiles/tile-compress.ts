import * as lz4 from 'lz4js';
import { TileCompression } from '../types/tiles';

/**
 * Compresses raw RGBA pixel byte buffer using LZ4 or passes through raw
 */
export function compressTileBuffer(
  rgba: Uint8Array,
  format: TileCompression = 'lz4'
): { compression: TileCompression; data: Uint8Array } {
  if (format === 'lz4') {
    try {
      const compressed = lz4.compress(rgba);
      return { compression: 'lz4', data: compressed };
    } catch (err) {
      console.warn('[TileCompress] LZ4 compression failed, falling back to raw:', err);
      return { compression: 'raw', data: rgba };
    }
  }

  return { compression: 'raw', data: rgba };
}

/**
 * Decompresses tile buffer back into RGBA bytes
 */
export function decompressTileBuffer(
  data: Uint8Array,
  format: TileCompression,
  expectedLength?: number,
  /** Reused output buffer (at least expectedLength bytes): no allocation at all */
  out?: Uint8Array
): Uint8Array {
  if (format === 'lz4') {
    try {
      // lz4.decompress() without a size allocates the frame's upper bound first: 8 MB for every 256 KB tile
      if (expectedLength) {
        const dst = out && out.length >= expectedLength ? out : new Uint8Array(expectedLength);
        const size = lz4.decompressFrame(data, dst);
        return size === dst.length ? dst : dst.subarray(0, size);
      }
      const decompressed = lz4.decompress(data);
      return decompressed;
    } catch (err) {
      console.error('[TileCompress] LZ4 decompression failed:', err);
      return expectedLength ? new Uint8Array(expectedLength) : data;
    }
  }

  return data;
}

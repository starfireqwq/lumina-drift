import { compressTileBuffer, decompressTileBuffer, type TileData } from '@atelier/shared';
import { applyColorOutline, type OutlineSettings } from '../engine/colorOutline';
import { bucketMask, paintGradientTiles, type GradientPaint } from '../engine/rasterToolPixels';

/** Commit work off the main thread: LZ4 for tiles read back from the GPU, and outline-brush rings */
type Request =
  | { id: number; kind: 'bucket'; args: Parameters<typeof bucketMask> }
  | { id: number; kind: 'gradient'; tiles: TileData[]; options: GradientPaint }
  | { id: number; kind: 'compress'; tiles: Array<{ col: number; row: number; width: number; height: number; raw: Uint8Array }> }
  /** Cold layer tiles (animation frames about to play): LZ4 → premultiplied RGBA; null = empty / undecodable */
  | { id: number; kind: 'decode'; tiles: Array<{ data: Uint8Array; compression: 'lz4' | 'raw'; w: number; h: number }> }
  | {
      id: number;
      kind: 'outline';
      color: string;
      outline: OutlineSettings;
      /** px: a bw×bh window around a w×h tile that starts at (ox, oy) inside it */
      regions: Array<{ px: Uint8Array; bw: number; bh: number; ox: number; oy: number; w: number; h: number }>;
    };

/** An empty tile comes back as null (nothing to put on the GPU) */
export function decodeTileHere(t: { data: Uint8Array; compression: 'lz4' | 'raw'; w: number; h: number }): Uint8Array | null {
  const len = t.w * t.h * 4;
  if (len <= 0) return null;
  const raw = t.compression === 'lz4' ? decompressTileBuffer(t.data, 'lz4', len) : t.data.slice(0, len);
  if (!raw || raw.length < len) return null;
  const u = new Uint32Array(raw.buffer, raw.byteOffset, len >> 2);
  for (let i = 0; i < u.length; i++) if (u[i]) return raw;
  return null;
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  try {
    if (data.kind === 'bucket') {
      const result = bucketMask(...data.args);
      self.postMessage({ id: data.id, result }, { transfer: result?.data ? [result.data.buffer] : [] });
      return;
    }
    if (data.kind === 'gradient') {
      const result = paintGradientTiles(data.tiles, data.options, new OffscreenCanvas(1, 1));
      self.postMessage({ id: data.id, result }, { transfer: result.map((tile) => (tile.data as Uint8Array).buffer as ArrayBuffer) });
      return;
    }
    if (data.kind === 'compress') {
      const tiles = data.tiles.map((t) => {
        const { compression, data: bytes } = compressTileBuffer(t.raw, 'lz4');
        return { col: t.col, row: t.row, width: t.width, height: t.height, compression, data: bytes, byteLength: bytes.byteLength };
      });
      self.postMessage({ id: data.id, result: tiles }, { transfer: tiles.map((t) => t.data.buffer as ArrayBuffer) });
      return;
    }
    if (data.kind === 'decode') {
      const out = data.tiles.map((t) => decodeTileHere(t));
      self.postMessage({ id: data.id, result: out }, { transfer: out.flatMap((p) => (p ? [p.buffer as ArrayBuffer] : [])) });
      return;
    }
    const rings = data.regions.map((r) => {
      if (!applyColorOutline(r.px, r.bw, r.bh, data.color, data.outline)) return null;
      const out = new Uint8Array(r.w * r.h * 4);
      for (let y = 0; y < r.h; y++) {
        const src = ((y + r.oy) * r.bw + r.ox) * 4;
        out.set(r.px.subarray(src, src + r.w * 4), y * r.w * 4);
      }
      return out;
    });
    self.postMessage({ id: data.id, result: rings }, { transfer: rings.flatMap((p) => (p ? [p.buffer] : [])) });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};

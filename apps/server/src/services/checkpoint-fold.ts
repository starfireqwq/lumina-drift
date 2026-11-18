import fs from 'node:fs';
import { decodePacket, type CanvasSnapshotBundle, type LayerTileSnapshot, type TileData } from '@atelier/shared';

/** What folding reads: plain rows, so the same code runs in the server and in the checkpoint worker */
export interface FoldSource {
  /** Snapshot rows of the canvas, newest first */
  snapshots: Array<{ seq: number; storagePath: string }>;
  /** Op rows after a seq (payload still msgpack-encoded) */
  opsSince: (sinceSeq: number) => Array<{ seq: number; layerId: string | null; payloadBlob: Uint8Array }>;
  /** Layers that exist now (deleted layers drop out of the checkpoint) */
  layers: Array<{ id: string; name: string }>;
}

/** Newest snapshot that has pixels (old empty auto-checkpoints would hide every op before them) */
export function loadLatestBundle(snapshots: FoldSource['snapshots']): { seq: number; index: number; bundle: CanvasSnapshotBundle } | null {
  for (let index = 0; index < snapshots.length; index++) {
    const row = snapshots[index];
    try {
      if (!fs.existsSync(row.storagePath)) continue;
      const bundle = decodePacket(fs.readFileSync(row.storagePath)) as unknown as CanvasSnapshotBundle;
      if (!bundle?.layers?.some((l) => l.tiles?.length > 0 || l.vectorStrokes?.length) && !bundle?.authoritative) continue;
      return { seq: row.seq, index, bundle };
    } catch (err) {
      console.error(`[SnapshotService] Failed to load snapshot file ${row.storagePath}:`, err);
    }
  }
  return null;
}

export function decodeOpPayload(blob: Uint8Array): any {
  try {
    const decoded = decodePacket(blob) as any;
    return decoded.payload !== undefined ? decoded.payload : decoded;
  } catch {
    return null;
  }
}

/**
 * The server never rasterizes, but every op carries whole-tile replacements, so the latest tile
 * per (layer, col, row) IS the layer state at uptoSeq. Returns null when an op without tiles
 * (legacy samplePoints-only stroke) makes that unsound; clients then keep replaying the op log.
 */
export function foldLayerTiles(src: FoldSource, uptoSeq: number): LayerTileSnapshot[] | null {
  const latest = loadLatestBundle(src.snapshots);
  const base = latest && latest.seq <= uptoSeq ? latest : null;

  const tilesByLayer = new Map<string, Map<string, TileData>>();
  // Keyed by stroke id: vector edits (erase, reshape, undo) remove strokes by id, and an
  // append-only list brought erased strokes back on the next load
  const vectorByLayer = new Map<string, Map<string, any>>();
  const put = (layerId: string, tiles: TileData[], removedIds: string[] = [], added: any[] = []) => {
    let map = tilesByLayer.get(layerId);
    if (!map) tilesByLayer.set(layerId, (map = new Map()));
    for (const t of tiles) {
      if (t) map.set(`${t.col}_${t.row}`, t);
    }
    let vectors = vectorByLayer.get(layerId);
    if (!vectors) vectorByLayer.set(layerId, (vectors = new Map()));
    for (const id of removedIds) vectors.delete(id);
    for (const s of added) if (s?.id) vectors.set(s.id, s);
  };

  for (const l of base?.bundle.layers || []) put(l.layerId, l.tiles || [], [], l.vectorStrokes || []);

  for (const op of src.opsSince(base ? base.seq : 0)) {
    if (op.seq > uptoSeq) break;
    if (!op.layerId) continue;
    const p = decodeOpPayload(op.payloadBlob);
    if (!Array.isArray(p?.tiles)) return null;
    const added = Array.isArray(p.vectorAdded) ? p.vectorAdded : p.vectorStroke ? [p.vectorStroke] : [];
    put(op.layerId, p.tiles, Array.isArray(p.vectorRemovedIds) ? p.vectorRemovedIds : [], added);
  }

  return src.layers.map((l) => ({
    layerId: l.id,
    name: l.name,
    tiles: Array.from(tilesByLayer.get(l.id)?.values() || []),
    vectorStrokes: Array.from(vectorByLayer.get(l.id)?.values() || []),
  }));
}

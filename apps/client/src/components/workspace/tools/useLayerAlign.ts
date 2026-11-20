import type { MutableRefObject } from 'react';
import type { LayerMeta, LayerModel, ScopedUndoOp, TileCoord, VectorStroke } from '@atelier/shared';
import type { LayerManager } from '../../../engine/LayerManager';
import { findContentBounds } from '../../../utils/pixelBounds';
import {
  alignCrops, alignDestination, alignOffset, copyRgbaRect, rectMinus, selectionFrame,
  type AlignBasis, type AlignRect, type AlignX, type AlignY,
} from '../../../utils/layerAlign';
import { shiftVectorStroke } from '../../../services/offlineStore';
import type { ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

/** What one click did: moved, nothing to do, or it needs the user's OK first (part would leave the canvas) */
export type AlignOutcome = 'moved' | 'aligned' | 'empty' | 'confirm' | 'noSelection' | 'failed';

interface AlignDeps {
  layersRef: MutableRefObject<LayerModel[]>;
  /** Puts a vector edit's stroke-list change into the vector engine (and the vector panel) */
  applyVectorPayload: (layerId: string, payload: { vectorRemovedIds: string[]; vectorAdded: VectorStroke[] }) => void;
  /** Saves a layer's meta (synced to everyone) */
  updateLayerMeta: (layerId: string, meta: LayerMeta) => void;
}

type Work =
  | { kind: Exclude<AlignOutcome, 'moved'> }
  | { kind: 'moved'; dx: number; dy: number; beforeTiles: ScopedUndoOp['beforeTiles']; afterTiles: ScopedUndoOp['afterTiles'] };

/** The layer's painted pixels: the tiles it occupies read in one rect, and the bounds of what has alpha */
async function readContent(lm: LayerManager, layerId: string, canvasW: number, canvasH: number, ts: number) {
  const occupied = lm.occupiedTiles(layerId);
  if (occupied && occupied.length === 0) return null;
  let box: AlignRect = { x: 0, y: 0, w: canvasW, h: canvasH };
  if (occupied) {
    let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
    for (const c of occupied) {
      if (c.col < c0) c0 = c.col;
      if (c.row < r0) r0 = c.row;
      if (c.col > c1) c1 = c.col;
      if (c.row > r1) r1 = c.row;
    }
    const x = c0 * ts;
    const y = r0 * ts;
    box = { x, y, w: Math.min(canvasW, (c1 + 1) * ts) - x, h: Math.min(canvasH, (r1 + 1) * ts) - y };
  }
  const [px] = await lm.readAsync(layerId, [box]);
  const b = findContentBounds(px, box.w, box.h);
  if (!b) return null;
  return { px, box, rect: { x: box.x + b.minX, y: box.y + b.minY, w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1 } };
}

/**
 * 對齊 L1: moves the whole active layer by whole pixels so its painted area lines up with the
 * canvas or the selection's frame (the selection is only the frame: nothing is cut out of the
 * layer). One undo step; a text layer moves its text box with it and a vector layer its strokes,
 * so redrawing them later puts them where they now are.
 */
export function useLayerAlign(ctx: ToolContext, deps: AlignDeps) {
  const { canvas, layerManagerRef, tileEngineRef, selectionEngineRef, vectorEngineRef, scopedUndoRef, updateUndoRedoState, commitOp, userRef } = ctx;

  const alignLayer = (layer: LayerModel, x: AlignX | null, y: AlignY | null, basis: AlignBasis, allowCrop = false): Promise<AlignOutcome> => {
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    const item = lm?.getLayerItem(layer.id);
    if (!lm || !te || !item || !canvas) return Promise.resolve('failed');
    const W = canvas.width;
    const H = canvas.height;
    let frame: AlignRect = { x: 0, y: 0, w: W, h: H };
    if (basis === 'selection') {
      const sel = selectionEngineRef.current;
      const b = sel?.hasSelection() ? (sel.getMaskData()?.bounds ?? sel.getSelection()?.bounds) : null;
      if (!b) return Promise.resolve('noSelection');
      frame = selectionFrame(b);
    }
    const layerId = layer.id;
    const stillThere = () => layerManagerRef.current === lm && lm.getLayerItem(layerId) === item;

    const work = async (): Promise<Work> => {
      try {
        if (!stillThere()) return { kind: 'failed' };
        const content = await readContent(lm, layerId, W, H, te.tileSize);
        if (!stillThere()) return { kind: 'failed' };
        if (!content) return { kind: 'empty' };
        const r = content.rect;
        const { dx, dy } = alignOffset(r, frame, x, y);
        if (!dx && !dy) return { kind: 'aligned' };
        if (!allowCrop && alignCrops(r, dx, dy, W, H)) return { kind: 'confirm' };
        const dest = alignDestination(r, dx, dy, W, H);
        const destPx = dest && copyRgbaRect(content.px, content.box.w, {
          x: r.x - content.box.x + dest.sx, y: r.y - content.box.y + dest.sy, w: dest.w, h: dest.h,
        });
        const coords = new Map<string, TileCoord>();
        for (const rect of dest ? [r, dest] : [r]) {
          for (const c of te.getDirtyTilesForBounds(rect.x, rect.y, rect.x + rect.w - 1, rect.y + rect.h - 1)) coords.set(`${c.col}_${c.row}`, c);
        }
        const diff = diffTilesAsync(lm, layerId, [...coords.values()], () => {
          // Clear where the pixels were (except where they land), then write them at their new place
          for (const s of rectMinus(r, dest)) lm.writeRegion(layerId, s.x, s.y, s.w, s.h, new Uint8Array(s.w * s.h * 4));
          if (dest && destPx) lm.writeRegion(layerId, dest.x, dest.y, dest.w, dest.h, destPx);
        }, 'before');
        lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline
        const tiles = await diff;
        return { kind: 'moved', dx, dy, ...tiles };
      } catch (err) {
        console.warn('[align] failed:', err);
        return { kind: 'failed' };
      }
    };

    return new Promise<AlignOutcome>((resolve) => {
      commitInOrder(work, (res) => {
        if (res.kind !== 'moved') {
          resolve(res.kind);
          return;
        }
        try {
          const { dx, dy, beforeTiles, afterTiles } = res;
          const live = deps.layersRef.current.find((l) => l.id === layerId) ?? layer;
          const extra: Partial<ScopedUndoOp> = {};
          if (live.layerType === 'text' && live.meta?.text) {
            const metaAfter: LayerMeta = { ...live.meta, text: { ...live.meta.text, x: live.meta.text.x + dx, y: live.meta.text.y + dy } };
            extra.metaBefore = live.meta;
            extra.metaAfter = metaAfter;
            deps.updateLayerMeta(layerId, metaAfter);
          }
          let vector: { vectorRemovedIds: string[]; vectorAdded: VectorStroke[] } | null = null;
          const strokes = live.layerType === 'vector' ? vectorEngineRef.current?.getStrokes(layerId) ?? [] : [];
          if (strokes.length) {
            const before = strokes.map((s) => ({ ...s }));
            const after = before.map((s) => shiftVectorStroke(s, dx, dy));
            extra.vectorRemovedStrokes = before;
            extra.vectorAddedStrokes = after;
            // Same ids: removals go first wherever the list is replayed, so each stroke is replaced in place
            vector = { vectorRemovedIds: before.map((s) => s.id), vectorAdded: after };
          }
          scopedUndoRef.current.push({
            opId: `op_align_${Date.now()}`,
            userId: userRef.current?.id || 'guest',
            layerId,
            opType: 'STROKE',
            beforeTiles,
            afterTiles,
            timestamp: Date.now(),
            desc: '對齊',
            ...extra,
          });
          updateUndoRedoState();
          if (vector) {
            deps.applyVectorPayload(layerId, vector);
            commitOp(layerId, 'VECTOR_EDIT', { tiles: afterTiles, ...vector, actionDesc: '對齊' }, true);
          } else {
            commitOp(layerId, 'STROKE', { tool: 'align', tiles: afterTiles }, true);
          }
          resolve('moved');
        } catch (err) {
          console.warn('[align] commit failed:', err);
          resolve('failed');
        }
      });
    });
  };

  return { alignLayer };
}

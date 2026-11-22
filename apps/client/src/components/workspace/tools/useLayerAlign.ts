import type { MutableRefObject } from 'react';
import type { LayerMeta, LayerModel, ScopedUndoOp, TileCoord, VectorStroke } from '@atelier/shared';
import type { LayerManager } from '../../../engine/LayerManager';
import { findContentBounds } from '../../../utils/pixelBounds';
import {
  alignCrops, alignDestination, alignManyOffsets, copyRgbaRect, distributeOffsets,
  rectMinus, selectionFrame, unionRect,
  type AlignBasis, type AlignOutcome, type AlignRect, type AlignTargetUnit,
  type AlignX, type AlignY, type DistributeMode,
} from '../../../utils/layerAlign';
import { shiftVectorStroke } from '../../../services/offlineStore';
import type { ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

export {
  alignCrops, alignDestination, alignManyOffsets, copyRgbaRect, distributeOffsets,
  rectMinus, selectionFrame, unionRect,
  type AlignBasis, type AlignOutcome, type AlignRect, type AlignTargetUnit,
  type AlignX, type AlignY, type DistributeMode,
};

interface AlignDeps {
  layersRef: MutableRefObject<LayerModel[]>;
  /** Puts a vector edit's stroke-list change into the vector engine (and the vector panel) */
  applyVectorPayload: (layerId: string, payload: { vectorRemovedIds: string[]; vectorAdded: VectorStroke[] }) => void;
  /** Saves a layer's meta (synced to everyone) */
  updateLayerMeta: (layerId: string, meta: LayerMeta) => void;
}

type LayerContent = NonNullable<Awaited<ReturnType<typeof readContent>>>;

type MovedLayerEdit = {
  layer: LayerModel;
  dx: number;
  dy: number;
  beforeTiles: ScopedUndoOp['beforeTiles'];
  afterTiles: ScopedUndoOp['afterTiles'];
};

type BatchOp =
  | { kind: 'align'; x: AlignX | null; y: AlignY | null }
  | { kind: 'distribute'; mode: DistributeMode };

type Work =
  | { kind: Exclude<AlignOutcome, 'moved'> }
  | { kind: 'moved'; isDistribute: boolean; edits: MovedLayerEdit[] };

/** The layer's painted pixels: the tiles it occupies read in one rect, and the bounds of what has alpha (also used for a filter's starting centre) */
export async function readContent(lm: LayerManager, layerId: string, canvasW: number, canvasH: number, ts: number) {
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
 * 對齊・均分: moves layers or groups (with their masks) by whole pixels to align to objects, the
 * canvas, or the selection's frame, or to distribute evenly along edges, centres, or equal gaps.
 * Multi-layer moves share one undo groupId; text layers shift their box and vector layers shift
 * their strokes so redrawing keeps them in sync.
 */
export function useLayerAlign(ctx: ToolContext, deps: AlignDeps) {
  const {
    canvas, layerManagerRef, tileEngineRef, selectionEngineRef, vectorEngineRef,
    scopedUndoRef, updateUndoRedoState, commitOp, commitTilePatch, userRef,
  } = ctx;

  const runBatch = (
    targets: AlignTargetUnit<LayerModel>[],
    op: BatchOp,
    basis: AlignBasis,
    allowCrop = false,
  ): Promise<AlignOutcome> => {
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    if (!lm || !te || !canvas || targets.length === 0) return Promise.resolve('failed');
    const W = canvas.width;
    const H = canvas.height;
    const trackedLayers = targets.flatMap((t) => [...t.members, ...t.masks]);
    const itemByLayer = new Map<string, ReturnType<LayerManager['getLayerItem']>>();
    for (const layer of trackedLayers) {
      const item = lm.getLayerItem(layer.id);
      if (!item) return Promise.resolve('failed');
      itemByLayer.set(layer.id, item);
    }
    const stillThere = () =>
      layerManagerRef.current === lm &&
      tileEngineRef.current === te &&
      trackedLayers.every((l) => lm.getLayerItem(l.id) === itemByLayer.get(l.id));
    const isDistribute = op.kind === 'distribute';

    const work = async (): Promise<Work> => {
      try {
        if (!stillThere()) return { kind: 'failed' };
        const uniqueLayers = [...new Map(trackedLayers.map((l) => [l.id, l])).values()];
        const contents = await Promise.all(uniqueLayers.map((l) => readContent(lm, l.id, W, H, te.tileSize)));
        if (!stillThere()) return { kind: 'failed' };
        const contentByLayer = new Map<string, LayerContent | null>();
        uniqueLayers.forEach((l, idx) => contentByLayer.set(l.id, contents[idx]));

        const nonEmpty: Array<{ target: AlignTargetUnit<LayerModel>; rect: AlignRect }> = [];
        for (const target of targets) {
          const memberRects: AlignRect[] = [];
          for (const member of target.members) {
            const c = contentByLayer.get(member.id);
            if (c) memberRects.push(c.rect);
          }
          // Masks move by their target's delta without altering the target's visual bounds
          const rect = unionRect(memberRects);
          if (rect) nonEmpty.push({ target, rect });
        }

        if (nonEmpty.length === 0) return { kind: 'empty' };
        if (isDistribute) {
          if (nonEmpty.length < 2) return { kind: 'needMulti' };
          if (basis === 'objects' && nonEmpty.length < 3) return { kind: 'aligned' };
        } else if (basis === 'objects' && nonEmpty.length < 2) {
          return { kind: 'needMulti' };
        }

        let frame: AlignRect;
        if (basis === 'selection') {
          const sel = selectionEngineRef.current;
          const b = sel?.hasSelection() ? (sel.getMaskData()?.bounds ?? sel.getSelection()?.bounds) : null;
          if (!b) return { kind: 'noSelection' };
          frame = selectionFrame(b);
        } else if (basis === 'canvas') {
          frame = { x: 0, y: 0, w: W, h: H };
        } else {
          frame = unionRect(nonEmpty.map((t) => t.rect))!;
        }

        const rects = nonEmpty.map((t) => t.rect);
        const offsets = op.kind === 'distribute'
          ? distributeOffsets(rects, op.mode, basis, frame)
          : alignManyOffsets(rects, frame, op.x, op.y);

        const movable: Array<{ layer: LayerModel; content: LayerContent; dx: number; dy: number }> = [];
        nonEmpty.forEach(({ target }, index) => {
          const { dx, dy } = offsets[index];
          if (!dx && !dy) return;
          for (const layer of [...target.members, ...target.masks]) {
            const content = contentByLayer.get(layer.id);
            if (content) movable.push({ layer, content, dx, dy });
          }
        });

        if (movable.length === 0) return { kind: 'aligned' };
        if (!allowCrop && movable.some((m) => alignCrops(m.content.rect, m.dx, m.dy, W, H))) {
          return { kind: 'confirm' };
        }

        const edits = await Promise.all(
          movable.map(async ({ layer, content, dx, dy }) => {
            const layerId = layer.id;
            const r = content.rect;
            const dest = alignDestination(r, dx, dy, W, H);
            const destPx = dest && copyRgbaRect(content.px, content.box.w, {
              x: r.x - content.box.x + dest.sx, y: r.y - content.box.y + dest.sy, w: dest.w, h: dest.h,
            });
            const coords = new Map<string, TileCoord>();
            for (const rect of dest ? [r, dest] : [r]) {
              for (const c of te.getDirtyTilesForBounds(rect.x, rect.y, rect.x + rect.w - 1, rect.y + rect.h - 1)) {
                coords.set(`${c.col}_${c.row}`, c);
              }
            }
            const diff = diffTilesAsync(lm, layerId, [...coords.values()], () => {
              // Clear where the pixels were (except where they land), then write them at their new place
              for (const s of rectMinus(r, dest)) lm.writeRegion(layerId, s.x, s.y, s.w, s.h, new Uint8Array(s.w * s.h * 4));
              if (dest && destPx) lm.writeRegion(layerId, dest.x, dest.y, dest.w, dest.h, destPx);
            }, 'before');
            lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline
            const tiles = await diff;
            return { layer, dx, dy, ...tiles };
          }),
        );
        return { kind: 'moved', isDistribute, edits };
      } catch (err) {
        console.warn(`[${isDistribute ? 'distribute' : 'align'}] failed:`, err);
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
          const now = Date.now();
          const userId = userRef.current?.id || 'guest';
          const groupId = res.edits.length > 1
            ? `grp_${res.isDistribute ? 'dist' : 'align'}_${now}_${Math.random().toString(36).slice(2, 6)}`
            : undefined;
          const desc = res.isDistribute ? '均分' : '對齊';
          res.edits.forEach((edit, i) => {
            const { layer, dx, dy, beforeTiles, afterTiles } = edit;
            const layerId = layer.id;
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
              opId: `op_${res.isDistribute ? 'dist' : 'align'}_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
              userId,
              layerId,
              opType: 'STROKE',
              ...(groupId ? { groupId } : {}),
              beforeTiles,
              afterTiles,
              timestamp: now,
              desc,
              ...extra,
            });
            // Commit immediately after pushing so peekLatestForLayer(layerId) binds baseSeq/seq cleanly
            if (vector) {
              deps.applyVectorPayload(layerId, vector);
              commitOp(layerId, 'VECTOR_EDIT', { tiles: afterTiles, ...vector, actionDesc: desc }, true);
            } else {
              commitTilePatch(layerId, afterTiles, false, desc, true);
            }
          });
          updateUndoRedoState();
          resolve('moved');
        } catch (err) {
          console.warn(`[${res.isDistribute ? 'distribute' : 'align'}] commit failed:`, err);
          resolve('failed');
        }
      });
    });
  };

  const alignTargets = (
    targets: AlignTargetUnit<LayerModel>[],
    x: AlignX | null,
    y: AlignY | null,
    basis: AlignBasis,
    allowCrop = false,
  ): Promise<AlignOutcome> => runBatch(targets, { kind: 'align', x, y }, basis, allowCrop);

  const distributeTargets = (
    targets: AlignTargetUnit<LayerModel>[],
    mode: DistributeMode,
    basis: AlignBasis,
    allowCrop = false,
  ): Promise<AlignOutcome> => runBatch(targets, { kind: 'distribute', mode }, basis, allowCrop);

  return { alignTargets, distributeTargets };
}

import { useRef, useState } from 'react';
import type { LayerModel } from '@atelier/shared';
import { LiquifyEngine, LiquifyMode } from '../../../engine/LiquifyEngine';
import { BlurSmudgeEngine, SmudgeMode } from '../../../engine/BlurSmudgeEngine';
import { RulerManager } from '../../../engine/RulerManager';
import type { Bounds, Point, ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

export const LIQUIFY_TOOLS = ['liquify', 'blur', 'smudge'];

/** Liquify, blur and smudge: brushes that move existing pixels; one undo step per drag. */
export function useLiquifyTool(ctx: ToolContext) {
  const liquifyEngineRef = useRef<LiquifyEngine | null>(null);
  const blurSmudgeEngineRef = useRef<BlurSmudgeEngine | null>(null);
  const [liquifyMode, setLiquifyMode] = useState<LiquifyMode>('push');
  const [liquifyRadius, setLiquifyRadius] = useState<number>(60);
  const [liquifyStrength, setLiquifyStrength] = useState<number>(0.5);
  const [liquifyHardness, setLiquifyHardness] = useState<number>(0.5);
  const [liquifyRefAreaOnly, setLiquifyRefAreaOnly] = useState<boolean>(false);
  const [smudgeMode, setSmudgeMode] = useState<SmudgeMode>('smudge');
  const isLiquifyingRef = useRef<boolean>(false);
  const lastLiquifyPosRef = useRef<Point | null>(null);
  const liquifyTouchedBoundsRef = useRef<Bounds | null>(null);

  const start = (layer: LayerModel, local: Point) => {
    const { layerManagerRef, tileEngineRef, currentTool } = ctx;
    if (!layerManagerRef.current || !tileEngineRef.current || !layerManagerRef.current.getLayerItem(layer.id)) return;
    layerManagerRef.current.syncPingPong(layer.id);
    isLiquifyingRef.current = true;
    lastLiquifyPosRef.current = { x: local.x, y: local.y };
    liquifyTouchedBoundsRef.current = null;
    if (currentTool === 'liquify') {
      liquifyEngineRef.current?.beginStroke(layerManagerRef.current, layer.id);
    }
    blurSmudgeEngineRef.current?.resetSmudge();
  };

  /** One step of the active drag; false when no drag is active. */
  const move = (local: Point): boolean => {
    const { activeLayer, layerManagerRef, selectionEngineRef, currentTool, brushProps } = ctx;
    if (!isLiquifyingRef.current || !activeLayer || !layerManagerRef.current || !lastLiquifyPosRef.current) return false;
    const item = layerManagerRef.current.getLayerItem(activeLayer.id);
    if (!item) return true;
    const prev = lastLiquifyPosRef.current;
    const dx = local.x - prev.x;
    const dy = local.y - prev.y;
    lastLiquifyPosRef.current = { x: local.x, y: local.y };

    const selMask = selectionEngineRef.current?.getMaskData()?.data;
    let stepBounds: Bounds | null = null;
    const mergeBounds = (b: Bounds | null) => {
      if (!b) return;
      stepBounds = stepBounds
        ? { minX: Math.min(stepBounds.minX, b.minX), minY: Math.min(stepBounds.minY, b.minY), maxX: Math.max(stepBounds.maxX, b.maxX), maxY: Math.max(stepBounds.maxY, b.maxY) }
        : { ...b };
    };

    const rulerMgr = RulerManager.getInstance();
    const symPoints = rulerMgr.state.mode === 'symmetry' ? rulerMgr.getSymmetryPoints(local) : [local];
    // Mirrored copies push the opposite way on every other axis
    const symDelta = (i: number) => (i === 0 || i % 2 === 0 ? { dx, dy } : { dx: -dx, dy: -dy });

    if (currentTool === 'liquify' && liquifyEngineRef.current) {
      symPoints.forEach((pt, i) => {
        const d = symDelta(i);
        mergeBounds(liquifyEngineRef.current!.applyStep(null, pt.x, pt.y, d.dx, d.dy,
          {
            mode: liquifyMode,
            radius: liquifyRadius,
            strength: liquifyStrength,
            hardness: liquifyHardness,
            referenceAreaOnly: liquifyRefAreaOnly,
          }, selMask));
      });
    } else if (currentTool === 'blur' && blurSmudgeEngineRef.current) {
      const target = { layerManager: layerManagerRef.current, layerId: activeLayer.id };
      for (const pt of symPoints) {
        mergeBounds(blurSmudgeEngineRef.current.applyBlurStep(target, pt.x, pt.y,
          { radius: brushProps.size, strength: brushProps.flow * brushProps.opacity }, selMask));
      }
    } else if (currentTool === 'smudge' && blurSmudgeEngineRef.current) {
      const engine = blurSmudgeEngineRef.current;
      const target = { layerManager: layerManagerRef.current, layerId: activeLayer.id };
      // Each mirrored copy has its own tip, following its own mirrored path. Strength is the
      // options bar's 強度 (flow) alone: the brush's 混色 is 0 by default and used to zero it out
      const prevPoints = rulerMgr.state.mode === 'symmetry' ? rulerMgr.getSymmetryPoints(prev) : [prev];
      symPoints.forEach((pt, i) => {
        const from = prevPoints[i] ?? pt;
        mergeBounds(engine.applySmudgeSegment(target, i, from.x, from.y, pt.x, pt.y,
          { radius: brushProps.size, strength: brushProps.flow, smudgeMode }, selMask));
      });
    }

    const step = stepBounds as Bounds | null;
    if (step) {
      const touched = liquifyTouchedBoundsRef.current;
      liquifyTouchedBoundsRef.current = touched
        ? { minX: Math.min(touched.minX, step.minX), minY: Math.min(touched.minY, step.minY), maxX: Math.max(touched.maxX, step.maxX), maxY: Math.max(touched.maxY, step.maxY) }
        : step;
      ctx.requestRender();
    }
    return true;
  };

  /** Commits the drag as one op and undo step; false when no drag was active. */
  const finish = (): boolean => {
    const { activeLayer, layerManagerRef, tileEngineRef, currentTool, user, scopedUndoRef } = ctx;
    if (!isLiquifyingRef.current || !activeLayer || !layerManagerRef.current || !tileEngineRef.current) return false;
    isLiquifyingRef.current = false;
    liquifyEngineRef.current?.endStroke();
    blurSmudgeEngineRef.current?.resetSmudge();
    const item = layerManagerRef.current.getLayerItem(activeLayer.id);
    const bounds = liquifyTouchedBoundsRef.current;
    liquifyTouchedBoundsRef.current = null;
    lastLiquifyPosRef.current = null;
    if (!item || !bounds) return true;

    const dirtyCoords = tileEngineRef.current.getDirtyTilesForBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    const desc = currentTool === 'liquify'
      ? `液化筆刷 (${liquifyMode})`
      : currentTool === 'blur'
        ? '局部模糊筆刷'
        : smudgeMode === 'blend'
          ? '原位融合揉色筆刷'
          : '拖曳揉色筆刷';
    const lm = layerManagerRef.current;
    const layerId = activeLayer.id;
    // Before (ping-pong) and after are queued now and read without stalling; LZ4 in the workers
    const work = diffTilesAsync(lm, layerId, dirtyCoords, () => {}, 'before');
    lm.syncPingPong(layerId); // queued after the reads: the next drag's baseline
    commitInOrder(work, ({ beforeTiles, afterTiles }) => {
      if (user && afterTiles.length > 0) {
        scopedUndoRef.current.push({
          opId: `op_${currentTool}_${Date.now()}`,
          userId: user.id,
          layerId,
          opType: 'STROKE',
          beforeTiles,
          afterTiles,
          timestamp: Date.now(),
          desc,
        });
        ctx.updateUndoRedoState();
      }
      ctx.commitTilePatch(layerId, afterTiles, false, desc, true);
    });
    return true;
  };

  /** Drops a drag without committing (multi-touch gesture, canvas switch); the caller reverts the layer. */
  const cancel = () => {
    isLiquifyingRef.current = false;
    liquifyEngineRef.current?.endStroke();
    blurSmudgeEngineRef.current?.resetSmudge();
    lastLiquifyPosRef.current = null;
    liquifyTouchedBoundsRef.current = null;
  };

  return {
    liquifyEngineRef,
    blurSmudgeEngineRef,
    liquifyMode,
    setLiquifyMode,
    liquifyRadius,
    setLiquifyRadius,
    liquifyStrength,
    setLiquifyStrength,
    liquifyHardness,
    setLiquifyHardness,
    liquifyRefAreaOnly,
    setLiquifyRefAreaOnly,
    smudgeMode,
    setSmudgeMode,
    isActive: () => isLiquifyingRef.current,
    start,
    move,
    finish,
    cancel,
  };
}

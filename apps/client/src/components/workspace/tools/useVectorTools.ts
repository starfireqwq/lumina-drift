import { useEffect, useRef, useState } from 'react';
import { evaluatePressureCurve, hitTestVectorStroke, LayerModel, TileData, ToolType, VectorEraserMode, VectorStroke, VectorWidthMode } from '@atelier/shared';
import { VectorEditResult } from '../../../engine/VectorEngine';
import { RulerManager } from '../../../engine/RulerManager';
import { startTabletStroke, type TabletStroke } from '../../../engine/tabletInput';
import { buildPenStroke, deleteAnchor, hitTestNodes, moveAnchor, moveHandle, PenPoint, toggleCorner, VectorHit } from '../../../engine/vectorEditing';
import type { BezierMode } from '../ToolOptionsBar';
import type { Point, ToolContext } from './toolContext';
import { commitInOrder, tilesAsync } from './asyncTiles';
import { recordUsedColor } from '../../../services/colorHistoryStore';

type PenPointer = { pressure: number; pointerType: string; altKey: boolean };
type StrokePoint = Point & { pressure?: number };

/** Mirrored copies of a path when the symmetry ruler is on (the path itself first) */
const symmetryTrajectories = (pts: StrokePoint[]): StrokePoint[][] => {
  const rulerMgr = RulerManager.getInstance();
  if (rulerMgr.state.mode !== 'symmetry' || pts.length === 0) return [pts];
  const count = rulerMgr.getSymmetryPoints(pts[0]).length;
  const out = [pts];
  for (let s = 1; s < count; s++) {
    out.push(pts.map((p) => {
      const sym = rulerMgr.getSymmetryPoints(p)[s];
      return sym ? { x: sym.x, y: sym.y, pressure: p.pressure } : { ...p };
    }));
  }
  return out;
};

/**
 * Vector layer tools: freehand vector pen, vector eraser / pinch (reshape) / width, the Bézier pen
 * (vector_bezier) and node editing (vector_edit). Every change to a layer's stroke list goes out as
 * vectorRemovedIds / vectorAdded so sync, replay and undo agree on which strokes exist.
 */
export function useVectorTools(ctx: ToolContext) {
  const {
    brushProps, vectorEngineRef, activeLayerRef, layerManagerRef, tileEngineRef, viewportRef, scopedUndoRef, userRef,
    brushPropsRef, currentToolRef, commitOp, updateUndoRedoState, canEditPixels,
  } = ctx;
  const [vectorEraserMode, setVectorEraserMode] = useState<VectorEraserMode>('intersect');
  const [vectorWidthMode, setVectorWidthMode] = useState<VectorWidthMode>('thicken');
  const [vectorStrokesList, setVectorStrokesList] = useState<VectorStroke[]>([]);
  const currentVectorPointsRef = useRef<StrokePoint[]>([]);
  const tabletStrokeRef = useRef<TabletStroke | null>(null);
  const isVectorDrawingRef = useRef<boolean>(false);
  const lastVectorPointerPosRef = useRef<Point | null>(null);

  // Bézier pen (vector_bezier) and node editing (vector_edit)
  const [bezierMode, setBezierMode] = useState<BezierMode>('pen');
  const [penPoints, setPenPoints] = useState<PenPoint[]>([]);
  const penPointsRef = useRef<PenPoint[]>([]);
  penPointsRef.current = penPoints;
  const penDragRef = useRef<{ index: number; startX: number; startY: number } | null>(null);
  const lastPenClickRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const [penHover, setPenHover] = useState<Point | null>(null);
  const [vectorSel, setVectorSel] = useState<{ strokeId: string; index: number } | null>(null);
  const [selectedStrokeIds, setSelectedStrokeIds] = useState<string[]>([]);
  const selectedStrokeIdsRef = useRef<string[]>([]);
  selectedStrokeIdsRef.current = selectedStrokeIds;
  const vectorDragRef = useRef<{ hit: VectorHit; original: VectorStroke; moved: boolean } | null>(null);
  const [vectorPreview, setVectorPreview] = useState<VectorStroke | null>(null);
  const lastVectorClickRef = useRef<{ t: number; strokeId: string; index: number } | null>(null);

  useEffect(() => {
    setVectorSel(null);
    setSelectedStrokeIds([]);
    setVectorPreview(null);
  }, [ctx.activeLayer?.id]);
  // One undo step per vector-editing drag (the eraser / reshape commit on every move)
  const vectorGestureRef = useRef<{
    layerId: string;
    before: Map<string, TileData>;
    removed: Map<string, VectorStroke>;
    added: Map<string, VectorStroke>;
    desc: string;
  } | null>(null);

  /* ---------- Vector list changes: one path for sync, replay and undo ---------- */

  /** Applies vectorRemovedIds / vectorAdded (or a legacy single vectorStroke) from an op payload. */
  const applyVectorPayload = (layerId: string, payload: any) => {
    const engine = vectorEngineRef.current;
    if (!engine || !payload) return;
    const added = Array.isArray(payload.vectorAdded) ? payload.vectorAdded : payload.vectorStroke ? [payload.vectorStroke] : undefined;
    const removed = Array.isArray(payload.vectorRemovedIds) ? payload.vectorRemovedIds : undefined;
    if (!added && !removed) return;
    engine.applyDelta(layerId, removed, added);
    if (activeLayerRef.current?.id === layerId) {
      const nextList = engine.getStrokes(layerId);
      setVectorStrokesList(nextList);
      if (selectedStrokeIdsRef.current.length > 0) {
        const valid = new Set(nextList.map((s) => s.id));
        const filtered = selectedStrokeIdsRef.current.filter((id) => valid.has(id));
        if (filtered.length !== selectedStrokeIdsRef.current.length) setSelectedStrokeIds(filtered);
      }
    }
  };

  /** Sends one vector edit and folds it into the current drag's undo step. */
  const commitVectorEditResult = (layerId: string, res: VectorEditResult, desc: string) => {
    if (res.removed.length === 0 && res.added.length === 0) return;
    commitOp(layerId, 'VECTOR_EDIT', {
      tiles: res.dirtyTiles,
      vectorRemovedIds: res.removed.map((s) => s.id),
      vectorAdded: res.added,
      actionDesc: desc,
    });
    let g = vectorGestureRef.current;
    if (!g || g.layerId !== layerId) {
      if (g) finishVectorGesture();
      g = vectorGestureRef.current = { layerId, before: new Map(), removed: new Map(), added: new Map(), desc };
    }
    for (const t of res.beforeTiles) {
      const key = `${t.col}_${t.row}`;
      if (!g.before.has(key)) g.before.set(key, t);
    }
    // Net change of the whole drag: a piece made and erased again within it is no change
    for (const s of res.removed) {
      if (g.added.has(s.id)) g.added.delete(s.id);
      else if (!g.removed.has(s.id)) g.removed.set(s.id, s);
    }
    for (const s of res.added) g.added.set(s.id, s);
    setVectorStrokesList(vectorEngineRef.current?.getStrokes(layerId) ?? []);
  };

  const finishVectorGesture = () => {
    const g = vectorGestureRef.current;
    vectorGestureRef.current = null;
    const lm = layerManagerRef.current;
    if (!g || !lm?.getLayerItem(g.layerId)) return;
    const beforeTiles = Array.from(g.before.values());
    const userId = userRef.current?.id || 'guest';
    commitInOrder(tilesAsync(lm, g.layerId, beforeTiles), (afterTiles) => {
      if (layerManagerRef.current !== lm) return;
      scopedUndoRef.current.push({
        opId: `op_vecedit_${Date.now()}`, userId, layerId: g.layerId, opType: 'STROKE', beforeTiles, afterTiles,
        vectorRemovedStrokes: Array.from(g.removed.values()),
        vectorAddedStrokes: Array.from(g.added.values()),
        timestamp: Date.now(), desc: g.desc,
      });
      updateUndoRedoState();
    });
  };

  const editableVectorTarget = (layer: LayerModel | null) => {
    const item = layer && layerManagerRef.current?.getLayerItem(layer.id);
    return item && vectorEngineRef.current && tileEngineRef.current && canEditPixels(layer!) ? item : null;
  };

  /* ---------- Bézier pen (vector_bezier) ---------- */

  const finishPenPath = (closed: boolean) => {
    const points = penPointsRef.current;
    setPenPoints([]);
    penPointsRef.current = [];
    setPenHover(null);
    penDragRef.current = null;
    const layer = activeLayerRef.current;
    const item = editableVectorTarget(layer);
    if (!layer || !item || points.length < 2) return;
    const props = brushPropsRef.current || brushProps;
    const stroke = buildPenStroke(layer.id, points, bezierMode, { color: props.color, width: props.size, opacity: props.opacity }, closed);
    if (!stroke) return;
    const res = vectorEngineRef.current!.addPreparedStroke(vectorEngineRef.current!.targetForLayer(layerManagerRef.current!, layer.id), layer.id, stroke);
    scopedUndoRef.current.push({
      opId: `op_vecpen_${Date.now()}`,
      userId: userRef.current?.id || 'guest',
      layerId: layer.id,
      opType: 'STROKE',
      beforeTiles: res.beforeTiles,
      afterTiles: res.dirtyTiles,
      vectorRemovedStrokes: [],
      vectorAddedStrokes: [stroke],
      timestamp: Date.now(),
      desc: '鋼筆曲線',
    });
    updateUndoRedoState();
    commitOp(layer.id, 'STROKE', { tool: 'vector_bezier', vectorStroke: stroke, vectorAdded: [stroke], tiles: res.dirtyTiles });
    recordUsedColor(stroke.color);
    setVectorStrokesList(vectorEngineRef.current!.getStrokes(layer.id));
  };

  const penPointerDown = (local: { x: number; y: number }, e: PointerEvent, layer: LayerModel) => {
    if (!editableVectorTarget(layer)) return;
    const zoom = viewportRef.current?.getState().zoom || 1;
    const points = penPointsRef.current;
    const now = Date.now();
    const last = lastPenClickRef.current;
    lastPenClickRef.current = { t: now, x: local.x, y: local.y };
    // Double click finishes; a click on the first point closes the path
    if (last && now - last.t < 350 && Math.hypot(local.x - last.x, local.y - last.y) < 6 / zoom && points.length >= 2) {
      finishPenPath(false);
      return;
    }
    if (points.length >= 3 && Math.hypot(local.x - points[0].x, local.y - points[0].y) < 9 / zoom) {
      finishPenPath(true);
      return;
    }
    const next = [...points, { x: local.x, y: local.y, corner: bezierMode === 'curve' && e.altKey }];
    setPenPoints(next);
    penPointsRef.current = next;
    penDragRef.current = { index: next.length - 1, startX: local.x, startY: local.y };
  };

  const penPointerMove = (local: { x: number; y: number }) => {
    const drag = penDragRef.current;
    if (!drag) {
      if (penPointsRef.current.length > 0) setPenHover(local);
      return;
    }
    if (bezierMode !== 'pen') return;
    const zoom = viewportRef.current?.getState().zoom || 1;
    if (Math.hypot(local.x - drag.startX, local.y - drag.startY) < 3 / zoom) return;
    // Dragging from a new point pulls out its handle: a smooth curve through it
    const next = penPointsRef.current.map((p, i) => (i === drag.index ? { ...p, hx: local.x, hy: local.y, corner: false } : p));
    setPenPoints(next);
    penPointsRef.current = next;
  };

  /* ---------- Node editing (vector_edit) ---------- */

  const hitTestVectorStrokeAt = (s: VectorStroke, p: { x: number; y: number }, r: number) => hitTestVectorStroke(s, p.x, p.y, r);
  const strokeById = (layerId: string, id: string) => vectorEngineRef.current?.getStrokes(layerId).find((s) => s.id === id) ?? null;

  const replaceVectorStroke = (layer: LayerModel, oldId: string, next: VectorStroke | null, desc: string) => {
    const item = editableVectorTarget(layer);
    if (!item) return;
    const res = vectorEngineRef.current!.replaceStrokes(vectorEngineRef.current!.targetForLayer(layerManagerRef.current!, layer.id), layer.id, [oldId], next ? [next] : []);
    commitVectorEditResult(layer.id, res, desc);
    finishVectorGesture();
  };

  const vectorEditPointerDown = (local: { x: number; y: number }, layer: LayerModel, additive = false) => {
    const engine = vectorEngineRef.current;
    if (!engine || !editableVectorTarget(layer)) return;
    const zoom = viewportRef.current?.getState().zoom || 1;
    const strokes = engine.getStrokes(layer.id);
    const hit = hitTestNodes(strokes, local, 9 / zoom, vectorSel?.strokeId ?? null);
    if (hit) {
      if (additive) {
        const prev = selectedStrokeIdsRef.current;
        const exists = prev.includes(hit.strokeId);
        const next = exists ? prev.filter((id) => id !== hit.strokeId) : [...prev, hit.strokeId];
        setSelectedStrokeIds(next);
        setVectorSel(exists ? (next.length > 0 ? { strokeId: next[next.length - 1], index: -1 } : null) : { strokeId: hit.strokeId, index: hit.index });
        setVectorPreview(null);
        return;
      }
      const now = Date.now();
      const last = lastVectorClickRef.current;
      lastVectorClickRef.current = { t: now, strokeId: hit.strokeId, index: hit.index };
      const stroke = strokeById(layer.id, hit.strokeId);
      if (!stroke) return;
      if (hit.handle === 'anchor' && last && now - last.t < 350 && last.strokeId === hit.strokeId && last.index === hit.index) {
        replaceVectorStroke(layer, stroke.id, toggleCorner(stroke, hit.index), '切換尖角／平滑');
        return;
      }
      setSelectedStrokeIds([hit.strokeId]);
      setVectorSel({ strokeId: hit.strokeId, index: hit.index });
      vectorDragRef.current = { hit, original: stroke, moved: false };
      return;
    }
    // Clicking a line selects it (Shift toggles multi-selection); empty space clears selection
    const onLine = strokes.find((s) => hitTestVectorStrokeAt(s, local, 6 / zoom));
    if (onLine) {
      if (additive) {
        const prev = selectedStrokeIdsRef.current;
        const exists = prev.includes(onLine.id);
        const next = exists ? prev.filter((id) => id !== onLine.id) : [...prev, onLine.id];
        setSelectedStrokeIds(next);
        setVectorSel(next.length > 0 ? { strokeId: next[next.length - 1], index: -1 } : null);
      } else {
        setSelectedStrokeIds([onLine.id]);
        setVectorSel({ strokeId: onLine.id, index: -1 });
      }
    } else if (!additive) {
      setSelectedStrokeIds([]);
      setVectorSel(null);
    }
    setVectorPreview(null);
  };

  const vectorEditPointerMove = (local: { x: number; y: number }, altKey: boolean) => {
    const drag = vectorDragRef.current;
    if (!drag) return;
    drag.moved = true;
    const { hit, original } = drag;
    setVectorPreview(hit.handle === 'anchor'
      ? moveAnchor(original, hit.index, local)
      : moveHandle(original, hit.index, hit.handle, local, altKey));
  };

  const vectorEditPointerUp = () => {
    const drag = vectorDragRef.current;
    vectorDragRef.current = null;
    const layer = activeLayerRef.current;
    const preview = vectorPreview;
    setVectorPreview(null);
    if (!drag || !drag.moved || !preview || !layer) return;
    replaceVectorStroke(layer, drag.original.id, preview, '節點編輯');
  };

  const selectedVectorAnchor = () => {
    const layer = activeLayerRef.current;
    if (!layer || !vectorSel || vectorSel.index < 0) return null;
    const stroke = strokeById(layer.id, vectorSel.strokeId);
    return stroke && stroke.anchors[vectorSel.index] ? { layer, stroke, index: vectorSel.index } : null;
  };

  const toggleSelectedAnchorCorner = () => {
    const sel = selectedVectorAnchor();
    if (sel) replaceVectorStroke(sel.layer, sel.stroke.id, toggleCorner(sel.stroke, sel.index), '切換尖角／平滑');
  };

  const deleteSelectedAnchor = () => {
    const sel = selectedVectorAnchor();
    if (!sel) return;
    replaceVectorStroke(sel.layer, sel.stroke.id, deleteAnchor(sel.stroke, sel.index), '刪除向量節點');
    setVectorSel(null);
  };

  /** Keys for the pen path / node selection; true when the key was used. */
  const handleVectorKey = (ev: KeyboardEvent) => {
    const tool = currentToolRef.current;
    if (tool === 'vector_bezier' && penPointsRef.current.length > 0) {
      if (ev.key === 'Enter') { finishPenPath(false); return true; }
      if (ev.key === 'Escape') { setPenPoints([]); penPointsRef.current = []; setPenHover(null); return true; }
      if (ev.key === 'Backspace') {
        const next = penPointsRef.current.slice(0, -1);
        setPenPoints(next);
        penPointsRef.current = next;
        return true;
      }
    }
    if (tool === 'vector_edit' && (ev.key === 'Delete' || ev.key === 'Backspace') && selectedVectorAnchor()) {
      deleteSelectedAnchor();
      return true;
    }
    if (tool === 'vector_edit' && ev.key === 'Escape' && (vectorSel || selectedStrokeIdsRef.current.length > 0)) {
      setVectorSel(null);
      setSelectedStrokeIds([]);
      return true;
    }
    return false;
  };

  const cancelPenPath = () => {
    setPenPoints([]);
    penPointsRef.current = [];
    setPenHover(null);
  };

  /** Called before the tool changes: a pen path in progress is kept (finished), not thrown away */
  const onToolChange = (tool: ToolType) => {
    if (currentToolRef.current === 'vector_bezier' && tool !== 'vector_bezier') finishPenPath(false);
    if (tool !== 'vector_edit') {
      setVectorSel(null);
      setVectorPreview(null);
    }
  };

  /* ---------- Freehand vector pen and the drag tools (eraser, pinch, width) ---------- */

  /** Drag tools of vector layers; brush, pencil and eraser act as them on a vector layer */
  const isVectorDragTool = (tool: ToolType, layer: LayerModel) =>
    tool === 'vector_pen' || tool === 'vector_eraser' || tool === 'vector_reshape' || tool === 'vector_width'
    || (layer.layerType === 'vector' && (tool === 'brush' || tool === 'pencil' || tool === 'eraser'));
  const erasesVectors = (tool: ToolType, layer: LayerModel) =>
    tool === 'vector_eraser' || (layer.layerType === 'vector' && (tool === 'eraser' || brushProps.isEraser));

  const eraseAt = (layer: LayerModel, local: Point, size = brushProps.size) => {
    const engine = vectorEngineRef.current!;
    const args = [engine.targetForLayer(layerManagerRef.current!, layer.id), layer.id, local.x, local.y, size] as const;
    let res: VectorEditResult;
    switch (vectorEraserMode) {
      case 'intersect': res = engine.eraseToIntersections(...args); break;
      case 'partial': res = engine.erasePartialStrokes(...args); break;
      default: res = engine.eraseEntireStrokes(...args); break;
    }
    commitVectorEditResult(layer.id, res, '向量橡皮擦');
  };

  const startDrag = (e: PointerEvent, local: Point, layer: LayerModel, tailSize?: number) => {
    const item = layerManagerRef.current?.getLayerItem(layer.id);
    const engine = vectorEngineRef.current;
    if (!item || !engine || !tileEngineRef.current) return;
    RulerManager.getInstance().onStrokeStart(local);
    isVectorDrawingRef.current = true;
    lastVectorPointerPosRef.current = { x: local.x, y: local.y };
    const tool = ctx.currentTool;
    if (tailSize !== undefined || erasesVectors(tool, layer)) {
      eraseAt(layer, local, tailSize);
    } else if (tool === 'vector_width') {
      const delta = vectorWidthMode === 'thicken' ? 2.0 : -2.0;
      commitVectorEditResult(layer.id, engine.adjustStrokesWidth(engine.targetForLayer(layerManagerRef.current!, layer.id), layer.id, local, brushProps.size, delta), '向量線寬微調');
    } else if (tool !== 'vector_reshape') {
      tabletStrokeRef.current?.finish();
      const tablet = startTabletStroke(e, false);
      tabletStrokeRef.current = tablet;
      currentVectorPointsRef.current = [{ x: local.x, y: local.y, pressure: evaluatePressureCurve(tablet.pressure(e).normalized, tablet.curve) }];
    }
  };

  const drawPenPreview = () => {
    const g = ctx.shapeGraphicRef.current;
    const pts = currentVectorPointsRef.current;
    if (!g || pts.length < 2) return;
    g.clear();
    const hex = (brushProps.color || '#3B82F6').replace('#', '');
    const colorNum = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16) || 0x3b82f6;
    for (const traj of symmetryTrajectories(pts)) {
      if (traj.length < 2) continue;
      g.moveTo(traj[0].x, traj[0].y);
      for (let i = 1; i < traj.length; i++) g.lineTo(traj[i].x, traj[i].y);
    }
    g.stroke({ width: Math.max(1, brushProps.size || 4), color: colorNum, alpha: Math.max(0.1, brushProps.opacity || 1), cap: 'round', join: 'round' });
    ctx.requestRender();
  };

  /** One step of the active drag; false when no vector drag is active. */
  const moveDrag = (e: PointerEvent, local: Point, tailSize?: number): boolean => {
    const layer = ctx.activeLayer;
    const engine = vectorEngineRef.current;
    if (!isVectorDrawingRef.current || !layer || !layerManagerRef.current || !engine) return false;
    const item = layerManagerRef.current.getLayerItem(layer.id);
    if (!item) return true;
    const tool = ctx.currentTool;
    if (tailSize !== undefined || erasesVectors(tool, layer)) {
      eraseAt(layer, local, tailSize);
    } else if (tool === 'vector_reshape') {
      const last = lastVectorPointerPosRef.current;
      if (last) {
        const res = engine.pinchStrokes(engine.targetForLayer(layerManagerRef.current!, layer.id), layer.id, local, { x: local.x - last.x, y: local.y - last.y }, brushProps.size);
        commitVectorEditResult(layer.id, res, '向量修線捏線');
        ctx.requestRender();
      }
      lastVectorPointerPosRef.current = { x: local.x, y: local.y };
    } else if (tool === 'vector_width') {
      const delta = vectorWidthMode === 'thicken' ? 1.5 : -1.5;
      commitVectorEditResult(layer.id, engine.adjustStrokesWidth(engine.targetForLayer(layerManagerRef.current!, layer.id), layer.id, local, brushProps.size, delta), '向量線寬微調');
      ctx.requestRender();
    } else {
      // Vector pen: snapped to the active ruler (parallel, perspective, concentric)
      const pt = RulerManager.getInstance().snapPoint(local).point;
      const tablet = tabletStrokeRef.current;
      if (tablet && tablet.pointerId === e.pointerId && tablet.isContact(e)) {
        currentVectorPointsRef.current.push({ x: pt.x, y: pt.y, pressure: evaluatePressureCurve(tablet.pressure(e).normalized, tablet.curve) });
      }
      drawPenPreview();
    }
    return true;
  };

  /** Commits the pen stroke (with its mirrored copies) or closes the edit drag's undo step; false when no drag was active. */
  const finishDrag = (tail = false): boolean => {
    if (!isVectorDrawingRef.current) return false;
    isVectorDrawingRef.current = false;
    tabletStrokeRef.current?.finish();
    tabletStrokeRef.current = null;
    const layer = ctx.activeLayer;
    const engine = vectorEngineRef.current;
    const item = layer ? layerManagerRef.current?.getLayerItem(layer.id) : null;
    const tool = ctx.currentTool;
    if (layer && item && engine && tileEngineRef.current && !tail && !erasesVectors(tool, layer)
      && tool !== 'vector_reshape' && tool !== 'vector_width' && currentVectorPointsRef.current.length >= 2) {
      const allDirtyTiles: TileData[] = [];
      const allBeforeTilesMap = new Map<string, TileData>();
      const createdStrokes: VectorStroke[] = [];
      for (const traj of symmetryTrajectories(currentVectorPointsRef.current)) {
        const res = engine.commitVectorStroke(engine.targetForLayer(layerManagerRef.current!, layer.id), layer.id, traj, { color: brushProps.color, baseWidth: brushProps.size, opacity: brushProps.opacity });
        if (res && res.dirtyTiles.length > 0) {
          createdStrokes.push(res.stroke);
          for (const bt of res.beforeTiles) {
            const key = `${bt.col}_${bt.row}`;
            if (!allBeforeTilesMap.has(key)) allBeforeTilesMap.set(key, bt);
          }
          allDirtyTiles.push(...res.dirtyTiles);
        }
      }
      if (allDirtyTiles.length > 0) {
        if (ctx.user) {
          scopedUndoRef.current.push({
            opId: `op_vec_${Date.now()}`,
            userId: ctx.user.id,
            layerId: layer.id,
            opType: 'STROKE',
            beforeTiles: Array.from(allBeforeTilesMap.values()),
            afterTiles: allDirtyTiles,
            vectorRemovedStrokes: [],
            vectorAddedStrokes: createdStrokes,
            timestamp: Date.now(),
            desc: '向量線稿筆觸 (Vector Stroke)',
          });
          updateUndoRedoState();
        }
        // One commit: the op already carries the tiles. vectorAdded lists the mirrored copies
        // too, which a single vectorStroke lost on reload.
        commitOp(layer.id, 'STROKE', { tool: 'vector_pen', vectorStroke: createdStrokes[0], vectorAdded: createdStrokes, tiles: allDirtyTiles });
        recordUsedColor(createdStrokes[0].color);
        setVectorStrokesList(engine.getStrokes(layer.id));
      }
    }
    // Eraser / reshape / width drags become one undo step
    if (vectorGestureRef.current) finishVectorGesture();
    RulerManager.getInstance().onStrokeEnd();
    ctx.shapeGraphicRef.current?.clear();
    currentVectorPointsRef.current = [];
    lastVectorPointerPosRef.current = null;
    ctx.requestRender();
    return true;
  };

  /** Drops a drag without committing (multi-touch gesture) */
  const cancelDrag = () => {
    tabletStrokeRef.current?.finish();
    tabletStrokeRef.current = null;
    currentVectorPointsRef.current = [];
    lastVectorPointerPosRef.current = null;
    isVectorDrawingRef.current = false;
  };

  /** Another canvas (or the engine rebuilt): no strokes, no cursor, no drag */
  const resetForCanvas = () => {
    setVectorStrokesList([]);
    setVectorSel(null);
    setSelectedStrokeIds([]);
    cancelDrag();
  };

  const selectedAnchorExists = Boolean(ctx.currentTool === 'vector_edit' && vectorSel && vectorSel.index >= 0);
  // Pen path preview: the placed points plus the rubber band to the pointer
  const penPreview = ctx.currentTool === 'vector_bezier' && ctx.activeLayer && penPoints.length > 0
    ? buildPenStroke(ctx.activeLayer.id, penHover ? [...penPoints, { x: penHover.x, y: penHover.y }] : penPoints, bezierMode,
        { color: brushProps.color, width: brushProps.size, opacity: brushProps.opacity }, false)
    : null;

  return {
    vectorEraserMode, setVectorEraserMode,
    vectorWidthMode, setVectorWidthMode,
    vectorStrokesList, setVectorStrokesList,
    bezierMode, setBezierMode,
    penPoints,
    vectorSel,
    selectedStrokeIds,
    selectedStrokeIdsRef,
    setSelectedStrokeIds,
    vectorPreview,
    penPreview,
    selectedAnchorExists,
    applyVectorPayload,
    finishPenPath,
    cancelPenPath,
    penPointerDown,
    penPointerMove,
    endPenDrag: () => { penDragRef.current = null; },
    vectorEditPointerDown,
    vectorEditPointerMove,
    vectorEditPointerUp,
    toggleSelectedAnchorCorner,
    deleteSelectedAnchor,
    handleVectorKey,
    onToolChange,
    isVectorDragTool,
    startDrag,
    moveDrag,
    finishDrag,
    cancelDrag,
    resetForCanvas,
  };
}

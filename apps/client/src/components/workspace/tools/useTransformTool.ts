import { useRef, useState } from 'react';
import { RenderTexture, Sprite, Texture } from 'pixi.js';
import type { LayerModel, SelectionSnapshot, VectorStroke } from '@atelier/shared';
import { findContentBounds } from '../../../utils/pixelBounds';
import { DISTORT_MODES, type DistortMode } from '../../../utils/distortModes';
import type { TransformBox } from '../../TransformOverlay';
import type { Point, ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';
import {
  collectGroupTransformLayers, groupTransformPreview, liftTransformPixels,
  pushGroupTransformUndo, readTransformContentBounds, transformGroupVectorStroke, transformRect, unionTransformBounds,
  type GroupTransformEdit,
} from './groupTransform';

type WarpBounds = { minX: number; minY: number; width: number; height: number };
type WarpSource = (source: HTMLCanvasElement) => HTMLCanvasElement;
let nextGroupOp = 0;

function transformBoxBounds(box: TransformBox) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cos = Math.abs(Math.cos(box.rotation));
  const sin = Math.abs(Math.sin(box.rotation));
  const hw = (Math.abs(box.width) * cos + Math.abs(box.height) * sin) / 2 + 2;
  const hh = (Math.abs(box.width) * sin + Math.abs(box.height) * cos) / 2 + 2;
  return { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
}

/** Free transform (Ctrl+T) and the mesh / perspective distort modes: lift, preview, apply or cancel. */
export function useTransformTool(
  ctx: ToolContext,
  refreshSelection: () => void,
  applyVectorPayload: (layerId: string, payload: { vectorRemovedIds: string[]; vectorAdded: VectorStroke[] }) => void,
) {
  const { canvas, user, pixiAppRef, layerManagerRef, tileEngineRef, selectionEngineRef, activeLayerRef, layersRef, scopedUndoRef, updateUndoRedoState, commitOp, commitTilePatch, canEditPixels, warn } = ctx;


  // Free Transform state
  const [isTransformActive, setIsTransformActive] = useState<boolean>(false);
  const [transformPreviewUrl, setTransformPreviewUrl] = useState<string | null>(null);
  const [transformBox, setTransformBox] = useState<TransformBox>({
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
  });
  const transformLayerIdRef = useRef<string | null>(null);
  const transformTargetIdsRef = useRef<readonly string[]>([]);
  const groupSourcesRef = useRef<ReadonlyMap<string, HTMLCanvasElement> | null>(null);
  const pendingTransformRef = useRef<{ layerId: string } | null>(null);
  const applyingGroupRef = useRef(false);
  const groupDragRef = useRef<{ layerId: string; pointerId: number | null; start: Point; point: Point; box: TransformBox | null } | null>(null);
  const transformSourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformInitialBoxRef = useRef<TransformBox>({ x: 0, y: 0, width: 200, height: 200, rotation: 0 });
  const isPasteRef = useRef(false);
  // The selection lifted with the pixels (alpha = coverage): transformed with them on apply, so the
  // selection follows the moved content instead of being dropped
  const transformMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformSelectionBeforeRef = useRef<SelectionSnapshot | null>(null);

  // Mesh Warp State
  const [distortMode, updateDistortMode] = useState<DistortMode | 'transform'>('transform');
  const setDistortMode = (mode: DistortMode | 'transform') => {
    if (applyingGroupRef.current) return;
    if (mode === 'puppet' && (groupSourcesRef.current?.size ?? 0) > 1) {
      warn('操控變形一次只能處理一個圖層。請選取組內的一個圖層，或使用網格變形。', 3500);
      return;
    }
    updateDistortMode(mode);
  };
  const isPuppetWarpActive = isTransformActive && distortMode === 'puppet';
  const isMeshWarpActive = isTransformActive && distortMode !== 'transform' && distortMode !== 'puppet';
  const meshWarpInitialBoundsRef = useRef<{ minX: number; minY: number; width: number; height: number }>({
    minX: 0,
    minY: 0,
    width: 200,
    height: 200,
  });

  /** Tiles covered by two transform boxes (their rotated corners' bounding boxes), clamped to the canvas */
  const boxTiles = (a: TransformBox | null, b: TransformBox | null) => {
    const te = tileEngineRef.current!;
    const seen = new Map<string, { col: number; row: number }>();
    for (const box of [a, b]) {
      if (!box) continue;
      const { minX, minY, maxX, maxY } = transformBoxBounds(box);
      for (const c of te.getDirtyTilesForBounds(minX, minY, maxX, maxY)) seen.set(`${c.col}_${c.row}`, c);
    }
    return [...seen.values()];
  };

  // Free Transform Mode
  /**
   * Lifts the selection (or the whole layer) off the active layer for a floating transform, as
   * Krita / CSP do: returns the lifted pixels as a canvas and erases them from the layer, so the
   * preview is not drawn over its own original. The ping-pong buffer still holds the untouched
   * layer, which is how cancel restores it and how apply gets its undo "before" tiles.
   */
  const liftSelectionForTransform = async (activeLayer: LayerModel, isCurrent: () => boolean) => {
    // Ref, not the prop: the Ctrl+T shortcut calls this from a closure created at engine init
    if (!activeLayer || !layerManagerRef.current || !tileEngineRef.current || !canvas) return null;
    const item = layerManagerRef.current.getLayerItem(activeLayer.id);
    if (!item) return null;
    const te = tileEngineRef.current;

    let b = { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height };
    const sel = selectionEngineRef.current?.hasSelection() ? selectionEngineRef.current.getSelection() : null;
    if (sel) {
      b = sel.bounds;
    } else {
      // No selection: transform what is painted on the layer (its non-transparent bounds),
      // not the whole canvas, so the handles sit on the artwork as in CSP / Krita
      // Read without stalling, and only the tiles a sparse layer has (not the whole canvas)
      const lm = layerManagerRef.current;
      const occupied = lm.occupiedTiles(activeLayer.id);
      if (occupied && occupied.length === 0) return null;
      const ts = te.tileSize;
      let box = { x: 0, y: 0, w: canvas.width, h: canvas.height };
      if (occupied) {
        const x0 = Math.min(...occupied.map((c) => c.col)) * ts;
        const y0 = Math.min(...occupied.map((c) => c.row)) * ts;
        box = {
          x: x0,
          y: y0,
          w: Math.min(canvas.width, (Math.max(...occupied.map((c) => c.col)) + 1) * ts) - x0,
          h: Math.min(canvas.height, (Math.max(...occupied.map((c) => c.row)) + 1) * ts) - y0,
        };
      }
      if (!lm.allowFullCanvasTextures && box.w * box.h > (lm.deviceProfile.isConstrained ? 4_194_304 : 16_777_216)) return null;
      const [boxPixels] = await lm.readAsync(activeLayer.id, [box]);
      const content = findContentBounds(boxPixels, box.w, box.h);
      if (!content) return null;
      b = { minX: box.x + content.minX, minY: box.y + content.minY, maxX: box.x + content.maxX + 1, maxY: box.y + content.maxY + 1 };
    }

    // Integer, in-canvas rect: the GPU read/write below are exact-pixel operations
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(b.minX)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(b.minY)));
    const w = Math.min(canvas.width - x, Math.max(1, Math.ceil(b.maxX) - x + (sel ? 1 : 0)));
    const h = Math.min(canvas.height - y, Math.max(1, Math.ceil(b.maxY) - y + (sel ? 1 : 0)));

    const lm = layerManagerRef.current;
    if (!lm.allowFullCanvasTextures && w * h > (lm.deviceProfile.isConstrained ? 4_194_304 : 16_777_216)) return null;
    const [layerPixels] = await lm.readAsync(activeLayer.id, [{ x, y, w, h }]);
    if (!isCurrent() || layerManagerRef.current?.getLayerItem(activeLayer.id) !== item) return null;
    // Straight-alpha copy for the floating preview
    const source = document.createElement('canvas');
    source.width = w;
    source.height = h;
    {
      const sctx = source.getContext('2d')!;
      const simg = sctx.createImageData(w, h);
      for (let i = 0; i < layerPixels.length; i += 4) {
        const a = layerPixels[i + 3];
        if (!a) continue;
        const k = 255 / a;
        simg.data[i] = layerPixels[i] * k;
        simg.data[i + 1] = layerPixels[i + 1] * k;
        simg.data[i + 2] = layerPixels[i + 2] * k;
        simg.data[i + 3] = a;
      }
      sctx.putImageData(simg, 0, 0);
    }
    const mask = sel ? selectionEngineRef.current!.getMaskData()?.data : null;

    transformMaskCanvasRef.current = null;
    if (mask) {
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = w;
      maskCanvas.height = h;
      const mctx = maskCanvas.getContext('2d')!;
      const mimg = mctx.createImageData(w, h);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * 4;
          mimg.data[i] = mimg.data[i + 1] = mimg.data[i + 2] = 255;
          mimg.data[i + 3] = mask[(y + row) * canvas.width + (x + col)];
        }
      }
      mctx.putImageData(mimg, 0, 0);
      transformMaskCanvasRef.current = maskCanvas;

      // Only selected pixels float; feathered edges split between the float and the layer
      const ctx = source.getContext('2d')!;
      const img = ctx.getImageData(0, 0, w, h);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const m = mask[(y + row) * canvas.width + (x + col)] / 255;
          const i = (row * w + col) * 4;
          img.data[i + 3] = img.data[i + 3] * m;
          for (let c = 0; c < 4; c++) layerPixels[i + c] = layerPixels[i + c] * (1 - m);
        }
      }
      ctx.putImageData(img, 0, 0);
    } else {
      layerPixels.fill(0);
    }
    lm.writeRegion(activeLayer.id, x, y, w, h, layerPixels);

    return { source, x, y, w, h };
  };

  const groupTargets = (groupId: string) => collectGroupTransformLayers(layersRef.current, groupId, canEditPixels);

  const groupTargetsAreCurrent = (groupId: string, ids: readonly string[]) => {
    const targets = groupTargets(groupId);
    const targetIds = new Set(targets.map(({ id }) => id));
    return ids.length === targetIds.size && ids.every((id) => targetIds.has(id));
  };

  const liftGroupForTransform = async (
    groupId: string, ids: readonly string[], isCurrent: () => boolean,
    install: (source: HTMLCanvasElement, x: number, y: number) => void,
  ) => {
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    const selection = selectionEngineRef.current;
    if (!canvas || !lm || !te) return false;
    const { width, height } = canvas;
    const maxPixels = lm.deviceProfile.isConstrained ? 4_194_304 : 16_777_216;
    const fits = (w: number, h: number) => lm.allowFullCanvasTextures || w * h <= maxPixels;
    const sel = selection?.getSelection();
    const snapshots = ids.map((id) => ({ id, item: lm.getLayerItem(id), version: lm.getLayerVersion(id) }));
    const current = () => isCurrent() && selection?.getSelection() === sel &&
      snapshots.every(({ id, item, version }) => item && lm.getLayerItem(id) === item && lm.getLayerVersion(id) === version);
    if (!current()) return false;

    const content = [];
    if (!sel) {
      for (const id of ids) {
        content.push(await readTransformContentBounds(lm, id, width, height, te.tileSize, fits));
        if (!current()) return false;
      }
    }
    const bounds = sel?.bounds ?? unionTransformBounds(content);
    if (!bounds) return false;
    const rect = transformRect(bounds, width, height, Boolean(sel));
    const { x, y, w, h } = rect;
    const selectionMask = sel ? selection?.getMaskData()?.data : null;
    const liftedBytes = w * h * 4 * (ids.length * (selectionMask ? 2 : 1) + 2);
    if (!fits(w, h) || liftedBytes > (lm.deviceProfile.isConstrained ? 96 : 384) * 1048576) {
      throw new RangeError('Folder transform exceeds the pixel budget');
    }

    let maskCanvas: HTMLCanvasElement | null = null;
    let coverage: Uint8ClampedArray | undefined;
    if (selectionMask) {
      maskCanvas = document.createElement('canvas');
      maskCanvas.width = w;
      maskCanvas.height = h;
      const paint = maskCanvas.getContext('2d')!;
      const image = paint.createImageData(w, h);
      coverage = image.data;
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const index = (row * w + col) * 4;
          coverage[index] = coverage[index + 1] = coverage[index + 2] = 255;
          coverage[index + 3] = selectionMask[(y + row) * width + x + col];
        }
      }
      paint.putImageData(image, 0, 0);
    }

    // Stage the complete lift before changing any layer or reserving resident textures.
    const sources = new Map<string, HTMLCanvasElement>();
    const remainders = new Map<string, Uint8Array>();
    for (const id of ids) {
      const [pixels] = await lm.readAsync(id, [rect]);
      if (!current()) return false;
      sources.set(id, liftTransformPixels(pixels, w, h, coverage));
      if (coverage) remainders.set(id, pixels);
    }
    if (!groupTargetsAreCurrent(groupId, ids)) return false;
    const preview = groupTransformPreview(layersRef.current, sources, w, h);
    const written: string[] = [];
    try {
      lm.pin('transform', ids);
      for (const id of ids) lm.syncPingPong(id);
      for (const id of ids) {
        written.push(id);
        const remaining = remainders.get(id);
        if (remaining) lm.writeRegion(id, x, y, w, h, remaining);
        else lm.clearLayerRegion(id, x, y, w, h);
      }
      transformMaskCanvasRef.current = maskCanvas;
      groupSourcesRef.current = sources;
      install(preview, x, y);
    } catch (error) {
      for (const id of written) {
        lm.revertToPingPong(id);
        lm.syncPingPong(id);
      }
      lm.pin('transform', null);
      throw error;
    }
    return true;
  };

  const shiftedBox = (box: TransformBox, start: Point, point: Point): TransformBox =>
    start.x === point.x && start.y === point.y
      ? box : { ...box, x: box.x + point.x - start.x, y: box.y + point.y - start.y };

  const startTransformMode = async (mode: DistortMode | 'transform' = 'transform', layer = activeLayerRef.current) => {
    if (ctx.rejectAdjustmentPixels(layer)) return;
    if (transformLayerIdRef.current) {
      if (mode === 'puppet') setDistortMode(mode);
      return;
    }
    if (pendingTransformRef.current) return;
    const isGroup = layer?.layerType === 'group';
    if (!layer || (!isGroup && !canEditPixels(layer))) {
      warn('請先選取可編輯、未鎖定的圖層，再開始變形。', 3000);
      return;
    }
    const ids = isGroup ? groupTargets(layer.id).map(({ id }) => id) : [layer.id];
    if (!ids.length) {
      warn('這個資料夾沒有可變形的圖層。請確認資料夾及子圖層已解鎖，且你有編輯權限。', 3500);
      return;
    }
    if (mode === 'puppet' && ids.length > 1) {
      warn('操控變形一次只能處理一個圖層。請選取組內的一個圖層，或使用網格變形。', 3500);
      return;
    }
    const request = { layerId: layer.id };
    pendingTransformRef.current = request;
    const manager = layerManagerRef.current;
    const isCurrent = () => pendingTransformRef.current === request && manager === layerManagerRef.current &&
      activeLayerRef.current?.id === layer.id;
    const selBefore = selectionEngineRef.current?.exportSnapshot() ?? null;
    const install = (source: HTMLCanvasElement, x: number, y: number) => {
      const url = source.toDataURL();
      const { width, height } = source;
      const initialBox: TransformBox = { x, y, width, height, rotation: 0 };
      const drag = groupDragRef.current;
      if (drag?.layerId === layer.id) {
        drag.box = initialBox;
        setTransformBox(shiftedBox(initialBox, drag.start, drag.point));
        if (drag.pointerId === null) groupDragRef.current = null;
      } else setTransformBox(initialBox);
      transformLayerIdRef.current = layer.id;
      transformTargetIdsRef.current = ids;
      transformSelectionBeforeRef.current = selBefore;
      transformInitialBoxRef.current = initialBox;
      transformSourceCanvasRef.current = source;
      meshWarpInitialBoundsRef.current = { minX: x, minY: y, width, height };
      setTransformPreviewUrl(url);
      setDistortMode(mode);
      setIsTransformActive(true);
      ctx.requestRender();
    };
    try {
      if (isGroup) {
        if (!await liftGroupForTransform(layer.id, ids, isCurrent, install) && isCurrent()) {
          warn('這個資料夾在目前的範圍內沒有可變形的內容，或圖層剛有變動。', 3500);
        }
      } else {
        const lifted = await liftSelectionForTransform(layer, isCurrent);
        if (!isCurrent()) return;
        if (!lifted) {
          warn('這個圖層上還沒有可變形的內容。', 3000);
          return;
        }
        manager?.pin('transform', layer.id);
        install(lifted.source, lifted.x, lifted.y);
      }
    } catch (error) {
      if (!isCurrent()) return;
      groupSourcesRef.current = null;
      transformMaskCanvasRef.current = null;
      if (!isGroup) manager?.revertToPingPong(layer.id);
      manager?.pin('transform', null);
      ctx.requestRender();
      warn(isGroup && error instanceof RangeError
        ? '資料夾的變形範圍太大，請縮小選區後再試。'
        : '無法開始變形，請再試一次。', 3500);
    } finally {
      if (pendingTransformRef.current === request) {
        pendingTransformRef.current = null;
        if (!transformLayerIdRef.current) groupDragRef.current = null;
      }
    }
  };

  const startGroupDrag = (layer: LayerModel, pointerId: number, point: Point) => {
    if (layer.layerType !== 'group') return;
    groupDragRef.current = { layerId: layer.id, pointerId, start: point, point, box: null };
    void startTransformMode('transform', layer).finally(() => {
      if (!pendingTransformRef.current && !transformLayerIdRef.current) groupDragRef.current = null;
    });
  };

  const moveGroupDrag = (pointerId: number, point: Point) => {
    const drag = groupDragRef.current;
    if (drag?.pointerId !== pointerId) return false;
    drag.point = point;
    if (drag.box) setTransformBox(shiftedBox(drag.box, drag.start, point));
    return true;
  };

  const endGroupDrag = (pointerId: number) => {
    const drag = groupDragRef.current;
    if (drag?.pointerId !== pointerId) return;
    if (drag.box) groupDragRef.current = null;
    else drag.pointerId = null;
  };

  const cancelPendingTransform = () => {
    if (!pendingTransformRef.current) return false;
    pendingTransformRef.current = null;
    groupDragRef.current = null;
    return true;
  };

  /**
   * Paste (CSP-like): the copied pixels float over the active layer at the place they were copied
   * from, in the transform box — move / scale / rotate, Enter pastes, Esc drops them. Nothing is
   * lifted, so cancelling leaves the layer as it was.
   */
  const startFloatingPaste = (source: HTMLCanvasElement, x: number, y: number, layer = activeLayerRef.current) => {
    if (ctx.rejectAdjustmentPixels(layer)) return;
    if (transformLayerIdRef.current) return;
    if (!layer || !canEditPixels(layer)) {
      warn('請先選取自己可編輯、未鎖定的圖層，再貼上。', 3000);
      return;
    }
    cancelPendingTransform();
    transformLayerIdRef.current = layer.id;
    transformTargetIdsRef.current = [layer.id];
    transformSelectionBeforeRef.current = selectionEngineRef.current?.exportSnapshot() ?? null;
    ctx.layerManagerRef.current?.pin('transform', layer.id);
    isPasteRef.current = true;
    transformMaskCanvasRef.current = source; // the pasted pixels become the selection
    const initialBox: TransformBox = { x, y, width: source.width, height: source.height, rotation: 0 };
    setTransformBox(initialBox);
    transformInitialBoxRef.current = initialBox;
    transformSourceCanvasRef.current = source;
    meshWarpInitialBoundsRef.current = { minX: x, minY: y, width: source.width, height: source.height };
    setTransformPreviewUrl(source.toDataURL());
    setDistortMode('transform');
    setIsTransformActive(true);
  };

  const clearTransform = () => {
    isPasteRef.current = false;
    transformMaskCanvasRef.current = null;
    transformSelectionBeforeRef.current = null;
    transformLayerIdRef.current = null;
    transformTargetIdsRef.current = [];
    groupSourcesRef.current = null;
    pendingTransformRef.current = null;
    groupDragRef.current = null;
    applyingGroupRef.current = false;
    ctx.layerManagerRef.current?.pin('transform', null);
    transformSourceCanvasRef.current = null;
    setIsTransformActive(false);
    setTransformPreviewUrl(null);
  };

  const finishTransform = () => {
    clearTransform();
    ctx.selectTool('brush');
  };

  const applyGroup = (
    coords: ReturnType<typeof boxTiles>,
    paint: (id: string, source: HTMLCanvasElement) => void,
    label: string,
    moveSelection?: () => boolean,
    mapStroke?: (stroke: VectorStroke) => VectorStroke,
  ) => {
    const lm = layerManagerRef.current;
    const id = transformLayerIdRef.current;
    const sources = groupSourcesRef.current;
    if (applyingGroupRef.current || !lm || !id || !sources) return;
    if (!groupTargetsAreCurrent(id, transformTargetIdsRef.current) ||
        transformTargetIdsRef.current.some((targetId) => !lm.getLayerItem(targetId))) {
      cancelTransform();
      return;
    }

    applyingGroupRef.current = true;
    const undo = scopedUndoRef.current;
    const effectiveUserId = ctx.userRef.current?.id || user?.id || 'guest';
    const selectionBefore = transformSelectionBeforeRef.current;
    const diffs = Array.from(sources, async ([layerId, source]): Promise<GroupTransformEdit> => {
      const diff = await diffTilesAsync(lm, layerId, coords, () => paint(layerId, source), 'before');
      const vectorRemovedStrokes = mapStroke && !selectionBefore && lm.getLayerItem(layerId)?.model.layerType === 'vector'
        ? ctx.vectorEngineRef.current?.getStrokes(layerId) : undefined;
      return vectorRemovedStrokes?.length && mapStroke
        ? { layerId, ...diff, vectorRemovedStrokes, vectorAddedStrokes: vectorRemovedStrokes.map(mapStroke) }
        : { layerId, ...diff };
    });
    ctx.requestRender();
    // Keep the original baselines until every child diff succeeds. A remote edit can still cancel.
    commitInOrder(Promise.all(diffs).catch(() => null), (edits) => {
      if (groupSourcesRef.current !== sources || layerManagerRef.current !== lm) return;
      if (!edits || !groupTargetsAreCurrent(id, transformTargetIdsRef.current)) {
        cancelTransform();
        warn('資料夾變形未能完成，已還原各圖層。', 3500);
        return;
      }
      for (const { layerId } of edits) lm.syncPingPong(layerId);
      if (!moveSelection?.()) selectionEngineRef.current?.clearSelection();
      const selectionAfter = selectionEngineRef.current?.exportSnapshot() ?? null;
      const groupOpId = `op_group_transform_${Date.now()}_${nextGroupOp++}`;
      pushGroupTransformUndo(undo, groupOpId, edits, effectiveUserId, label, selectionBefore, selectionAfter);
      updateUndoRedoState();
      for (const { layerId, afterTiles, vectorRemovedStrokes, vectorAddedStrokes } of edits) {
        const vectorDelta = vectorRemovedStrokes && vectorAddedStrokes && {
          vectorRemovedIds: vectorRemovedStrokes.map(({ id }) => id), vectorAdded: vectorAddedStrokes,
        };
        if (vectorDelta) applyVectorPayload(layerId, vectorDelta);
        commitOp(layerId, 'STROKE', { tool: 'transform', tiles: afterTiles, ...vectorDelta }, true);
      }
      finishTransform();
      refreshSelection();
    });
  };

  /** Returns true when the selection was moved with the content (else the caller drops it) */
  const applyTransform = (): boolean => {
    const layerId = transformLayerIdRef.current;
    if (!layerId || !layerManagerRef.current || !pixiAppRef.current || !tileEngineRef.current || !transformSourceCanvasRef.current) {
      cancelTransform();
      return false;
    }

    const isGroup = groupSourcesRef.current !== null;
    const item = layerManagerRef.current.getLayerItem(layerId);
    if (!isGroup && (!item || !canEditPixels(item.model))) {
      cancelTransform();
      return false;
    }

    const initBox = transformInitialBoxRef.current;
    const curBox = transformBox;
    if (applyingGroupRef.current) return false;
    // An untouched lift is a no-op; an untouched paste still pastes (in place)
    if (curBox === initBox && !isPasteRef.current) {
      cancelTransform();
      return Boolean(selectionEngineRef.current?.hasSelection());
    }

    if (isGroup) {
      applyGroup(boxTiles(initBox, curBox), (id, source) => drawTransform(id, source, curBox, initBox),
        '資料夾變形', () => moveSelectionWith(curBox, initBox), (stroke) => transformGroupVectorStroke(stroke, initBox, curBox));
      return false;
    }

    const selBefore = transformSelectionBeforeRef.current;
    const moved = moveSelectionWith(curBox, initBox);
    if (!moved) selectionEngineRef.current?.clearSelection();
    const selAfter = selectionEngineRef.current?.exportSnapshot() ?? null;

    // Only the tiles the box was lifted from or lands on change; the untouched layer is in ping-pong
    const lm = layerManagerRef.current;
    const source = transformSourceCanvasRef.current;
    const coords = boxTiles(initBox, curBox);
    const diff = diffTilesAsync(lm, layerId, coords, () => {
      drawTransform(layerId, source, curBox, initBox);
      ctx.requestRender();
    }, 'before');
    lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline

    const effectiveUserId = ctx.userRef.current?.id || user?.id || 'guest';
    commitInOrder(diff, ({ beforeTiles, afterTiles }) => {
      const opId = `op_transform_${Date.now()}`;
      scopedUndoRef.current.push({
        opId,
        userId: effectiveUserId,
        layerId,
        opType: 'STROKE',
        beforeTiles,
        afterTiles,
        selectionBefore: selBefore,
        selectionAfter: selAfter,
        timestamp: Date.now(),
        desc: '自由變形',
      });
      updateUndoRedoState();

      commitOp(layerId, 'STROKE', { tool: 'transform', tiles: afterTiles }, true);
    });

    finishTransform();
    return moved;
  };

  const drawTransform = (layerId: string, source: HTMLCanvasElement, curBox: TransformBox, initBox: TransformBox) => {
    const lm = layerManagerRef.current!;
    const cx = curBox.x + curBox.width / 2;
    const cy = curBox.y + curBox.height / 2;
    const scaleX = curBox.width / initBox.width;
    const scaleY = curBox.height / initBox.height;
    if (lm.allowFullCanvasTextures && source.width <= lm.maxTextureSize && source.height <= lm.maxTextureSize) {
      const tex = Texture.from(source);
      const spr = Sprite.from(tex);
      try {
        spr.anchor.set(0.5);
        spr.position.set(cx, cy);
        spr.rotation = curBox.rotation;
        spr.scale.set(scaleX, scaleY);
        const target = lm.drawTarget(layerId, { whole: !groupSourcesRef.current });
        if (target instanceof RenderTexture) pixiAppRef.current!.renderer.render({ container: spr, target, clear: false });
        else if (target) {
          const { minX, minY, maxX, maxY } = transformBoxBounds(curBox);
          target.draw(spr, minX, minY, maxX - minX, maxY - minY);
        }
      } finally {
        spr.destroy();
        tex.destroy(true);
      }
    } else {
      const side = tileEngineRef.current!.tileSize;
      const chunk = document.createElement('canvas');
      chunk.width = chunk.height = side;
      const paint = chunk.getContext('2d')!;
      for (const { col, row } of boxTiles(null, curBox)) {
        const x = col * side;
        const y = row * side;
        paint.resetTransform();
        paint.clearRect(0, 0, side, side);
        paint.translate(cx - x, cy - y);
        paint.rotate(curBox.rotation);
        paint.scale(scaleX, scaleY);
        paint.drawImage(source, -source.width / 2, -source.height / 2);
        lm.stampCanvasOnLayer(layerId, chunk, x, y);
      }
      chunk.width = chunk.height = 0;
    }
  };

  /** Renders the lifted selection through the same transform and makes it the selection */
  const moveSelectionWith = (curBox: TransformBox, initBox: TransformBox) => {
    const maskCanvas = transformMaskCanvasRef.current;
    const selection = selectionEngineRef.current;
    if (!maskCanvas || !canvas || !selection) return false;
    const cx = curBox.x + curBox.width / 2;
    const cy = curBox.y + curBox.height / 2;
    const cos = Math.abs(Math.cos(curBox.rotation));
    const sin = Math.abs(Math.sin(curBox.rotation));
    const hw = (Math.abs(curBox.width) * cos + Math.abs(curBox.height) * sin) / 2;
    const hh = (Math.abs(curBox.width) * sin + Math.abs(curBox.height) * cos) / 2;
    const x = Math.max(0, Math.floor(cx - hw));
    const y = Math.max(0, Math.floor(cy - hh));
    const w = Math.min(canvas.width, Math.ceil(cx + hw)) - x;
    const h = Math.min(canvas.height, Math.ceil(cy + hh)) - y;
    if (w <= 0 || h <= 0) return false;
    const patch = document.createElement('canvas');
    patch.width = w;
    patch.height = h;
    const c2d = patch.getContext('2d', { willReadFrequently: true });
    if (!c2d) return false;
    c2d.translate(cx - x, cy - y);
    c2d.rotate(curBox.rotation);
    c2d.scale(curBox.width / initBox.width, curBox.height / initBox.height);
    c2d.drawImage(maskCanvas, -maskCanvas.width / 2, -maskCanvas.height / 2);
    const px = c2d.getImageData(0, 0, w, h).data;
    const coverage = new Uint8Array(canvas.width * canvas.height);
    for (let row = 0; row < h; row++) {
      const offset = (y + row) * canvas.width + x;
      for (let col = 0; col < w; col++) coverage[offset + col] = px[(row * w + col) * 4 + 3];
    }
    selection.applyMask(coverage, 'replace');
    return selection.hasSelection();
  };

  const cancelTransform = () => {
    // Put the lifted pixels back: ping-pong still holds the layer as it was before the lift
    const lm = layerManagerRef.current;
    for (const id of transformTargetIdsRef.current) {
      lm?.revertToPingPong(id);
      if (groupSourcesRef.current) lm?.syncPingPong(id);
    }
    finishTransform();
    ctx.requestRender();
  };

  const cancelStaleTransform = () => {
    const activeId = activeLayerRef.current?.id;
    const layerId = transformLayerIdRef.current ?? pendingTransformRef.current?.layerId;
    if (layerId && (layerId !== activeId ||
        (groupSourcesRef.current && !groupTargetsAreCurrent(layerId, transformTargetIdsRef.current)))) cancelTransform();
  };

  const applyMeshWarp = (
    warpedCanvas: HTMLCanvasElement,
    bounds: WarpBounds,
    labelOverride?: string,
    warpSource?: WarpSource,
  ) => {
    const layerId = transformLayerIdRef.current;
    if (!layerId || !layerManagerRef.current || !pixiAppRef.current || !tileEngineRef.current) {
      cancelTransform();
      return;
    }
    const item = layerManagerRef.current.getLayerItem(layerId);
    const groupSources = groupSourcesRef.current;
    if (!groupSources && (!item || !canEditPixels(item.model))) {
      cancelTransform();
      return;
    }

    // Only the tiles the source was lifted from or the warp lands on change
    const lm = layerManagerRef.current;
    const lifted = meshWarpInitialBoundsRef.current;
    const coords = boxTiles(
      lifted ? { x: lifted.minX, y: lifted.minY, width: lifted.width, height: lifted.height, rotation: 0 } : null,
      { x: bounds.minX, y: bounds.minY, width: warpedCanvas.width, height: warpedCanvas.height, rotation: 0 },
    );
    if (groupSources) {
      if (!warpSource && groupSources.size > 1) return;
      const maxPixels = lm.deviceProfile.isConstrained ? 4_194_304 : 16_777_216;
      if (!lm.allowFullCanvasTextures && warpedCanvas.width * warpedCanvas.height > maxPixels) {
        warn('變形後的資料夾範圍太大，請縮小變形範圍後再試。', 3500);
        return;
      }
      applyGroup(coords, (id, source) => {
        const warped = warpSource ? warpSource(source) : warpedCanvas;
        lm.stampCanvasOnLayer(id, warped, Math.round(bounds.minX), Math.round(bounds.minY));
        if (warpSource) warped.width = warped.height = 0;
      }, labelOverride ?? '資料夾變形');
      return;
    }
    const diff = diffTilesAsync(lm, layerId, coords, () => {
      lm.stampCanvasOnLayer(layerId, warpedCanvas, Math.round(bounds.minX), Math.round(bounds.minY));
      ctx.requestRender();
    }, 'before');
    lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline

    const selBefore = transformSelectionBeforeRef.current;
    selectionEngineRef.current?.clearSelection();
    const label = labelOverride ?? DISTORT_MODES.find((mode) => mode.id === distortMode)?.label ?? '網格變形';
    const effectiveUserId = ctx.userRef.current?.id || user?.id || 'guest';
    commitInOrder(diff, ({ beforeTiles, afterTiles }) => {
      const opId = `op_mesh_warp_${Date.now()}`;
      scopedUndoRef.current.push({
        opId,
        userId: effectiveUserId,
        layerId,
        opType: 'STROKE',
        beforeTiles,
        afterTiles,
        selectionBefore: selBefore,
        selectionAfter: null,
        timestamp: Date.now(),
        desc: label,
      });
      updateUndoRedoState();

      commitTilePatch(layerId, afterTiles, false, label, true);
    });
    finishTransform();
  };

  /** Canvas switch / engine rebuild: nothing floats any more */
  const reset = () => {
    clearTransform();
    updateDistortMode('transform');
  };

  return {
    isTransformActive,
    transformPreviewUrl,
    transformBox, setTransformBox,
    distortMode, setDistortMode,
    isMeshWarpActive,
    isPuppetWarpActive,
    transformLayerIdRef,
    transformTargetIdsRef,
    transformSourceCanvasRef,
    puppetSourceCanvas: groupSourcesRef.current?.values().next().value ?? transformSourceCanvasRef.current,
    applyingGroupRef,
    meshWarpInitialBoundsRef,
    startTransformMode,
    startGroupDrag, moveGroupDrag, endGroupDrag,
    startFloatingPaste,
    applyTransform,
    cancelTransform,
    cancelPendingTransform,
    cancelStaleTransform,
    applyMeshWarp,
    reset,
  };
}

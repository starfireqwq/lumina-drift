import { useRef, useState } from 'react';
import { Sprite, Texture } from 'pixi.js';
import type { LayerModel, SelectionSnapshot } from '@atelier/shared';
import { findContentBounds } from '../../../utils/pixelBounds';
import { DISTORT_MODES, type DistortMode } from '../../../utils/distortModes';
import type { TransformBox } from '../../TransformOverlay';
import type { ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

/** Free transform (Ctrl+T) and the mesh / perspective distort modes: lift, preview, apply or cancel. */
export function useTransformTool(ctx: ToolContext) {
  const { canvas, user, pixiAppRef, layerManagerRef, tileEngineRef, selectionEngineRef, activeLayerRef, scopedUndoRef, updateUndoRedoState, commitOp, commitTilePatch, canEditPixels, warn } = ctx;


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
  const transformSourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformInitialBoxRef = useRef<TransformBox>({ x: 0, y: 0, width: 200, height: 200, rotation: 0 });
  const isPasteRef = useRef(false);
  // The selection lifted with the pixels (alpha = coverage): transformed with them on apply, so the
  // selection follows the moved content instead of being dropped
  const transformMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformSelectionBeforeRef = useRef<SelectionSnapshot | null>(null);

  // Mesh Warp State
  const [distortMode, setDistortMode] = useState<DistortMode | 'transform'>('transform');
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
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const cos = Math.abs(Math.cos(box.rotation));
      const sin = Math.abs(Math.sin(box.rotation));
      const hw = (Math.abs(box.width) * cos + Math.abs(box.height) * sin) / 2 + 2;
      const hh = (Math.abs(box.width) * sin + Math.abs(box.height) * cos) / 2 + 2;
      for (const c of te.getDirtyTilesForBounds(cx - hw, cy - hh, cx + hw, cy + hh)) seen.set(`${c.col}_${c.row}`, c);
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
  const liftSelectionForTransform = async (activeLayer: LayerModel) => {
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

    const [layerPixels] = await layerManagerRef.current!.readAsync(activeLayer.id, [{ x, y, w, h }]);
    if (layerManagerRef.current?.getLayerItem(activeLayer.id) !== item) return null;
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
    te.writeRegion(item.renderTexture, x, y, w, h, layerPixels);

    return { source, x, y, w, h };
  };

  const startTransformMode = async (mode: DistortMode | 'transform' = 'transform', layer = activeLayerRef.current) => {
    if (transformLayerIdRef.current) {
      if (mode === 'puppet') setDistortMode(mode);
      return;
    }
    if (!layer || !canEditPixels(layer)) {
      warn('請先選取可編輯、未鎖定的圖層，再開始變形。', 3000);
      return;
    }
    const selBefore = selectionEngineRef.current?.exportSnapshot() ?? null;
    const lifted = await liftSelectionForTransform(layer);
    if (transformLayerIdRef.current) return; // another transform started meanwhile
    if (!lifted) {
      warn('這個圖層上還沒有可變形的內容。', 3000);
      return;
    }

    transformLayerIdRef.current = layer.id;
    transformSelectionBeforeRef.current = selBefore;
    ctx.layerManagerRef.current?.pin('transform', layer.id); // lifted pixels live only in its full texture
    const initialBox: TransformBox = {
      x: lifted.x,
      y: lifted.y,
      width: lifted.w,
      height: lifted.h,
      rotation: 0,
    };
    setTransformBox(initialBox);
    transformInitialBoxRef.current = initialBox;
    transformSourceCanvasRef.current = lifted.source;
    meshWarpInitialBoundsRef.current = { minX: lifted.x, minY: lifted.y, width: lifted.w, height: lifted.h };
    setTransformPreviewUrl(lifted.source.toDataURL());
    setDistortMode(mode);
    setIsTransformActive(true);
  };

  /**
   * Paste (CSP-like): the copied pixels float over the active layer at the place they were copied
   * from, in the transform box — move / scale / rotate, Enter pastes, Esc drops them. Nothing is
   * lifted, so cancelling leaves the layer as it was.
   */
  const startFloatingPaste = (source: HTMLCanvasElement, x: number, y: number, layer = activeLayerRef.current) => {
    if (transformLayerIdRef.current) return;
    if (!layer || !canEditPixels(layer)) {
      warn('請先選取自己可編輯、未鎖定的圖層，再貼上。', 3000);
      return;
    }
    transformLayerIdRef.current = layer.id;
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

  const finishTransform = () => {
    isPasteRef.current = false;
    transformMaskCanvasRef.current = null;
    transformSelectionBeforeRef.current = null;
    transformLayerIdRef.current = null;
    ctx.layerManagerRef.current?.pin('transform', null);
    transformSourceCanvasRef.current = null;
    setIsTransformActive(false);
    setTransformPreviewUrl(null);
    ctx.selectTool('brush');
  };

  /** Returns true when the selection was moved with the content (else the caller drops it) */
  const applyTransform = (): boolean => {
    const layerId = transformLayerIdRef.current;
    if (!layerId || !layerManagerRef.current || !pixiAppRef.current || !tileEngineRef.current || !transformSourceCanvasRef.current) {
      cancelTransform();
      return false;
    }

    const item = layerManagerRef.current.getLayerItem(layerId);
    if (!item || !canEditPixels(item.model)) {
      cancelTransform();
      return false;
    }

    const initBox = transformInitialBoxRef.current;
    const curBox = transformBox;
    // An untouched lift is a no-op; an untouched paste still pastes (in place)
    if (curBox === initBox && !isPasteRef.current) {
      cancelTransform();
      return Boolean(selectionEngineRef.current?.hasSelection());
    }

    const selBefore = transformSelectionBeforeRef.current;
    const moved = moveSelectionWith(curBox, initBox);
    if (!moved) selectionEngineRef.current?.clearSelection();
    const selAfter = selectionEngineRef.current?.exportSnapshot() ?? null;

    // Sprite with transform matrix
    const tex = Texture.from(transformSourceCanvasRef.current);
    const spr = Sprite.from(tex);
    spr.anchor.set(0.5, 0.5);
    spr.x = curBox.x + curBox.width / 2;
    spr.y = curBox.y + curBox.height / 2;
    spr.rotation = curBox.rotation;
    spr.scale.x = curBox.width / initBox.width;
    spr.scale.y = curBox.height / initBox.height;

    // Only the tiles the box was lifted from or lands on change; the untouched layer is in ping-pong
    const lm = layerManagerRef.current;
    const coords = boxTiles(initBox, curBox);
    const renderer = pixiAppRef.current.renderer;
    const diff = diffTilesAsync(lm, layerId, coords, () => {
      renderer.render({ container: spr, target: item.renderTexture, clear: false });
      spr.destroy();
      tex.destroy(true);
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
    if (transformLayerIdRef.current) layerManagerRef.current?.revertToPingPong(transformLayerIdRef.current);
    finishTransform();
  };

  const applyMeshWarp = (
    warpedCanvas: HTMLCanvasElement,
    bounds: { minX: number; minY: number; width: number; height: number },
    labelOverride?: string,
  ) => {
    const layerId = transformLayerIdRef.current;
    if (!layerId || !layerManagerRef.current || !pixiAppRef.current || !tileEngineRef.current) {
      cancelTransform();
      return;
    }
    const item = layerManagerRef.current.getLayerItem(layerId);
    if (!item || !canEditPixels(item.model)) {
      cancelTransform();
      return;
    }

    // Only the tiles the source was lifted from or the warp lands on change
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    const lifted = meshWarpInitialBoundsRef.current;
    const coords = boxTiles(
      lifted ? { x: lifted.minX, y: lifted.minY, width: lifted.width, height: lifted.height, rotation: 0 } : null,
      { x: bounds.minX, y: bounds.minY, width: warpedCanvas.width, height: warpedCanvas.height, rotation: 0 },
    );
    const diff = diffTilesAsync(lm, layerId, coords, () => {
      te.stampCanvas(item.renderTexture, warpedCanvas, Math.round(bounds.minX), Math.round(bounds.minY));
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
    setIsTransformActive(false);
    setTransformPreviewUrl(null);
    transformSourceCanvasRef.current = null;
    transformSelectionBeforeRef.current = null;
    transformLayerIdRef.current = null;
    ctx.layerManagerRef.current?.pin('transform', null);
    setDistortMode('transform');
  };

  return {
    isTransformActive,
    transformPreviewUrl,
    transformBox, setTransformBox,
    distortMode, setDistortMode,
    isMeshWarpActive,
    isPuppetWarpActive,
    transformLayerIdRef,
    transformSourceCanvasRef,
    meshWarpInitialBoundsRef,
    startTransformMode,
    startFloatingPaste,
    applyTransform,
    cancelTransform,
    applyMeshWarp,
    reset,
  };
}

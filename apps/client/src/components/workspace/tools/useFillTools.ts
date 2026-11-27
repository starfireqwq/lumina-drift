import { useEffect, useRef, useState } from 'react';
import { Container, Graphics, RenderTexture, Sprite, Texture } from 'pixi.js';
import {
  compressTileBuffer,
  computePaintUnfilledAreaMask,
  computeSmartEncloseFillMask,
  getPaintUnfilledAreaBounds,
  getTileBounds,
  hexToRgb,
  LayerModel,
  ScopedUndoOp,
  TileData,
  ToolType,
} from '@atelier/shared';
import { applyColorOutline, type OutlineSettings } from '../../../engine/colorOutline';
import { calculateBucketMask } from '../../../engine/commitWorkers';
import { tiledBucketFill } from '../../../engine/tiledBucketFill';
import { wrapPoint } from '../../../engine/wrapAround';
import { RulerManager } from '../../../engine/RulerManager';
import type { AntiAliasLevel } from '../../../engine/BrushRenderer';
import { OfflineSessionStore } from '../../../services/offlineStore';
import { recordUsedColor } from '../../../services/colorHistoryStore';
import type { Point, ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

function lassoCoverage(points: { x: number; y: number }[], width: number, height: number, antialias: AntiAliasLevel) {
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  minX = Math.max(0, Math.floor(minX));
  minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(width, Math.ceil(maxX));
  maxY = Math.min(height, Math.ceil(maxY));
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 1 || h < 1) return null;
  const surface = document.createElement('canvas');
  surface.width = w;
  surface.height = h;
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.beginPath();
  context.moveTo(points[0].x - minX, points[0].y - minY);
  for (let i = 1; i < points.length; i++) context.lineTo(points[i].x - minX, points[i].y - minY);
  context.closePath();
  context.fill('evenodd');
  const pixels = context.getImageData(0, 0, w, h).data;
  surface.width = 0;
  const coverage = new Uint8Array(w * h);
  let painted = false;
  for (let i = 0; i < coverage.length; i++) {
    const alpha = pixels[i * 4 + 3];
    coverage[i] = antialias === 'none' ? (alpha >= 128 ? 255 : 0)
      : antialias === 'weak' ? Math.max(0, Math.min(255, (alpha - 64) * 2))
      : antialias === 'strong' && alpha > 0 && alpha < 255 ? Math.round(alpha / 2 + 64)
      : alpha;
    painted ||= coverage[i] > 0;
  }
  return painted ? { x: minX, y: minY, w, h, coverage } : null;
}

function blendFillPixel(px: Uint8Array, i: number, rgb: ReturnType<typeof hexToRgb>, opacity: number, alphaLocked: boolean) {
  const alpha = px[i + 3];
  if (alphaLocked && alpha === 0) return false;
  const keep = 1 - opacity;
  const strength = alphaLocked ? opacity * alpha / 255 : opacity;
  const r = Math.round(rgb.r * strength + px[i] * keep);
  const g = Math.round(rgb.g * strength + px[i + 1] * keep);
  const b = Math.round(rgb.b * strength + px[i + 2] * keep);
  const a = alphaLocked ? alpha : Math.round(255 * opacity + alpha * keep);
  if (r === px[i] && g === px[i + 1] && b === px[i + 2] && a === alpha) return false;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
  return true;
}

/** Paint bucket (click flood fill or lasso fill, like CSP's fill sub tools) and AI smart fill. */
export function useFillTools(ctx: ToolContext) {
  const {
    canvas, layers, activeLayer, user, isAdmin, brushProps,
    pixiAppRef, viewportRef, layerManagerRef, tileEngineRef, selectionEngineRef, activeLayerRef, brushPropsRef, userRef, scopedUndoRef,
    updateUndoRedoState, commitOp, commitTilePatch, refreshLayerThumbnail, canEditPixels, warn, requestRender,
  } = ctx;

  // Paint Bucket Tool settings (Supports: Current Layer, All Visible Layers, Specific Layer, None / Direct Selection Fill)
  const [bucketReference, setBucketReference] = useState<'current' | 'all' | 'specific' | 'none'>('all');
  const [bucketRefLayerId, setBucketRefLayerId] = useState<string | null>(null);
  const [bucketTolerance, setBucketTolerance] = useState<number>(32);
  const [bucketExpand, setBucketExpand] = useState<number>(1);
  // 點擊填色 (flood fill) or 套索填色 (fill the drawn lasso shape), like CSP's fill sub tools
  const [bucketMode, setBucketMode] = useState<'click' | 'lasso'>('click');
  const [lassoFillErase, setLassoFillErase] = useState(false);
  const [confirmSoloFullFill, setConfirmSoloFullFill] = useState(() => {
    try { return localStorage.getItem('atelier_confirm_solo_full_fill') === '1'; } catch { return false; }
  });
  const [fullFillLayer, setFullFillLayer] = useState<string | null>(null);
  const resolveFullFill = useRef<((accepted: boolean) => void) | null>(null);
  const finishFullFill = (accepted: boolean) => {
    const resolve = resolveFullFill.current;
    resolveFullFill.current = null;
    setFullFillLayer(null);
    resolve?.(accepted);
  };
  useEffect(() => {
    finishFullFill(false);
    return () => {
      resolveFullFill.current?.(false);
      resolveFullFill.current = null;
    };
  }, [canvas?.id, activeLayer?.id, ctx.currentTool]);
  const updateConfirmSoloFullFill = (enabled: boolean) => {
    setConfirmSoloFullFill(enabled);
    try { localStorage.setItem('atelier_confirm_solo_full_fill', enabled ? '1' : '0'); } catch { /* use the current session */ }
  };
  // AI Smart Enclose & Fill configuration
  const [referenceLayerId, setReferenceLayerId] = useState<string | null>(null);
  const [gapClosingRadius, setGapClosingRadius] = useState<number>(4);
  const [expandRadius, setExpandRadius] = useState<number>(2);

  /** Tools whose drag draws a lasso outline (finished by executeLassoFill / executeSmartFill) */
  const isLassoFill = (tool: ToolType) => tool === 'smart_fill' || (tool === 'bucket' && bucketMode === 'lasso');

  // Lasso fill (CSP 套索填充): the shape drawn with the lasso is filled with the current colour,
  // clipped by an active selection and respecting alpha lock. With the outline setting on (shared
  // with the brush), the fill colour's region gets the same outer ring, in the same op.
  const executeLassoFill = (outline?: OutlineSettings) => {
    const sel = selectionEngineRef.current;
    const layer = activeLayerRef.current;
    const te = tileEngineRef.current;
    if (!sel || !canvas || !layer || !te || !layerManagerRef.current) return;
    const pts = sel.getCurrentPoints();
    sel.clearDraft();
    if (pts.length < 3) return;
    if (ctx.rejectAdjustmentPixels(layer)) return;
    if (!canEditPixels(layer)) {
      warn('請先選取自己可編輯、未鎖定的圖層，再使用套索填充。', 3000);
      return;
    }
    const alphaLocked = Boolean(layer.alphaLocked);
    if (lassoFillErase && alphaLocked) return;
    const item = layerManagerRef.current.getLayerItem(layer.id);
    if (!item) return;
    const props = brushPropsRef.current || brushProps;
    const mask = lassoCoverage(pts, canvas.width, canvas.height, props.antiAlias ?? 'medium');
    if (!mask) return;
    const { x: maskX, y: maskY, w: maskWidth, h: maskHeight, coverage } = mask;
    // α lock only recolours what is there: no ring around it
    const ring = outline?.enabled && !lassoFillErase && !alphaLocked ? outline : null;
    const margin = ring ? ring.width + 2 : 0;
    const x = Math.max(0, mask.x - margin);
    const y = Math.max(0, mask.y - margin);
    const w = Math.min(canvas.width, mask.x + mask.w + margin) - x;
    const h = Math.min(canvas.height, mask.y + mask.h + margin) - y;
    const coords = te.getDirtyTilesForBounds(x, y, x + w, y + h);
    const lm = layerManagerRef.current;
    const layerId = layer.id;
    const selMask = sel.hasSelection() ? sel.getMaskArray() : null;
    // Read without stalling (a sparse layer stays sparse), fill on the CPU, write back; in order
    commitInOrder(
      () => lm.readAsync(layerId, [{ x, y, w, h }]).then(([px]) => {
        if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== item || !canEditPixels(item.model)) return null;
        const locked = Boolean(item.model.alphaLocked);
        if (lassoFillErase && locked) return null;
        if (!fillLasso(px, locked)) return null;
        const diff = diffTilesAsync(lm, layerId, coords, () => lm.writeRegion(layerId, x, y, w, h, px), 'before');
        lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline
        return diff;
      }),
      (res) => {
        if (!res || layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== item) return;
        scopedUndoRef.current.push({
          opId: `op_lassofill_${Date.now()}`,
          userId: userRef.current?.id || 'guest',
          layerId,
          opType: 'STROKE',
          beforeTiles: res.beforeTiles,
          afterTiles: res.afterTiles,
          timestamp: Date.now(),
          desc: lassoFillErase ? '套索擦除' : '套索填色',
        });
        updateUndoRedoState();
        commitOp(layerId, 'STROKE', { tool: 'lasso_fill', tiles: res.afterTiles }, true);
        if (!lassoFillErase && res.afterTiles.length > 0) recordUsedColor(props.color);
      },
    );

    const cw = canvas.width;
    function fillLasso(px: Uint8Array, locked: boolean) {
      const rgb = hexToRgb(props.color);
      let erased = false;
      for (let row = 0; row < maskHeight; row++) {
        for (let col = 0; col < maskWidth; col++) {
          const ci = (maskY + row) * cw + maskX + col;
          const m = (coverage[row * maskWidth + col] / 255) * props.opacity * ((selMask?.[ci] ?? 255) / 255);
          if (m <= 0) continue;
          const i = ((maskY - y + row) * w + maskX - x + col) * 4;
          if (lassoFillErase) {
            erased ||= Math.round(px[i + 3] * (1 - m)) !== px[i + 3];
            for (let k = 0; k < 4; k++) px[i + k] = Math.round(px[i + k] * (1 - m));
          } else {
            blendFillPixel(px, i, rgb, m, locked);
          }
        }
      }
      if (ring && !locked) {
        const filled = selMask ? px.slice() : null;
        applyColorOutline(px, w, h, props.color, ring);
        // The ring stays inside an active selection, like the fill
        if (filled && selMask) {
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const s = selMask[(y + row) * cw + (x + col)] / 255;
              if (s >= 1) continue;
              const i = (row * w + col) * 4;
              for (let k = 0; k < 4; k++) px[i + k] = Math.round(filled[i + k] + (px[i + k] - filled[i + k]) * s);
            }
          }
        }
      }
      return !lassoFillErase || erased;
    }
  };

  const unfilledStrokeRef = useRef<{ points: Point[]; layerId: string; preview: Graphics | null } | null>(null);
  const cancelPaintUnfilled = () => {
    const stroke = unfilledStrokeRef.current;
    unfilledStrokeRef.current = null;
    if (stroke?.preview && !stroke.preview.destroyed) {
      stroke.preview.destroy();
      requestRender();
    }
  };
  useEffect(() => cancelPaintUnfilled, [canvas?.id, ctx.currentTool]);

  const drawUnfilledPreview = (points: Point[], preview: Graphics) => {
    const props = brushPropsRef.current ?? brushProps;
    const radius = Math.max(1, props.size / 2);
    const start = points[0];
    preview.clear();
    if (points.length === 1) {
      preview.circle(start.x, start.y, radius).fill({ color: props.color, alpha: 0.35 });
    } else {
      preview.moveTo(start.x, start.y);
      for (let i = 1; i < points.length; i++) preview.lineTo(points[i].x, points[i].y);
      preview.stroke({ color: props.color, alpha: 0.35, width: radius * 2, cap: 'round', join: 'round' });
    }
    requestRender();
  };

  const startPaintUnfilled = (local: Point, targetLayer: LayerModel): boolean => {
    if (ctx.rejectAdjustmentPixels(targetLayer)) return false;
    if (!canEditPixels(targetLayer)) {
      warn('請先選取自己可編輯、未鎖定的圖層，再使用間隙填充筆。', 3000);
      return false;
    }
    cancelPaintUnfilled();
    const world = viewportRef.current?.canvasContainer;
    const preview = world ? world.addChild(new Graphics()) : null;
    const points = [local];
    unfilledStrokeRef.current = { points, layerId: targetLayer.id, preview };
    if (preview) drawUnfilledPreview(points, preview);
    return true;
  };

  const movePaintUnfilled = (local: Point): void => {
    const stroke = unfilledStrokeRef.current;
    if (!stroke) return;
    const last = stroke.points[stroke.points.length - 1];
    if ((local.x - last.x) ** 2 + (local.y - last.y) ** 2 < 1.5 ** 2) return;
    stroke.points.push(local);
    if (stroke.preview && !stroke.preview.destroyed) drawUnfilledPreview(stroke.points, stroke.preview);
  };

  const finishPaintUnfilled = (): boolean => {
    const stroke = unfilledStrokeRef.current;
    if (!stroke) return false;
    cancelPaintUnfilled();
    const { layerId, points } = stroke;
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    const item = lm?.getLayerItem(layerId);
    if (!canvas || !lm || !te || !item || !canEditPixels(item.model)) return true;
    const { width, height } = canvas;
    const props = brushPropsRef.current ?? brushProps;
    const opacity = Math.max(0, Math.min(1, props.opacity));
    const options = {
      brushRadius: Math.max(1, props.size / 2),
      gapClosingRadius, expandRadius, lineThreshold: Math.max(32, 255 - bucketTolerance),
    };
    const roi = getPaintUnfilledAreaBounds(points, width, height, options);
    if (!roi || opacity === 0) return true;
    const { minX: x, minY: y, maxX, maxY } = roi;
    const w = maxX - x + 1, h = maxY - y + 1;
    if (lm.deviceProfile.isConstrained && w * h > 4_194_304) return true;
    const selection = selectionEngineRef.current;
    const selectionMask = selection?.hasSelection() ? selection.getMaskArray() : null;
    const rgb = hexToRgb(props.color);
    const reference = bucketReference === 'none' ? 'current' : bucketReference;
    const isTargetReady = () => layerManagerRef.current === lm && lm.getLayerItem(layerId) === item && canEditPixels(item.model);

    commitInOrder(async () => {
      if (!isTargetReady()) return null;
      const rects = [{ x, y, w, h }];
      const refLayerId = reference === 'specific' && bucketRefLayerId && lm.getLayerItem(bucketRefLayerId)
        ? bucketRefLayerId : layerId;
      const readEdit = lm.readAsync(layerId, rects);
      const readReference = reference === 'all' ? lm.readCompositeRegionsAsync(rects, false)
        : refLayerId === layerId ? readEdit : lm.readAsync(refLayerId, rects);
      const [[refPixels], [editPixels]] = await Promise.all([readReference, readEdit]);
      if (!isTargetReady()) return null;
      const mask = computePaintUnfilledAreaMask(points.map((p) => ({ x: p.x - x, y: p.y - y })), refPixels, w, h, {
        ...options, editPixels: reference === 'current' ? undefined : editPixels,
      });
      if (!mask.activePixelCount) return null;

      const alphaLocked = Boolean(item.model.alphaLocked);
      let left = w, top = h, right = -1, bottom = -1;
      for (let row = mask.bounds.minY; row <= mask.bounds.maxY; row++) {
        for (let col = mask.bounds.minX; col <= mask.bounds.maxX; col++) {
          const i = row * w + col;
          if (!mask.data[i]) continue;
          const coverage = selectionMask?.[(y + row) * width + x + col] ?? 255;
          if (!coverage || !blendFillPixel(editPixels, i * 4, rgb, opacity * coverage / 255, alphaLocked)) continue;
          left = Math.min(left, col);
          right = Math.max(right, col);
          top = Math.min(top, row);
          bottom = Math.max(bottom, row);
        }
      }
      if (right < left) return null;
      const patchX = x + left, patchY = y + top;
      const patchW = right - left + 1, patchH = bottom - top + 1;
      const pixels = new Uint8Array(patchW * patchH * 4);
      for (let row = 0; row < patchH; row++) {
        const from = ((top + row) * w + left) * 4;
        pixels.set(editPixels.subarray(from, from + patchW * 4), row * patchW * 4);
      }
      const coords = te.getDirtyTilesForBounds(patchX, patchY, patchX + patchW, patchY + patchH);
      const diff = diffTilesAsync(lm, layerId, coords, () => lm.writeRegion(layerId, patchX, patchY, patchW, patchH, pixels));
      lm.syncPingPong(layerId);
      return diff;
    }, (res) => {
      if (!res || layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== item) return;
      const timestamp = Date.now();
      const op: ScopedUndoOp = {
        opId: `op_paintunfilled_${timestamp}`,
        userId: userRef.current?.id || 'guest',
        layerId,
        opType: 'STROKE',
        beforeTiles: res.beforeTiles,
        afterTiles: res.afterTiles,
        timestamp,
        desc: '間隙填充筆',
      };
      scopedUndoRef.current.push(op);
      updateUndoRedoState();
      refreshLayerThumbnail(layerId);
      commitOp(layerId, 'STROKE', { tool: 'paint_unfilled', tiles: res.afterTiles }, true);
      if (res.afterTiles.length > 0) recordUsedColor(props.color);
    });
    return true;
  };

  // AI Smart Enclose & Fill (Auto-Flatting) Execution
  const executeSmartFill = () => {
    if (
      !selectionEngineRef.current ||
      !canvas ||
      !activeLayer ||
      !layerManagerRef.current ||
      !tileEngineRef.current ||
      !pixiAppRef.current
    ) {
      selectionEngineRef.current?.clearDraft();
      return;
    }

    const pts = selectionEngineRef.current.getCurrentPoints();
    selectionEngineRef.current.clearDraft();

    if (pts.length < 3) return;

    if (ctx.rejectAdjustmentPixels(activeLayer)) return;
    if (activeLayer.isLocked) {
      warn('⚠️ 此圖層目前已被鎖定，無法進行智能填色！', 3000);
      return;
    }

    const isOwner = Boolean(user?.id && activeLayer.ownerId === user.id);
    const isPublicUnclaimed = Boolean(activeLayer.isPublic || !activeLayer.ownerId);
    if (isPublicUnclaimed && !isAdmin) {
      warn('📢 此圖層為公開圖層，請先在右側圖層面板點擊「接管此圖層」後方可填色！', 3500);
      return;
    }
    const canFill = isOwner || isAdmin || activeLayer.aclMode === 'shared_all';
    if (!canFill) {
      warn('⚠️ 您不是此圖層的擁有者，無法在此圖層填色！', 3000);
      return;
    }

    // Automatic reference follows the visible drawing rather than guessing a layer from its name.
    const targetRefLayer = referenceLayerId ? layers.find(l => l.id === referenceLayerId) : undefined;
    const refItem = targetRefLayer ? layerManagerRef.current.getLayerItem(targetRefLayer.id) : true;
    const activeItem = layerManagerRef.current.getLayerItem(activeLayer.id);
    if (!refItem || !activeItem) return;

    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    const layerId = activeLayer.id;
    const refLayerId = targetRefLayer?.id;
    const refName = targetRefLayer?.name ?? '可見圖層';
    const rgb = hexToRgb(brushProps.color);
    const alpha = Math.max(0.05, Math.min(1, brushProps.opacity));
    const padding = Math.max(8, (gapClosingRadius + expandRadius) * 2);
    const minX = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - padding));
    const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - padding));
    const maxX = Math.min(canvas.width - 1, Math.ceil(Math.max(...pts.map((p) => p.x)) + padding));
    const maxY = Math.min(canvas.height - 1, Math.ceil(Math.max(...pts.map((p) => p.y)) + padding));
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w <= 0 || h <= 0) return;
    if (lm.deviceProfile.isConstrained && w * h > 4_194_304) return;

    commitInOrder(async () => {
      if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== activeItem) return null;
      const rects = [{ x: minX, y: minY, w, h }];
      const [refPixels] = refLayerId
        ? await lm.readAsync(refLayerId, rects)
        : await lm.readCompositeRegionsAsync(rects, true);
      if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== activeItem) return null;
      const fill = computeSmartEncloseFillMask(
        pts.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        refPixels, w, h, { gapClosingRadius, expandRadius, lineThreshold: 180, isWhiteBackgroundLineart: refLayerId ? undefined : true },
      );
      if (!fill.activePixelCount) return null;
      const bounds = {
        minX: fill.bounds.minX + minX, minY: fill.bounds.minY + minY,
        maxX: fill.bounds.maxX + minX, maxY: fill.bounds.maxY + minY,
      };
      const pw = bounds.maxX - bounds.minX + 1;
      const ph = bounds.maxY - bounds.minY + 1;
      const [pixels] = await lm.readAsync(layerId, [{ x: bounds.minX, y: bounds.minY, w: pw, h: ph }]);
      if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== activeItem) return null;
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          if (!fill.data[(y + fill.bounds.minY) * w + x + fill.bounds.minX]) continue;
          const i = (y * pw + x) * 4;
          pixels[i] = Math.round(rgb.r * alpha + pixels[i] * (1 - alpha));
          pixels[i + 1] = Math.round(rgb.g * alpha + pixels[i + 1] * (1 - alpha));
          pixels[i + 2] = Math.round(rgb.b * alpha + pixels[i + 2] * (1 - alpha));
          pixels[i + 3] = Math.round(255 * alpha + pixels[i + 3] * (1 - alpha));
        }
      }
      const coords = te.getDirtyTilesForBounds(bounds.minX, bounds.minY, bounds.maxX + 1, bounds.maxY + 1);
      const diff = diffTilesAsync(lm, layerId, coords, () => lm.writeRegion(layerId, bounds.minX, bounds.minY, pw, ph, pixels));
      lm.syncPingPong(layerId);
      return { ...(await diff), bounds };
    }, (result) => {
      if (!result || layerManagerRef.current !== lm) return;
      const { beforeTiles, afterTiles, bounds } = result;
      if (user) {
        scopedUndoRef.current.push({
          opId: `op_fill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: user.id, layerId, opType: 'SMART_FILL', beforeTiles, afterTiles,
          timestamp: Date.now(), desc: `智能線稿填色 (${refName})`,
        });
        updateUndoRedoState();
      }
      commitOp(layerId, 'SMART_FILL', { tiles: afterTiles, refLayerId, color: brushProps.color, bounds }, true);
      if (afterTiles.length > 0) recordUsedColor(brushProps.color);
    });
  };

  // Paint Bucket (Flood Fill) Tool
  const handleBucketFill = (screenX: number, screenY: number, targetLayer: LayerModel) => {
    if (ctx.rejectAdjustmentPixels(targetLayer)) return;
    if (!canvas || resolveFullFill.current || !layerManagerRef.current || !viewportRef.current || !tileEngineRef.current || !pixiAppRef.current) return;
    const activeItem = layerManagerRef.current.getLayerItem(targetLayer.id);
    if (!activeItem) return;

    const local = viewportRef.current.screenToCanvas(screenX, screenY);
    const wrap = ctx.wrapAroundRef.current;
    const pixel = { x: Math.round(local.x), y: Math.round(local.y) };
    const { x: clickX, y: clickY } = wrap ? wrapPoint(pixel.x, pixel.y, canvas.width, canvas.height) : pixel;
    if (clickX < 0 || clickX >= canvas.width || clickY < 0 || clickY >= canvas.height) return;

    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    const layerId = targetLayer.id;
    const W = canvas.width;
    const H = canvas.height;
    const color = brushProps.color;
    const opacity = brushProps.opacity;
    const reference = bucketReference;
    const refLayerId = bucketReference === 'specific' && bucketRefLayerId && lm.getLayerItem(bucketRefLayerId) ? bucketRefLayerId : layerId;
    const sel = selectionEngineRef.current;
    const confirmWholeCanvas = !OfflineSessionStore.isOfflineCanvas(canvas.id) || confirmSoloFullFill;

    // Read → flood fill → paint → before/after, one fill after another (two quick clicks never
    // both read the layer from before the first). Reads never stall the page (they used to read the
    // whole layer synchronously: 305 MB at 10000×8000), and a sparse layer stays sparse.
    commitInOrder(async () => {
      if (layerManagerRef.current !== lm) return null;
      const selection = sel?.hasSelection() ? sel.getSelection() : null;
      const selectionMask = selection ? sel?.getMaskArray() : null;
      if (reference !== 'none' && selectionMask && !selectionMask[clickY * W + clickX]) return null;
      let maskArray: Uint8Array | null = null;
      let tiledMask: Awaited<ReturnType<typeof tiledBucketFill>> = null;
      let bounds = { minX: 0, minY: 0, maxX: W - 1, maxY: H - 1 };
      const tiled = !lm.allowFullCanvasTextures || W * H >= 16_000_000;

      // A sparse raster layer with no occupied tiles has a uniform reference.
      const emptyReference = (id: string) => lm.occupiedTiles(id)?.length === 0;
      const uniform = reference === 'none' || (reference === 'all'
        ? layers.every((layer) => !layer.isVisible || layer.layerType === 'group' ||
          (layer.layerType === 'raster' && emptyReference(layer.id)))
        : emptyReference(refLayerId));

      if (!uniform) {
        const ruler = RulerManager.getInstance();
        const seeds = ruler.state.mode === 'symmetry'
          ? ruler.getSymmetryPoints({ x: clickX, y: clickY }).map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }))
          : [{ x: clickX, y: clickY }];
        const read = (rects: Parameters<typeof lm.readAsync>[1]) => reference === 'all'
          ? lm.readCompositeRegionsAsync(rects, false) : lm.readAsync(refLayerId, rects);
        const version = reference === 'all' ? lm.getVisibleCompositeVersion() : lm.getLayerItem(refLayerId)?.version;
        const current = () => layerManagerRef.current === lm && lm.getLayerItem(layerId) === activeItem &&
          version === (reference === 'all' ? lm.getVisibleCompositeVersion() : lm.getLayerItem(refLayerId)?.version);
        if (tiled) {
          const fill = await tiledBucketFill(W, H, seeds, bucketTolerance, bucketExpand, wrap, async (rect) => (await read([rect]))[0], current);
          if (!fill || !current()) return null;
          bounds = fill.bounds;
          if (!fill.coversCanvas) tiledMask = fill;
        } else {
          const [pixels] = await read([{ x: 0, y: 0, w: W, h: H }]);
          if (!current()) return null;
          const fill = await calculateBucketMask(pixels, W, H, seeds, bucketTolerance, bucketExpand, wrap);
          if (!fill || !current()) return null;
          maskArray = fill.data;
          bounds = fill.bounds;
        }
      }

      if (selection && selectionMask) {
        bounds = {
          minX: Math.max(bounds.minX, selection.bounds.minX),
          minY: Math.max(bounds.minY, selection.bounds.minY),
          maxX: Math.min(bounds.maxX, selection.bounds.maxX),
          maxY: Math.min(bounds.maxY, selection.bounds.maxY),
        };
      }

      const { minX, minY, maxX, maxY } = bounds;
      if (confirmWholeCanvas && !maskArray && !tiledMask && !selectionMask && opacity > 0) {
        if (ctx.currentToolRef.current !== 'bucket' || activeLayerRef.current?.id !== layerId) return null;
        const version = activeItem.version;
        const accepted = await new Promise<boolean>((resolve) => {
          resolveFullFill.current = resolve;
          setFullFillLayer(targetLayer.name);
        });
        const liveLayer = activeLayerRef.current;
        if (!accepted || layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== activeItem ||
          activeItem.version !== version || !liveLayer || liveLayer.id !== layerId || !canEditPixels(liveLayer)) return null;
      }
      const patchW = maxX - minX + 1;
      const patchH = maxY - minY + 1;
      if (patchW <= 0 || patchH <= 0) return null;
      const rgb = hexToRgb(color);
      const dirtyCoords = te.getDirtyTilesForBounds(minX, minY, maxX + 1, maxY + 1);
      if (!maskArray && !tiledMask && !selectionMask && opacity >= 1 && emptyReference(layerId)) {
        // The old layer is empty and the new pixels are known. Reuse the tile bytes
        // across the whole fill and skip both GPU readbacks.
        const bySize = new Map<string, { raw: Uint8Array; blank: ReturnType<typeof compressTileBuffer>; solid: ReturnType<typeof compressTileBuffer> }>();
        const beforeTiles: TileData[] = [];
        const afterTiles: TileData[] = [];
        const decoded = new WeakMap<TileData, Uint8Array>();
        for (const { col, row } of dirtyCoords) {
          const { width, height } = getTileBounds(col, row, te.tileSize, W, H);
          const key = `${width}x${height}`;
          let cached = bySize.get(key);
          if (!cached) {
            const blank = compressTileBuffer(new Uint8Array(width * height * 4));
            const raw = new Uint8Array(width * height * 4);
            for (let index = 0; index < raw.length; index += 4) {
              raw[index] = rgb.r;
              raw[index + 1] = rgb.g;
              raw[index + 2] = rgb.b;
              raw[index + 3] = 255;
            }
            cached = { raw, blank, solid: compressTileBuffer(raw) };
            bySize.set(key, cached);
          }
          const tile = { col, row, width, height };
          beforeTiles.push({ ...tile, ...cached.blank, byteLength: cached.blank.data.byteLength });
          const after = { ...tile, ...cached.solid, byteLength: cached.solid.data.byteLength };
          afterTiles.push(after);
          decoded.set(after, cached.raw);
        }
        lm.applyTiles(layerId, afterTiles, undefined, decoded);
        lm.syncPingPong(layerId);
        return { beforeTiles, afterTiles };
      }
      if (tiled) {
        const version = activeItem.version;
        const current = () => layerManagerRef.current === lm && lm.getLayerItem(layerId) === activeItem &&
          activeItem.version === version && canEditPixels(activeItem.model);
        const beforeTiles: TileData[] = [];
        const afterTiles: TileData[] = [];
        let bytes = 0;
        for (let start = 0; start < dirtyCoords.length; start += 8) {
          const batch = dirtyCoords.slice(start, start + 8);
          const rects = batch.map(({ col, row }) => {
            const { width, height } = getTileBounds(col, row, te.tileSize, W, H);
            return { x: col * te.tileSize, y: row * te.tileSize, w: width, h: height };
          });
          const source = await lm.readAsync(layerId, rects);
          if (!current()) return null;
          for (let index = 0; index < batch.length; index++) {
            const rect = rects[index];
            const coverage = tiledMask?.maskFor(rect);
            const before = source[index];
            const after = before.slice();
            let changed = false;
            for (let row = 0; row < rect.h; row++) {
              for (let col = 0; col < rect.w; col++) {
                const i = row * rect.w + col;
                const pos = (rect.y + row) * W + rect.x + col;
                const alpha = Math.min(coverage?.[i] ?? 255, selectionMask?.[pos] ?? 255) * opacity / 255;
                if (alpha <= 0) continue;
                const off = i * 4;
                after[off] = Math.round(rgb.r * alpha + before[off] * (1 - alpha));
                after[off + 1] = Math.round(rgb.g * alpha + before[off + 1] * (1 - alpha));
                after[off + 2] = Math.round(rgb.b * alpha + before[off + 2] * (1 - alpha));
                after[off + 3] = Math.round(255 * alpha + before[off + 3] * (1 - alpha));
                changed ||= after[off] !== before[off] || after[off + 1] !== before[off + 1] ||
                  after[off + 2] !== before[off + 2] || after[off + 3] !== before[off + 3];
              }
            }
            if (!changed) continue;
            const tile = { ...batch[index], width: rect.w, height: rect.h };
            const old = compressTileBuffer(before);
            const next = compressTileBuffer(after);
            bytes += old.data.byteLength + next.data.byteLength;
            if (bytes > (lm.deviceProfile.isConstrained ? 96 : 384) * 1048576) return null;
            beforeTiles.push({ ...tile, ...old, byteLength: old.data.byteLength });
            afterTiles.push({ ...tile, ...next, byteLength: next.data.byteLength });
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (!current() || !afterTiles.length) return null;
        lm.applyTiles(layerId, afterTiles);
        lm.syncPingPong(layerId);
        ctx.requestRender();
        return { beforeTiles, afterTiles };
      }
      let patchTexture: Texture | undefined;
      let patch: Sprite | Graphics;
      if (maskArray || selectionMask) {
        const patchCanvas = document.createElement('canvas');
        patchCanvas.width = patchW;
        patchCanvas.height = patchH;
        const ctx2d = patchCanvas.getContext('2d');
        if (!ctx2d) return null;
        const img = ctx2d.createImageData(patchW, patchH);
        const alphaByte = Math.round(opacity * 255);
        let painted = false;
        for (let py = 0; py < patchH; py++) {
          for (let px = 0; px < patchW; px++) {
            const pos = (minY + py) * W + minX + px;
            const coverage = Math.min(maskArray?.[pos] ?? 255, selectionMask?.[pos] ?? 255);
            if (!coverage) continue;
            const index = (py * patchW + px) * 4;
            img.data[index] = rgb.r;
            img.data[index + 1] = rgb.g;
            img.data[index + 2] = rgb.b;
            img.data[index + 3] = Math.round(coverage / 255 * alphaByte);
            painted = true;
          }
        }
        if (!painted) return null;
        ctx2d.putImageData(img, 0, 0);
        patchTexture = Texture.from(patchCanvas);
        patch = new Sprite(patchTexture);
        patch.position.set(minX, minY);
      } else {
        const tint = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
        patch = new Graphics().rect(minX, minY, patchW, patchH).fill({ color: tint, alpha: opacity });
      }
      lm.syncPingPong(layerId);
      const diff = diffTilesAsync(lm, layerId, dirtyCoords, () => {
        const holder = new Container();
        holder.addChild(patch);
        const target = lm.drawTarget(layerId);
        if (target instanceof RenderTexture) pixiAppRef.current?.renderer.render({ container: holder, target, clear: false });
        else target?.draw(holder, minX, minY, patchW, patchH);
        ctx.requestRender();
        holder.destroy({ children: true });
        patchTexture?.destroy(true);
      }, 'before');
      lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline
      return diff;
    }, (res) => {
      if (!res) return;
      // Record Undo Op
      const undoOp: ScopedUndoOp = {
        opId: `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: userRef.current?.id || user?.id || 'guest',
        layerId,
        opType: 'FILL',
        beforeTiles: res.beforeTiles,
        afterTiles: res.afterTiles,
        timestamp: Date.now(),
        desc: '油漆桶填充',
      };
      scopedUndoRef.current.push(undoOp);
      updateUndoRedoState();
      refreshLayerThumbnail(layerId);
      // Broadcast to room
      commitTilePatch(layerId, res.afterTiles, false, '油漆桶填充', true);
      if (res.afterTiles.length > 0) recordUsedColor(color);
    });
  };

  return {
    bucketReference, setBucketReference,
    bucketRefLayerId, setBucketRefLayerId,
    bucketTolerance, setBucketTolerance,
    bucketExpand, setBucketExpand,
    bucketMode, setBucketMode,
    lassoFillErase, setLassoFillErase,
    confirmSoloFullFill, updateConfirmSoloFullFill,
    fullFillLayer, finishFullFill,
    referenceLayerId, setReferenceLayerId,
    gapClosingRadius, setGapClosingRadius,
    expandRadius, setExpandRadius,
    isLassoFill,
    executeLassoFill,
    executeSmartFill,
    handleBucketFill,
    startPaintUnfilled, movePaintUnfilled, finishPaintUnfilled, cancelPaintUnfilled,
  };
}

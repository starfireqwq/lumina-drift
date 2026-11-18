import { useState } from 'react';
import { Container, Graphics, RenderTexture, Sprite, Texture } from 'pixi.js';
import {
  compressTileBuffer,
  computeSmartEncloseFillMask,
  getTileBounds,
  hexToRgb,
  LayerModel,
  rasterizeLassoMask,
  ScopedUndoOp,
  TileData,
  ToolType,
} from '@atelier/shared';
import { applyColorOutline, type OutlineSettings } from '../../../engine/colorOutline';
import { calculateBucketMask } from '../../../engine/commitWorkers';
import { RulerManager } from '../../../engine/RulerManager';
import type { ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

/** Paint bucket (click flood fill or lasso fill, like CSP's fill sub tools) and AI smart fill. */
export function useFillTools(ctx: ToolContext) {
  const {
    canvas, layers, activeLayer, user, isAdmin, brushProps,
    pixiAppRef, viewportRef, layerManagerRef, tileEngineRef, selectionEngineRef, activeLayerRef, brushPropsRef, userRef, scopedUndoRef,
    updateUndoRedoState, commitOp, commitTilePatch, refreshLayerThumbnail, canEditPixels, warn,
  } = ctx;

  // Paint Bucket Tool settings (Supports: Current Layer, All Visible Layers, Specific Layer, None / Direct Selection Fill)
  const [bucketReference, setBucketReference] = useState<'current' | 'all' | 'specific' | 'none'>('all');
  const [bucketRefLayerId, setBucketRefLayerId] = useState<string | null>(null);
  const [bucketTolerance, setBucketTolerance] = useState<number>(32);
  const [bucketExpand, setBucketExpand] = useState<number>(1);
  // 點擊填色 (flood fill) or 套索填色 (fill the drawn lasso shape), like CSP's fill sub tools
  const [bucketMode, setBucketMode] = useState<'click' | 'lasso'>('click');
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
    if (!canEditPixels(layer)) {
      warn('請先選取自己可編輯、未鎖定的圖層，再使用套索填色。', 3000);
      return;
    }
    const item = layerManagerRef.current.getLayerItem(layer.id);
    if (!item) return;
    const mask = rasterizeLassoMask(pts, canvas.width, canvas.height);
    if (!mask.activePixelCount) return;
    // α lock only recolours what is there: no ring around it
    const ring = outline?.enabled && !layer.alphaLocked ? outline : null;
    const margin = ring ? ring.width + 2 : 0;
    const x = Math.max(0, mask.bounds.minX - margin);
    const y = Math.max(0, mask.bounds.minY - margin);
    const w = Math.min(canvas.width - 1, mask.bounds.maxX + margin) - x + 1;
    const h = Math.min(canvas.height - 1, mask.bounds.maxY + margin) - y + 1;
    const coords = te.getDirtyTilesForBounds(x, y, x + w, y + h);
    const lm = layerManagerRef.current;
    const layerId = layer.id;
    const props = brushPropsRef.current || brushProps;
    const selMask = sel.hasSelection() ? sel.getMaskArray() : null;
    // Read without stalling (a sparse layer stays sparse), fill on the CPU, write back; in order
    commitInOrder(
      () => lm.readAsync(layerId, [{ x, y, w, h }]).then(([px]) => {
        if (layerManagerRef.current !== lm) return null;
        fillLasso(px);
        const diff = diffTilesAsync(lm, layerId, coords, () => lm.writeRegion(layerId, x, y, w, h, px), 'before');
        lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline
        return diff;
      }),
      (res) => {
        if (!res) return;
        scopedUndoRef.current.push({
          opId: `op_lassofill_${Date.now()}`,
          userId: userRef.current?.id || 'guest',
          layerId,
          opType: 'STROKE',
          beforeTiles: res.beforeTiles,
          afterTiles: res.afterTiles,
          timestamp: Date.now(),
          desc: '套索填色',
        });
        updateUndoRedoState();
        commitOp(layerId, 'STROKE', { tool: 'lasso_fill', tiles: res.afterTiles }, true);
      },
    );

    const cw = canvas.width;
    const alphaLocked = Boolean(layer.alphaLocked);
    function fillLasso(px: Uint8Array) {
    const { r, g, b } = hexToRgb(props.color);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const ci = (y + row) * cw + (x + col);
        let m = (mask.data[ci] / 255) * props.opacity;
        if (selMask) m *= selMask[ci] / 255;
        if (m <= 0) continue;
        const i = (row * w + col) * 4;
        const dstA = px[i + 3];
        if (alphaLocked) {
          // Recolour only: keep the existing alpha (premultiplied colour scaled to it)
          if (dstA === 0) continue;
          px[i] = Math.round(r * (dstA / 255) * m + px[i] * (1 - m));
          px[i + 1] = Math.round(g * (dstA / 255) * m + px[i + 1] * (1 - m));
          px[i + 2] = Math.round(b * (dstA / 255) * m + px[i + 2] * (1 - m));
          continue;
        }
        px[i] = Math.round(r * m + px[i] * (1 - m));
        px[i + 1] = Math.round(g * m + px[i + 1] * (1 - m));
        px[i + 2] = Math.round(b * m + px[i + 2] * (1 - m));
        px[i + 3] = Math.round(255 * m + dstA * (1 - m));
      }
    }
    if (ring) {
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
    }
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

    commitInOrder(async () => {
      if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== activeItem) return null;
      const rects = [{ x: minX, y: minY, w, h }];
      const [refPixels] = refLayerId
        ? await lm.readAsync(refLayerId, rects)
        : await te.readRegionsAsync(lm.getCompositeTexture(true), rects);
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
    });
  };

  // Paint Bucket (Flood Fill) Tool
  const handleBucketFill = (screenX: number, screenY: number, targetLayer: LayerModel) => {
    if (!canvas || !layerManagerRef.current || !viewportRef.current || !tileEngineRef.current || !pixiAppRef.current) return;
    const activeItem = layerManagerRef.current.getLayerItem(targetLayer.id);
    if (!activeItem) return;

    const local = viewportRef.current.screenToCanvas(screenX, screenY);
    const clickX = Math.round(local.x);
    const clickY = Math.round(local.y);
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

    // Read → flood fill → paint → before/after, one fill after another (two quick clicks never
    // both read the layer from before the first). Reads never stall the page (they used to read the
    // whole layer synchronously: 305 MB at 10000×8000), and a sparse layer stays sparse.
    commitInOrder(async () => {
      if (layerManagerRef.current !== lm) return null;
      const selection = sel?.hasSelection() ? sel.getSelection() : null;
      const selectionMask = selection ? sel?.getMaskArray() : null;
      if (reference !== 'none' && selectionMask && !selectionMask[clickY * W + clickX]) return null;
      let maskArray: Uint8Array | null = null;
      let bounds = { minX: 0, minY: 0, maxX: W - 1, maxY: H - 1 };

      // A sparse raster layer with no occupied tiles has a uniform reference.
      const emptyReference = (id: string) => lm.occupiedTiles(id)?.length === 0;
      const uniform = reference === 'none' || (reference === 'all'
        ? layers.every((layer) => !layer.isVisible || layer.layerType === 'group' ||
          (layer.layerType === 'raster' && emptyReference(layer.id)))
        : emptyReference(refLayerId));

      if (!uniform) {
        const pixels = reference === 'all'
          ? (await te.readRegionsAsync(lm.getCompositeTexture(false), [{ x: 0, y: 0, w: W, h: H }]))[0]
          : (await lm.readAsync(refLayerId, [{ x: 0, y: 0, w: W, h: H }]))[0];
        if (layerManagerRef.current !== lm) return null;
        const ruler = RulerManager.getInstance();
        const seeds = ruler.state.mode === 'symmetry'
          ? ruler.getSymmetryPoints({ x: clickX, y: clickY }).map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }))
          : [{ x: clickX, y: clickY }];
        const fill = await calculateBucketMask(pixels, W, H, seeds, bucketTolerance, bucketExpand);
        if (!fill || layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== activeItem) return null;
        maskArray = fill.data;
        bounds = fill.bounds;
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
      const patchW = maxX - minX + 1;
      const patchH = maxY - minY + 1;
      if (patchW <= 0 || patchH <= 0) return null;
      const rgb = hexToRgb(color);
      const dirtyCoords = te.getDirtyTilesForBounds(minX, minY, maxX + 1, maxY + 1);
      if (!maskArray && !selectionMask && opacity >= 1 && emptyReference(layerId)) {
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
    });
  };

  return {
    bucketReference, setBucketReference,
    bucketRefLayerId, setBucketRefLayerId,
    bucketTolerance, setBucketTolerance,
    bucketExpand, setBucketExpand,
    bucketMode, setBucketMode,
    referenceLayerId, setReferenceLayerId,
    gapClosingRadius, setGapClosingRadius,
    expandRadius, setExpandRadius,
    isLassoFill,
    executeLassoFill,
    executeSmartFill,
    handleBucketFill,
  };
}

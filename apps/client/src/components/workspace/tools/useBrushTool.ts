import { useRef, useState } from 'react';
import { Sprite, Texture } from 'pixi.js';
import { DEFAULT_TILE_SIZE, type CanvasModel, type LayerModel, type ScopedUndoOp, type TileData, type ToolType } from '@atelier/shared';
import { applyColorOutline, OutlineSettings } from '../../../engine/colorOutline';
import { applyMagFilter } from '../../../engine/TileAtlas';
import { compressTiles, outlineRings, type OutlineRegion } from '../../../engine/commitWorkers';
import type { LayerManager, PixiLayerItem, Rect } from '../../../engine/LayerManager';
import type { BrushProperties } from '../../../engine/BrushRenderer';
import type { StrokeCommitData } from '../../../engine/StrokePipeline';
import type { Point, ToolContext } from './toolContext';
import { getWrapAroundBoundsOffsets, getWrappedDirtyTilesForPoints } from '../../../engine/wrapAround';
import { hasDrawingContact } from '../../../engine/tabletInput';
import { OfflineSessionStore } from '../../../services/offlineStore';
import { recordUsedColor } from '../../../services/colorHistoryStore';
import { readBeforeTilesAsync } from './asyncTiles';

const OUTLINE_KEY = 'atelier_outline_brush';

/** The window the outline is computed in: the stroke's points padded by its radius and the outline width */
const outlineWindow = (pts: ReadonlyArray<Point>, size: number, outlineWidth: number, canvas: CanvasModel) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = size / 2 + outlineWidth + 3;
  const x0 = Math.max(0, Math.floor(minX - pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const x1 = Math.min(canvas.width, Math.ceil(maxX + pad));
  const y1 = Math.min(canvas.height, Math.ceil(maxY + pad));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 } : null;
};

async function readOutlineRegions(lm: LayerManager, layerId: string, boxes: Rect[], wrappedCanvas?: CanvasModel) {
  if (!wrappedCanvas) return lm.readAsync(layerId, boxes);
  const { width, height } = wrappedCanvas;
  const chunks = boxes.flatMap((box, index) =>
    getWrapAroundBoundsOffsets(box.x, box.y, box.x + box.w, box.y + box.h, width, height).map(({ dx, dy }) => {
      const x = Math.max(0, box.x + dx);
      const y = Math.max(0, box.y + dy);
      return {
        index, ox: x - dx - box.x, oy: y - dy - box.y,
        rect: { x, y, w: Math.min(width, box.x + box.w + dx) - x, h: Math.min(height, box.y + box.h + dy) - y },
      };
    }));
  const pixels = await lm.readAsync(layerId, chunks.map(({ rect }) => rect));
  const out = boxes.map(({ w, h }) => new Uint8Array(w * h * 4));
  chunks.forEach(({ index, ox, oy, rect }, i) => {
    const stride = rect.w * 4;
    for (let row = 0; row < rect.h; row++) {
      out[index].set(pixels[i].subarray(row * stride, (row + 1) * stride), ((oy + row) * boxes[index].w + ox) * 4);
    }
  });
  return out;
}

/**
 * Raster brush / pencil / eraser (drawn by StrokePipeline straight into the layer), the outline
 * brush (描邊筆刷) with its live preview, and the eyedropper.
 */
export function useBrushTool(ctx: ToolContext) {
  const [outlineBrush, setOutlineBrush] = useState<OutlineSettings>(() => {
    try {
      return { enabled: false, width: 4, color: '#1f1f2b', ...JSON.parse(localStorage.getItem(OUTLINE_KEY) || '{}') };
    } catch {
      return { enabled: false, width: 4, color: '#1f1f2b' };
    }
  });
  const outlineRef = useRef(outlineBrush);
  outlineRef.current = outlineBrush;
  const updateOutlineBrush = (patch: Partial<OutlineSettings>) => {
    setOutlineBrush((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(OUTLINE_KEY, JSON.stringify(next));
      } catch {
        // not remembered
      }
      return next;
    });
  };

  // Tiles the stroke crossed, collected while drawing: undo restores all of them (handover rule 5)
  const strokeTouchedTileCoordsRef = useRef<Set<string>>(new Set());

  /* ---------- Live outline preview ---------- */

  // The ring is shown on 256 px tile sprites right above the stroke's layer. Every frame only the
  // area around the newest part of the stroke is recomputed (that area plus the outline reach on
  // each side, so the result is the same as computing the whole stroke), not the whole stroke:
  // the cost stays small however long the stroke gets.
  const PREVIEW_TILE = 256;
  const previewTilesRef = useRef(new Map<string, { canvas: HTMLCanvasElement; sprite: Sprite }>());
  const previewFromRef = useRef(0); // stroke points already covered
  const outlineRafRef = useRef<number | null>(null);

  const previewGenRef = useRef(0); // a read-back that lands after the preview was cleared is dropped
  /** Stops updating the ring but leaves it on screen (until the real outline is in the layer) */
  const freezeOutlinePreview = () => {
    if (outlineRafRef.current !== null) cancelAnimationFrame(outlineRafRef.current);
    outlineRafRef.current = null;
    previewFromRef.current = 0;
    previewGenRef.current++;
  };
  const clearOutlinePreview = () => {
    freezeOutlinePreview();
    for (const { sprite } of previewTilesRef.current.values()) {
      if (!sprite.destroyed) sprite.destroy({ texture: true, textureSource: true });
    }
    previewTilesRef.current.clear();
  };

  /** The preview tile at (col, row), made on first use */
  const previewTile = (col: number, row: number, item: PixiLayerItem, canvas: CanvasModel) => {
    const key = `${col}_${row}`;
    let tile = previewTilesRef.current.get(key);
    if (!tile || tile.sprite.destroyed) {
      const c = document.createElement('canvas');
      c.width = Math.min(PREVIEW_TILE, canvas.width - col * PREVIEW_TILE);
      c.height = Math.min(PREVIEW_TILE, canvas.height - row * PREVIEW_TILE);
      const tex = Texture.from(c);
      // Zoomed in far the layer shows sharp pixels: so does its ring preview
      if (ctx.layerManagerRef.current?.pixelated) applyMagFilter(tex, 'nearest');
      const sprite = new Sprite(tex);
      sprite.position.set(col * PREVIEW_TILE, row * PREVIEW_TILE);
      tile = { canvas: c, sprite };
      previewTilesRef.current.set(key, tile);
    }
    // Inside the stroke's layer, above its pixels: layers on top cover it as they will cover the real
    // outline, and it gets the layer's opacity, blend and masks
    if (tile.sprite.parent !== item.display) item.display.addChild(tile.sprite);
    return tile;
  };

  /**
   * The outline is written into the layer only at commit (it is part of the stroke's op). While
   * drawing, the same ring is computed on a copy of the stroke's pixels and shown on the preview
   * tiles, so a low-flow stroke crossing its own preview ring never mixes the ring colour into the layer.
   */
  const drawOutlinePreview = () => {
    const { canvas, strokePipelineRef, activeLayerRef, layerManagerRef, tileEngineRef, brushPropsRef } = ctx;
    const pipeline = strokePipelineRef.current;
    const layer = activeLayerRef.current;
    const props = brushPropsRef.current;
    const te = tileEngineRef.current;
    const lm = layerManagerRef.current;
    const item = layer ? lm?.getLayerItem(layer.id) : null;
    if (!pipeline?.getIsDrawing() || !item || !lm || !layer || !te || !props || !canvas || previewReadingRef.current) return;
    const pts = pipeline.getCurrentPoints();
    // The newest points, plus a few already seen: the smoothing worker stamps them a little later
    const from = Math.max(0, previewFromRef.current - 8);
    previewFromRef.current = pts.length;
    const reach = outlineRef.current.width + 2;
    const changed = outlineWindow(pts.slice(from), props.size, 0, canvas);
    if (!changed) return;
    // Recompute this area; read `reach` more around it so the ring at its edge is exact
    const upd = { x0: Math.max(0, changed.x0 - reach), y0: Math.max(0, changed.y0 - reach), x1: Math.min(canvas.width, changed.x1 + reach), y1: Math.min(canvas.height, changed.y1 + reach) };
    const wrap = pipeline.isStrokeWrapped();
    const box = {
      x0: wrap ? upd.x0 - reach : Math.max(0, upd.x0 - reach),
      y0: wrap ? upd.y0 - reach : Math.max(0, upd.y0 - reach),
      x1: wrap ? upd.x1 + reach : Math.min(canvas.width, upd.x1 + reach),
      y1: wrap ? upd.y1 + reach : Math.min(canvas.height, upd.y1 + reach),
    };
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    // Read back without stalling the frame (a synchronous read every frame made drawing stutter);
    // the ring shows a frame later, and the next area waits for this one
    previewReadingRef.current = true;
    const gen = previewGenRef.current;
    void readOutlineRegions(lm, layer.id, [{ x: box.x0, y: box.y0, w: bw, h: bh }], wrap ? canvas : undefined).then(([region]) => {
      previewReadingRef.current = false;
      if (gen !== previewGenRef.current || !ctx.strokePipelineRef.current?.getIsDrawing() || ctx.tileEngineRef.current !== te) return;
      paintOutlinePreview(region, box, upd, item, canvas, props.color);
    });
  };

  const previewReadingRef = useRef(false);
  /** Writes the ring (un-premultiplied) for area `upd` into the preview tiles; region = `box` read back */
  const paintOutlinePreview = (
    region: Uint8Array,
    box: { x0: number; y0: number; x1: number; y1: number },
    upd: { x0: number; y0: number; x1: number; y1: number },
    item: PixiLayerItem,
    canvas: CanvasModel,
    color: string,
  ) => {
    const bw = box.x1 - box.x0;
    const bh = box.y1 - box.y0;
    const ringed = region.slice();
    applyColorOutline(ringed, bw, bh, color, outlineRef.current);

    // Write the ring (un-premultiplied) into every preview tile the updated area crosses
    for (let row = Math.floor(upd.y0 / PREVIEW_TILE); row * PREVIEW_TILE < upd.y1; row++) {
      for (let col = Math.floor(upd.x0 / PREVIEW_TILE); col * PREVIEW_TILE < upd.x1; col++) {
        const tx = col * PREVIEW_TILE;
        const ty = row * PREVIEW_TILE;
        const x0 = Math.max(upd.x0, tx);
        const y0 = Math.max(upd.y0, ty);
        const x1 = Math.min(upd.x1, tx + PREVIEW_TILE);
        const y1 = Math.min(upd.y1, ty + PREVIEW_TILE);
        if (x1 <= x0 || y1 <= y0) continue;
        const tile = previewTile(col, row, item, canvas);
        const c2d = tile.canvas.getContext('2d');
        if (!c2d) continue;
        const img = c2d.createImageData(x1 - x0, y1 - y0);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = ((y - box.y0) * bw + (x - box.x0)) * 4;
            const a = ringed[i + 3];
            if (!a || (ringed[i] === region[i] && ringed[i + 1] === region[i + 1] && ringed[i + 2] === region[i + 2] && a === region[i + 3])) continue;
            const o = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
            img.data[o] = Math.min(255, Math.round((ringed[i] * 255) / a));
            img.data[o + 1] = Math.min(255, Math.round((ringed[i + 1] * 255) / a));
            img.data[o + 2] = Math.min(255, Math.round((ringed[i + 2] * 255) / a));
            img.data[o + 3] = a;
          }
        }
        c2d.putImageData(img, x0 - tx, y0 - ty);
        tile.sprite.texture.source.update();
      }
    }
  };

  // Once per frame while drawing (was every 90 ms over the whole stroke)
  const scheduleOutlinePreview = () => {
    const tool = ctx.currentToolRef.current;
    if (!outlineRef.current.enabled || (tool !== 'brush' && tool !== 'pencil') || ctx.brushPropsRef.current?.isEraser || outlineRafRef.current !== null) return;
    outlineRafRef.current = requestAnimationFrame(() => {
      outlineRafRef.current = null;
      drawOutlinePreview();
    });
  };

  /* ---------- Stroke ---------- */

  // While an outline is computed off the main thread the layer must not change: a stroke started
  // meanwhile is held (its events replay, in order, the moment the outline is written back)
  const heldRef = useRef<Array<() => void> | null>(null);
  const historyHoldRef = useRef<Array<() => void> | null>(null);
  const strokeWaitersRef = useRef<Array<() => void>>([]);
  const notifyStrokeSettled = () => {
    for (const resolve of strokeWaitersRef.current.splice(0)) resolve();
  };
  const hold = (fn: () => void) => {
    const held = historyHoldRef.current ?? heldRef.current;
    if (!held) return false;
    held.push(fn);
    return true;
  };
  // Commits whose tiles are still being compressed: their ops go out in stroke order
  const emitChainRef = useRef<Promise<void>>(Promise.resolve());
  const unsentRef = useRef(0);
  const afterSentRef = useRef<Array<() => void>>([]);
  /** Runs fn once every stroke so far is in the undo history and sent (undo / redo wait for this) */
  const whenCommitted = (fn: () => void) => {
    if (unsentRef.current === 0) fn();
    else afterSentRef.current.push(fn);
  };

  /** History replaces tiles and resets the baseline. Queue new pen events until that write is done. */
  const withHistory = async (action: () => Promise<void>) => {
    const pipeline = ctx.strokePipelineRef.current;
    const layerManager = ctx.layerManagerRef.current;
    const sameCanvas = () => ctx.strokePipelineRef.current === pipeline && ctx.layerManagerRef.current === layerManager;
    while (sameCanvas() && (pipeline?.getIsDrawing() || heldRef.current)) {
      await new Promise<void>(resolve => strokeWaitersRef.current.push(resolve));
    }
    if (!sameCanvas()) return;
    const held: Array<() => void> = [];
    historyHoldRef.current = held;
    const te = ctx.tileEngineRef.current;
    te?.setUrgentReads(true);
    try {
      await new Promise<void>(whenCommitted);
      if (sameCanvas()) await action();
    } finally {
      te?.setUrgentReads(false);
      if (historyHoldRef.current === held) {
        historyHoldRef.current = null;
        if (sameCanvas()) for (const run of held) run();
      }
    }
  };

  const start = (e: PointerEvent, local: Point, layer: LayerModel, eraserProps?: BrushProperties) => {
    ctx.strokePipelineRef.current?.finishPendingRelease();
    if (hold(() => start(e, local, layer, eraserProps))) return;
    const pipeline = ctx.strokePipelineRef.current;
    if (!pipeline || pipeline.getIsDrawing()) return;
    // The ping-pong copy is the exact pre-stroke state: undo "before" tiles come from it
    ctx.layerManagerRef.current?.syncPingPong(layer.id);
    clearOutlinePreview();
    outlinePickRef.current = null; // drawing again: an armed outline pick was abandoned
    strokeTouchedTileCoordsRef.current.clear();
    const te = ctx.tileEngineRef.current;
    if (te) {
      const rad = Math.max(16, (eraserProps?.size ?? ctx.brushProps.size) * 2);
      for (const c of te.getDirtyTilesForPoints([{ x: local.x, y: local.y, radius: rad }], rad)) {
        strokeTouchedTileCoordsRef.current.add(`${c.col}_${c.row}`);
      }
    }
    const captureInk = Boolean(ctx.canvas && !OfflineSessionStore.isOfflineCanvas(ctx.canvas.id) &&
      (layer.isPublic || layer.aclMode !== 'owner_only') && !layer.alphaLocked && !outlineRef.current.enabled);
    pipeline.handlePointerDown(e, eraserProps, captureInk);
  };

  /** Collects the tiles under the pointer while a button is down (cheap: no GPU read) */
  const trackTiles = (e: { buttons: number; pointerType: string }, local: Point, size = ctx.brushProps.size) => {
    const te = ctx.tileEngineRef.current;
    if (!(hasDrawingContact(e) || e.pointerType === 'touch') || !ctx.activeLayer || !te) return;
    if (ctx.strokePipelineRef.current?.getIsAdjustingQuickShape()) return;
    const radius = size * 1.5;
    const { canvas, wrapAroundRef } = ctx;
    const points = [{ x: local.x, y: local.y, radius }];
    const tiles = wrapAroundRef.current && canvas
      ? getWrappedDirtyTilesForPoints(points, radius, canvas.width, canvas.height)
      : te.getDirtyTilesForPoints(points, radius);
    for (const c of tiles) {
      strokeTouchedTileCoordsRef.current.add(`${c.col}_${c.row}`);
    }
  };

  const move = (e: PointerEvent) => {
    if (hold(() => move(e))) return;
    const pipeline = ctx.strokePipelineRef.current;
    const wasDrawing = pipeline?.getIsDrawing();
    pipeline?.handlePointerMove(e);
    if (wasDrawing && !pipeline?.getIsDrawing()) notifyStrokeSettled();
    scheduleOutlinePreview();
  };

  const finish = (e: PointerEvent) => {
    if (hold(() => finish(e))) return;
    ctx.strokePipelineRef.current?.handlePointerUp(e);
    notifyStrokeSettled();
  };

  const interrupt = (pointerId: number) => {
    if (hold(() => interrupt(pointerId))) return;
    ctx.strokePipelineRef.current?.finishInterruptedStroke(pointerId);
    notifyStrokeSettled();
  };

  /**
   * A two-finger gesture took over: drop the stroke and its preview. Returns true if a stroke was
   * really being drawn (the caller reverts the layer); a held stroke never touched the layer, and
   * reverting then would wipe the previous stroke whose outline is still being computed.
   */
  const cancel = () => {
    const held = historyHoldRef.current ?? heldRef.current;
    if (held) {
      held.length = 0;
      return false;
    }
    const drawing = Boolean(ctx.strokePipelineRef.current?.getIsDrawing());
    ctx.strokePipelineRef.current?.cancelStroke();
    clearOutlinePreview();
    notifyStrokeSettled();
    return drawing;
  };

  /** StrokePipeline's onCommitStroke: one op (and undo step) with every tile the stroke touched */
  const commitStroke = (strokeData: StrokeCommitData, inkRead?: Promise<TileData[]>) => {
    // The ring preview stays up until the real outline is written: clearing it now made the ring
    // vanish for the frames the read-back and the worker take, then pop back (閃一下)
    freezeOutlinePreview();
    const ink = inkRead?.catch(error => {
      console.warn('[useBrushTool] Failed to read stroke ink:', error);
      return undefined;
    });
    const { canvas, tileEngineRef, layerManagerRef, activeLayerRef, userRef, brushPropsRef, currentToolRef, scopedUndoRef } = ctx;
    const currentLayer = activeLayerRef.current;
    const currentUser = userRef.current;
    const currentProps = brushPropsRef.current || ctx.brushProps;
    const te = tileEngineRef.current;
    const lm = layerManagerRef.current;
    if (!currentLayer || !canvas || !te || !lm) {
      notifyStrokeSettled();
      return clearOutlinePreview();
    }
    const layerItem = lm.getLayerItem(currentLayer.id);
    if (!layerItem) {
      notifyStrokeSettled();
      return clearOutlinePreview();
    }

    // Tiles touched by the full stroke, plus those collected during the moves
    const pts = strokeData.allPoints ?? strokeData.samplePoints;
    const dirtyCoordsMap = new Map<string, { col: number; row: number }>();
    // Tiles along the stroke; scatter throws dabs up to 2 × scatter × size off the path
    const reach = (strokeData.size || currentProps.size) * (1 + 2 * Math.max(0, currentProps.scatter || 0)) +
      (strokeData.quickShapeKind ? 3 : 0);
    const tilesForPoints = (points: StrokeCommitData['samplePoints'], radius: number) => {
      if (strokeData.wrapAround) {
        return getWrappedDirtyTilesForPoints(points, radius, canvas.width, canvas.height);
      }
      if (!strokeData.quickShapeKind) return te.getDirtyTilesForPoints(points, radius);
      const tiles = new Map<string, { col: number; row: number }>();
      // QuickShape reports stamped dabs, interleaved with any mirrored copies.
      for (const point of points) {
        for (const c of te.getDirtyTilesForPoints([point], radius)) tiles.set(`${c.col}_${c.row}`, c);
      }
      return tiles.values();
    };
    for (const c of tilesForPoints(pts, reach)) dirtyCoordsMap.set(`${c.col}_${c.row}`, c);
    if (strokeData.quickShapeKind) {
      for (const c of tilesForPoints(strokeData.originalPoints ?? [], reach)) dirtyCoordsMap.set(`${c.col}_${c.row}`, c);
      for (const c of strokeData.originalTiles ?? []) dirtyCoordsMap.set(`${c.col}_${c.row}`, c);
    }
    for (const key of strokeTouchedTileCoordsRef.current) {
      if (!dirtyCoordsMap.has(key)) {
        const [col, row] = key.split('_').map(Number);
        dirtyCoordsMap.set(key, { col, row });
      }
    }
    strokeTouchedTileCoordsRef.current.clear();
    const layerId = currentLayer.id;
    const stillHere = () => ctx.tileEngineRef.current === te && ctx.layerManagerRef.current === lm && lm.getLayerItem(layerId) === layerItem;

    /** Reads before / after (GPU, here), makes this the next stroke's baseline, compresses off the thread, sends in order */
    const takeTiles = () => {
      const sparseTiles = lm.editedSparseTiles(layerId);
      if (strokeData.quickShapeKind) {
        for (const c of sparseTiles ?? []) dirtyCoordsMap.set(`${c.col}_${c.row}`, c);
      }
      const dirtyCoords = strokeData.quickShapeKind || !sparseTiles
        ? Array.from(dirtyCoordsMap.values()) : sparseTiles;
      // Queue reads for the current pixels and any uncached pre-stroke tiles before freeing backups.
      const before = readBeforeTilesAsync(lm, layerId, dirtyCoords, 'before');
      const afterVersion = lm.getLayerVersion(layerId);
      const after = lm.readTilesAsync(layerId, dirtyCoords, 'after').then(compressTiles);
      lm.syncPingPong(layerId); // queued after the reads: the next stroke's baseline (frees the backups)
      const compressed = Promise.all([before, after, ink?.then(async (tiles) => {
        if (!tiles) return undefined;
        const packed = tiles.filter((tile) => tile.compression !== 'raw');
        return packed.concat(await compressTiles(tiles.filter((tile) => tile.compression === 'raw')));
      })]);
      unsentRef.current++;
      notifyStrokeSettled();
      emitChainRef.current = emitChainRef.current
        .then(() => compressed)
        .then(([beforeTiles, afterTiles, inkTiles]) => {
          if (!stillHere()) return;
          lm.recordCleanTiles(layerId, afterTiles, afterVersion);
          const opType = strokeData.isEraser ? 'ERASE' : 'STROKE';
          const undoOp: ScopedUndoOp = {
            opId: `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId: currentUser?.id || 'guest',
            layerId,
            opType,
            beforeTiles,
            afterTiles,
            inkTiles,
            timestamp: Date.now(),
          };
          scopedUndoRef.current.push(undoOp);
          ctx.updateUndoRedoState();
          // The ping-pong copy was synced when the tiles were read (a newer stroke may be under way now)
          const { originalPoints: _originalPoints, originalTiles: _originalTiles, wrapAround: _wrapAround, ...roomPayload } = strokeData;
          const { allPoints: _allPoints, quickShapePreviewId: _previewId, ...offlinePayload } = roomPayload;
          const commitPayload = OfflineSessionStore.isOfflineCanvas(canvas.id) ? offlinePayload : roomPayload;
          ctx.commitOp(layerId, opType, { ...commitPayload, tiles: afterTiles, inkTiles }, true);
          if (!strokeData.isEraser) recordUsedColor(strokeData.color || currentProps.color);
        })
        .catch((err) => console.warn('[useBrushTool] Stroke commit failed:', err))
        .finally(() => {
          unsentRef.current--;
          if (unsentRef.current === 0) for (const fn of afterSentRef.current.splice(0)) fn();
        });
    };

    // Outline brush: ring the stroke colour's region before the tiles are taken, so the outline
    // is part of this op (synced, undone together with the stroke)
    const outline = { ...outlineRef.current };
    const tool = currentToolRef.current;
    if (!(outline.enabled && !strokeData.isEraser && pts.length > 0 && (tool === 'brush' || tool === 'pencil'))) {
      clearOutlinePreview();
      takeTiles();
      return;
    }
    // Tile by tile along the stroke, each read with the outline's reach around it: the same rings
    // as computing the stroke's whole box, without reading a 9000×7000 box for a long diagonal.
    // All tiles are read before any is written, so one tile's new ring never feeds the next.
    const ts = DEFAULT_TILE_SIZE;
    const margin = outline.width + 2;
    const places: Array<{ c: { col: number; row: number }; x: number; y: number; w: number; h: number }> = [];
    const rects: Array<{ x: number; y: number; w: number; h: number; ox: number; oy: number }> = [];
    for (const c of tilesForPoints(pts, reach + margin)) {
      const x0 = c.col * ts;
      const y0 = c.row * ts;
      const w = Math.min(canvas.width, x0 + ts) - x0;
      const h = Math.min(canvas.height, y0 + ts) - y0;
      const bx = strokeData.wrapAround ? x0 - margin : Math.max(0, x0 - margin);
      const by = strokeData.wrapAround ? y0 - margin : Math.max(0, y0 - margin);
      const right = strokeData.wrapAround ? x0 + w + margin : Math.min(canvas.width, x0 + w + margin);
      const bottom = strokeData.wrapAround ? y0 + h + margin : Math.min(canvas.height, y0 + h + margin);
      places.push({ c, x: x0, y: y0, w, h });
      rects.push({ x: bx, y: by, w: right - bx, h: bottom - by, ox: x0 - bx, oy: y0 - by });
    }
    heldRef.current = heldRef.current ?? [];
    const release = () => {
      const held = heldRef.current;
      heldRef.current = null;
      held?.forEach((fn) => fn());
      notifyStrokeSettled();
    };
    readOutlineRegions(lm, layerId, rects, strokeData.wrapAround ? canvas : undefined)
      .then((pxs) => outlineRings(pxs.map((px, i): OutlineRegion => ({ px, bw: rects[i].w, bh: rects[i].h, ox: rects[i].ox, oy: rects[i].oy, w: places[i].w, h: places[i].h })), currentProps.color, outline))
      .then((rings) => {
        if (!stillHere()) return;
        rings.forEach((px, i) => {
          if (!px) return;
          const p = places[i];
          lm.writeRegion(layerId, p.x, p.y, p.w, p.h, px);
          dirtyCoordsMap.set(`${p.c.col}_${p.c.row}`, p.c);
        });
        clearOutlinePreview(); // same task as the write: the real ring replaces the preview in one frame
        takeTiles();
      })
      .catch((err) => {
        console.warn('[useBrushTool] Outline failed, committing the stroke without it:', err);
        clearOutlinePreview();
        if (stillHere()) takeTiles();
      })
      .finally(release);
  };

  // Eyedropper for the outline colour: picks once, then goes back to the tool it came from
  const outlinePickRef = useRef<{ back: ToolType; select: (t: ToolType) => void } | null>(null);
  const armOutlinePick = (back: ToolType, select: (t: ToolType) => void) => {
    outlinePickRef.current = { back, select };
    select('eyedropper');
  };

  /** Sample the visible composite canvas at a point without changing tool state; returns #RRGGBB or null if transparent. */
  const sampleColorAt = async (local: Point): Promise<string | null> => {
    const { canvas, layerManagerRef } = ctx;
    const lm = layerManagerRef.current;
    if (!canvas || !lm) return null;
    const ix = Math.max(0, Math.min(canvas.width - 1, Math.round(local.x)));
    const iy = Math.max(0, Math.min(canvas.height - 1, Math.round(local.y)));
    try {
      const [px] = await lm.readCompositeRegionsAsync([{ x: ix, y: iy, w: 1, h: 1 }], true);
      const [pr, pg, pb, a] = px;
      if (!a) return null;
      return '#' + [pr, pg, pb].map((c) => Math.min(255, Math.round((c * 255) / a)).toString(16).padStart(2, '0')).join('').toUpperCase();
    } catch {
      return null;
    }
  };

  /** Sample the visible canvas, including layers underneath an empty active layer. */
  const pickColor = (local: Point, layer: LayerModel) => {
    const { canvas, layerManagerRef } = ctx;
    const lm = layerManagerRef.current;
    if (!canvas || !lm?.getLayerItem(layer.id)) return;
    const ix = Math.max(0, Math.min(canvas.width - 1, Math.round(local.x)));
    const iy = Math.max(0, Math.min(canvas.height - 1, Math.round(local.y)));
    void lm.readCompositeRegionsAsync([{ x: ix, y: iy, w: 1, h: 1 }], true).then(([px]) => { if (px) applyPick(px); }).catch(() => {
      // unreadable texture (context lost): keep the colour
    });
  };
  const applyPick = (px: Uint8Array) => {
    const [pr, pg, pb, a] = px;
    if (!a) return; // transparent: keep the current colour
    const hex = '#' + [pr, pg, pb].map((c) => Math.min(255, Math.round((c * 255) / a)).toString(16).padStart(2, '0')).join('').toUpperCase();
    const pick = outlinePickRef.current;
    if (pick) {
      outlinePickRef.current = null;
      updateOutlineBrush({ color: hex });
      pick.select(pick.back);
      return;
    }
    ctx.setBrushProps((prev) => ({ ...prev, color: hex, isEraser: false }));
    recordUsedColor(hex);
  };

  return {
    outlineBrush,
    updateOutlineBrush,
    armOutlinePick,
    start,
    trackTiles,
    move,
    refreshOutlinePreview: () => {
      if (!outlineRef.current.enabled) return;
      clearOutlinePreview();
      scheduleOutlinePreview();
    },
    interrupt,
    finish,
    cancel,
    commitStroke,
    whenCommitted,
    withHistory,
    /** A stroke is waiting for the previous stroke's outline */
    isHolding: () => heldRef.current !== null || historyHoldRef.current !== null,
    pickColor,
    sampleColorAt,
    /** Canvas switch / engine rebuild */
    reset: () => {
      strokeTouchedTileCoordsRef.current.clear();
      clearOutlinePreview();
      heldRef.current = null; // commits still in flight see the new engine and drop themselves
      historyHoldRef.current = null;
      notifyStrokeSettled();
    },
  };
}

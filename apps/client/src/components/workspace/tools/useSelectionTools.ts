import { useRef, useState } from 'react';
import { hexToRgb, rasterizeLassoMask, type LayerModel, type SelectionSnapshot, type ToolType } from '@atelier/shared';
import { useI18n } from '../../../context/I18nContext';
import type { SelectionMode } from '../ToolOptionsBar';
import type { Point, ToolContext } from './toolContext';
import { commitInOrder, diffTilesAsync } from './asyncTiles';

type ModifierKeys = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean };

function snapshotsEqual(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (
    a.activePixelCount !== b.activePixelCount ||
    a.bounds.minX !== b.bounds.minX ||
    a.bounds.minY !== b.bounds.minY ||
    a.bounds.maxX !== b.bounds.maxX ||
    a.bounds.maxY !== b.bounds.maxY ||
    a.data.length !== b.data.length
  ) {
    return false;
  }
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Selection gestures and commands (grow, clear, to layer mask). */
export function useSelectionTools(ctx: ToolContext) {
  const { t } = useI18n();
  const { canvas, layerManagerRef, tileEngineRef, selectionEngineRef, brushRendererRef } = ctx;
  const [wandTolerance, setWandTolerance] = useState<number>(32);
  const [wandContiguous, setWandContiguous] = useState<boolean>(true);
  const [hasSelectionState, setHasSelectionState] = useState<boolean>(false);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('replace');
  const [selectionAntialias, setSelectionAntialias] = useState(true);
  const [selectionFeather, setSelectionFeatherState] = useState(0);
  const [polygonPointCount, setPolygonPointCount] = useState(0);
  const [quickMaskActive, setQuickMaskActiveState] = useState(false);
  const quickMaskActiveRef = useRef(false);
  const setSelectionFeather = (radius: number) => setSelectionFeatherState(
    Number.isFinite(radius) ? Math.max(0, Math.min(64, Math.round(radius))) : 0,
  );
  const selectionModeFor = (e: ModifierKeys, options?: { isMarquee?: boolean }): SelectionMode => {
    if (e.ctrlKey || e.metaKey) return 'subtract';
    if (options?.isMarquee) {
      if (selectionEngineRef.current?.hasSelection()) {
        if (e.altKey) return 'subtract';
        if (e.shiftKey) return 'add';
      }
      return selectionMode;
    }
    if (e.shiftKey) return 'add';
    return e.altKey ? 'subtract' : selectionMode;
  };
  const createOptions = { antialias: selectionAntialias, featherRadius: selectionFeather };
  const lassoModeRef = useRef<SelectionMode>('replace');
  const marqueeModeRef = useRef<SelectionMode>('replace');
  const polygonModeRef = useRef<SelectionMode>('replace');
  const polygonLastClickRef = useRef<{ point: Point; time: number } | null>(null);

  /** Hands the changed selection to the brush (it paints only inside) and to the toolbars */
  const syncSelection = () => {
    const engine = selectionEngineRef.current;
    if (!engine) return;
    if (quickMaskActiveRef.current) {
      brushRendererRef.current?.setSelectionMask(null, null);
    } else {
      brushRendererRef.current?.setSelectionMask(engine.getMaskArray(), engine.getMaskGraphic());
    }
    setHasSelectionState(engine.hasSelection());
    setPolygonPointCount(engine.getPolygonPointCount());
  };

  /** 切換快速遮色片 (Quick Mask) 紅膜塗抹模式，關閉時立即將紅膜轉回精準選區 */
  const toggleQuickMask = (force?: boolean) => {
    const engine = selectionEngineRef.current;
    const next = force !== undefined ? force : !quickMaskActiveRef.current;
    if (next === quickMaskActiveRef.current) return;
    quickMaskActiveRef.current = next;
    setQuickMaskActiveState(next);
    engine?.setQuickMaskMode(next);
    syncSelection();
  };

  const isQuickMaskActive = () => quickMaskActiveRef.current;

  const startQuickMaskStroke = (local: Point, isEraser: boolean) => {
    const engine = selectionEngineRef.current;
    if (!engine || !quickMaskActiveRef.current) return false;
    engine.startQuickMaskBrush(
      local.x,
      local.y,
      Math.max(1, ctx.brushProps.size / 2),
      !isEraser,
      ctx.brushProps.hardness ?? 0.85,
      ctx.brushProps.opacity ?? 1,
    );
    return true;
  };

  const moveQuickMaskStroke = (local: Point) => {
    const engine = selectionEngineRef.current;
    if (!engine?.isQuickMaskBrushing()) return false;
    engine.addQuickMaskBrushPoint(local.x, local.y);
    return true;
  };

  const finishQuickMaskStroke = () => {
    const engine = selectionEngineRef.current;
    if (!engine?.isQuickMaskBrushing()) return false;
    const before = engine.finishQuickMaskBrush();
    syncSelection();
    pushSelectionUndo(before, '快速遮色片塗抹');
    return true;
  };

  const applyColorRangeMask = (mask: Uint8Array, mode: SelectionMode = 'replace') => {
    const engine = selectionEngineRef.current;
    if (!engine) return;
    const before = engine.exportSnapshot();
    engine.applyMask(mask, mode);
    syncSelection();
    pushSelectionUndo(before, '色域選取');
  };

  const pushSelectionUndo = (before: SelectionSnapshot | null, desc: string) => {
    const engine = selectionEngineRef.current;
    if (!engine) return;
    const after = engine.exportSnapshot();
    if (snapshotsEqual(before, after)) return;
    const layerId = ctx.activeLayerRef.current?.id || '__selection__';
    ctx.scopedUndoRef.current.push({
      opId: `op_sel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId: ctx.userRef.current?.id || ctx.user?.id || 'guest',
      layerId,
      opType: 'SELECTION',
      beforeTiles: [],
      afterTiles: [],
      selectionBefore: before,
      selectionAfter: after,
      timestamp: Date.now(),
      desc,
    });
    ctx.updateUndoRedoState();
  };

  /** Runs a synchronous selection mutation and pushes a SELECTION undo op if the mask changed */
  const withSelectionUndo = (desc: string, fn: () => void) => {
    const engine = selectionEngineRef.current;
    if (!engine) return;
    const before = engine.exportSnapshot();
    fn();
    syncSelection();
    pushSelectionUndo(before, desc);
  };

  /** 反選: the unselected part becomes the selection (nothing selected → everything) */
  const invertSelection = () => withSelectionUndo('反轉選區', () => selectionEngineRef.current?.invertSelection());

  // Copied pixels (straight alpha, the selection's feathering applied) and where they came from.
  // Copy also puts a PNG on the system clipboard, so other apps can paste it.
  const clipboardRef = useRef<{ source: HTMLCanvasElement; x: number; y: number } | null>(null);
  const [hasClipboard, setHasClipboard] = useState(false);

  /** The selected part of the active layer; null (with a notice) when there is nothing to take */
  const selectedRegion = () => {
    const engine = selectionEngineRef.current;
    const te = tileEngineRef.current;
    const layer = ctx.activeLayerRef.current;
    if (ctx.rejectAdjustmentPixels(layer)) return null;
    const item = layer ? layerManagerRef.current?.getLayerItem(layer.id) : null;
    const mask = engine?.getMaskData();
    if (!engine?.hasSelection() || !mask || !te || !layer || !item || !canvas) {
      ctx.warn('請先用套索或魔術棒選取範圍。');
      return null;
    }
    const b = mask.bounds;
    const x = Math.max(0, b.minX);
    const y = Math.max(0, b.minY);
    const w = Math.min(canvas.width, b.maxX + 1) - x;
    const h = Math.min(canvas.height, b.maxY + 1) - y;
    if (w <= 0 || h <= 0) return null;
    return { layer, item, te, mask: mask.data, x, y, w, h };
  };

  /** 複製: the selected pixels of the active layer go to the clipboard */
  const copySelection = async (): Promise<boolean> => {
    const r = selectedRegion();
    const lm = layerManagerRef.current;
    if (!r || !canvas || !lm) return false;
    // Read without stalling the page (a sparse layer stays sparse); canvas ImageData is straight alpha
    const [pm] = await lm.readAsync(r.layer.id, [{ x: r.x, y: r.y, w: r.w, h: r.h }]);
    const source = document.createElement('canvas');
    source.width = r.w;
    source.height = r.h;
    const c2d = source.getContext('2d');
    if (!c2d) return false;
    const img = c2d.createImageData(r.w, r.h);
    for (let i = 0; i < pm.length; i += 4) {
      const a = pm[i + 3];
      if (!a) continue;
      const k = 255 / a;
      img.data[i] = pm[i] * k;
      img.data[i + 1] = pm[i + 1] * k;
      img.data[i + 2] = pm[i + 2] * k;
      img.data[i + 3] = a;
    }
    let any = false;
    for (let row = 0; row < r.h; row++) {
      for (let col = 0; col < r.w; col++) {
        const i = (row * r.w + col) * 4 + 3;
        img.data[i] = Math.round(img.data[i] * (r.mask[(r.y + row) * canvas.width + (r.x + col)] / 255));
        if (img.data[i]) any = true;
      }
    }
    if (!any) {
      ctx.warn('選取範圍內這個圖層沒有內容。');
      return false;
    }
    c2d.putImageData(img, 0, 0);
    clipboardRef.current = { source, x: r.x, y: r.y };
    setHasClipboard(true);
    // Best effort: needs a secure context (localhost / https) and clipboard permission
    try {
      source.toBlob((blob) => {
        if (blob && typeof ClipboardItem !== 'undefined') {
          void navigator.clipboard?.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
        }
      }, 'image/png');
    } catch {
      // this tab's clipboard still works
    }
    return true;
  };

  /** 複製全部 (Copy Merged): copies the flattened visible canvas (clipped to selection if active) */
  const copyMerged = async (): Promise<boolean> => {
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    if (!canvas || !lm || !te) return false;
    const sel = selectedRegion();
    const x = sel ? sel.x : 0;
    const y = sel ? sel.y : 0;
    const w = sel ? sel.w : canvas.width;
    const h = sel ? sel.h : canvas.height;
    if (w <= 0 || h <= 0) return false;
    const [pm] = await te.readRegionsAsync(lm.getCompositeTexture(true), [{ x, y, w, h }]);
    const source = document.createElement('canvas');
    source.width = w;
    source.height = h;
    const c2d = source.getContext('2d');
    if (!c2d) return false;
    const img = c2d.createImageData(w, h);
    for (let i = 0; i < pm.length; i += 4) {
      const a = pm[i + 3];
      if (!a) continue;
      const k = 255 / a;
      img.data[i] = pm[i] * k;
      img.data[i + 1] = pm[i + 1] * k;
      img.data[i + 2] = pm[i + 2] * k;
      img.data[i + 3] = a;
    }
    if (sel) {
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * 4 + 3;
          img.data[i] = Math.round(img.data[i] * (sel.mask[(y + row) * canvas.width + (x + col)] / 255));
        }
      }
    }
    c2d.putImageData(img, 0, 0);
    clipboardRef.current = { source, x, y };
    setHasClipboard(true);
    try {
      source.toBlob((blob) => {
        if (blob && typeof ClipboardItem !== 'undefined') {
          void navigator.clipboard?.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
        }
      }, 'image/png');
    } catch {
      // internal clipboard still works
    }
    ctx.warn('📋 已複製合併畫面', 1800);
    return true;
  };

  /** 刪除: clears the selected pixels of the active layer (feathered edges partly) as one op and undo step */
  const deleteSelection = (desc = '刪除選取內容', override?: ReturnType<typeof selectedRegion>) => {
    const r = override ?? selectedRegion();
    if (!r || !canvas) return;
    if (override && ctx.rejectAdjustmentPixels(r.layer)) return;
    if (!ctx.canEditPixels(r.layer)) {
      ctx.warn('請先選取自己可編輯、未鎖定的圖層。');
      return;
    }
    const coords = r.te.getDirtyTilesForBounds(r.x, r.y, r.x + r.w, r.y + r.h);
    const lm = layerManagerRef.current;
    if (!lm) return;
    const layerId = r.layer.id;
    const cw = canvas.width;
    commitInOrder(() => lm.readAsync(layerId, [{ x: r.x, y: r.y, w: r.w, h: r.h }]).then(([px]) => {
    if (layerManagerRef.current !== lm) return null;
    for (let row = 0; row < r.h; row++) {
      for (let col = 0; col < r.w; col++) {
        const keep = 1 - r.mask[(r.y + row) * cw + (r.x + col)] / 255;
        if (keep === 1) continue;
        const i = (row * r.w + col) * 4;
        // Premultiplied: scaling every channel keeps the colour and fades the alpha
        for (let c = 0; c < 4; c++) px[i + c] = Math.round(px[i + c] * keep);
      }
    }
    const diff = diffTilesAsync(lm, layerId, coords, () => lm.writeRegion(layerId, r.x, r.y, r.w, r.h, px), 'before');
    lm.syncPingPong(layerId); // queued after the reads: the next edit's baseline
    return diff;
    }), (res) => {
      if (!res) return;
      ctx.scopedUndoRef.current.push({
        opId: `op_seldel_${Date.now()}`,
        userId: ctx.userRef.current?.id || 'guest',
        layerId,
        opType: 'STROKE',
        beforeTiles: res.beforeTiles,
        afterTiles: res.afterTiles,
        timestamp: Date.now(),
        desc,
      });
      ctx.updateUndoRedoState();
      ctx.commitOp(layerId, 'STROKE', { tool: 'selection_delete', tiles: res.afterTiles }, true);
    });
  };

  /** 套索擦除: what the eraser's lasso encloses is cleared from the active layer (the selection is untouched) */
  const [lassoErase, setLassoErase] = useState(false);
  const eraseLasso = () => {
    const engine = selectionEngineRef.current;
    const te = tileEngineRef.current;
    const layer = ctx.activeLayerRef.current;
    const item = layer ? layerManagerRef.current?.getLayerItem(layer.id) : null;
    if (!engine || !te || !layer || !item || !canvas) return;
    const points = engine.getCurrentPoints();
    engine.clearDraft();
    if (points.length < 3) return;
    const m = rasterizeLassoMask(points, canvas.width, canvas.height);
    if (!m.activePixelCount) return;
    const b = m.bounds;
    deleteSelection('套索擦除', {
      layer, item, te, mask: m.data,
      x: b.minX, y: b.minY, w: Math.min(canvas.width, b.maxX + 1) - b.minX, h: Math.min(canvas.height, b.maxY + 1) - b.minY,
    });
  };

  /** 剪下: copy, then clear the selected pixels */
  const cutSelection = () => {
    const r = selectedRegion();
    if (!r) return;
    void copySelection().then((ok) => { if (ok) deleteSelection('剪下', r); });
  };

  const handleClearSelection = () => {
    withSelectionUndo('取消選取', () => selectionEngineRef.current?.clearSelection());
  };

  /** 羽化 */
  const featherSelection = (px: number) => {
    if (!selectionEngineRef.current?.hasSelection()) {
      ctx.warn('請先建立選取範圍。');
      return;
    }
    withSelectionUndo('羽化選區', () => selectionEngineRef.current!.featherSelection(px));
  };

  /** The active layer's pixels (premultiplied), or null with a notice */
  const activePixels = async (layer: LayerModel | null = ctx.activeLayerRef.current): Promise<Uint8Array | null> => {
    const lm = layerManagerRef.current;
    if (!layer || !lm?.getLayerItem(layer.id) || !canvas) return null;
    return (await lm.readAsync(layer.id, [{ x: 0, y: 0, w: canvas.width, h: canvas.height }]))[0];
  };

  /** 依顏色範圍選取: every pixel of the active layer close to the main colour (容差 = the wand's) */
  const selectColorRange = async (e: ModifierKeys = { shiftKey: false, ctrlKey: false, metaKey: false }) => {
    const engine = selectionEngineRef.current;
    if (!engine) return;
    const before = engine.exportSnapshot();
    const px = await activePixels();
    if (!px) return;
    const target = hexToRgb(ctx.brushProps.color);
    const tol = Math.max(1, wandTolerance);
    const out = new Uint8Array(px.length / 4);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const a = px[i + 3];
      if (a < 8) continue;
      const k = 255 / a; // un-premultiply before comparing colours
      const d = Math.max(Math.abs(px[i] * k - target.r), Math.abs(px[i + 1] * k - target.g), Math.abs(px[i + 2] * k - target.b));
      if (d <= tol) out[j] = a;
    }
    engine.applyMask(out, selectionModeFor(e));
    syncSelection();
    pushSelectionUndo(before, '色彩範圍選取');
    if (!engine.hasSelection()) ctx.warn('圖層上沒有接近目前主色的顏色（可在魔術棒調整容差）。');
  };

  /** Ctrl+click on a layer thumbnail: its opaque pixels (alpha as coverage) become the selection */
  const loadLayerSelection = async (layer: LayerModel, e: ModifierKeys = { shiftKey: false, ctrlKey: false, metaKey: false }) => {
    const engine = selectionEngineRef.current;
    if (!engine) return;
    const before = engine.exportSnapshot();
    const px = await activePixels(layer);
    if (!px) return;
    const out = new Uint8Array(px.length / 4);
    for (let j = 0; j < out.length; j++) out[j] = px[j * 4 + 3];
    // Ctrl is the gesture itself here, so only Shift changes the mode
    engine.applyMask(out, e.shiftKey ? 'add' : 'replace');
    syncSelection();
    pushSelectionUndo(before, '載入圖層選區');
    if (!engine.hasSelection()) ctx.warn(`「${layer.name}」沒有內容可以載入為選區。`);
  };

  // 選取筆 / 選取橡皮擦: painting adds to / removes from the selection, merged on release
  const startSelectBrush = (local: Point, adds: boolean) =>
    selectionEngineRef.current?.startBrush(local.x, local.y, Math.max(1, ctx.brushProps.size / 2), adds);
  const moveSelectBrush = (local: Point) => {
    const engine = selectionEngineRef.current;
    if (!engine?.isBrushing()) return false;
    engine.addBrushPoint(local.x, local.y);
    return true;
  };
  const finishSelectBrush = () => {
    const engine = selectionEngineRef.current;
    if (!engine?.isBrushing()) return false;
    withSelectionUndo('選取筆刷', () => engine.finishBrush());
    return true;
  };

  // 貼上到新圖層 (a tool option): the paste lands on a new layer of its own
  const [pasteToNewLayer, setPasteToNewLayer] = useState(false);

  const growSelection = (px: number) => {
    withSelectionUndo(px > 0 ? '擴張選區' : '收縮選區', () => {
      if (px > 0) selectionEngineRef.current!.expandSelection(px);
      else selectionEngineRef.current!.contractSelection(-px);
    });
  };

  const selectWand = (e: ModifierKeys, local: Point, layer: LayerModel) => {
    const lm = layerManagerRef.current;
    const item = lm?.getLayerItem(layer.id);
    const tileEngine = tileEngineRef.current;
    const engine = selectionEngineRef.current;
    if (!lm || !engine || !item || !canvas || !tileEngine || local.x < 0 || local.y < 0 || local.x >= canvas.width || local.y >= canvas.height) return;
    const mode = selectionModeFor(e);
    const lx = Math.floor(local.x);
    const ly = Math.floor(local.y);
    const occupied = lm.occupiedTiles(layer.id);
    if (occupied !== null) {
      if (occupied.length === 0) {
        if (mode === 'replace') withSelectionUndo(t.tools.magicWand, () => engine.clearSelection());
        return;
      }
      if (wandContiguous && mode === 'replace') {
        const ts = tileEngine.tileSize;
        let minCol = occupied[0].col;
        let maxCol = occupied[0].col;
        let minRow = occupied[0].row;
        let maxRow = occupied[0].row;
        for (const c of occupied) {
          if (c.col < minCol) minCol = c.col;
          if (c.col > maxCol) maxCol = c.col;
          if (c.row < minRow) minRow = c.row;
          if (c.row > maxRow) maxRow = c.row;
        }
        const bx0 = minCol * ts;
        const by0 = minRow * ts;
        const bx1 = Math.min(canvas.width, (maxCol + 1) * ts);
        const by1 = Math.min(canvas.height, (maxRow + 1) * ts);
        if (lx < bx0 || lx >= bx1 || ly < by0 || ly >= by1) {
          withSelectionUndo('取消選取', () => engine.clearSelection());
          return;
        }
      }
    }
    void lm.readAsync(layer.id, [{ x: 0, y: 0, w: canvas.width, h: canvas.height }]).then(([pixels]) => {
      if (selectionEngineRef.current !== engine) return;
      withSelectionUndo(t.tools.magicWand, () => engine.selectWand(pixels, local.x, local.y, wandTolerance, wandContiguous, mode, createOptions));
    });
  };

  /** Starts a lasso outline: the lasso selection (with its add / subtract mode) or a fill tool's shape */
  const startLasso = (e: ModifierKeys, local: Point, tool: ToolType) => {
    lassoModeRef.current = tool === 'lasso' ? selectionModeFor(e) : 'replace';
    selectionEngineRef.current?.startLasso(local.x, local.y, tool === 'bucket');
  };

  const addLassoPoint = (local: Point) => selectionEngineRef.current?.addLassoPoint(local.x, local.y);

  /** The lasso stays the active tool (no jump to the brush) so Shift / Ctrl can keep adding or cutting */
  const finishLasso = () => {
    withSelectionUndo(t.tools.lasso, () => selectionEngineRef.current?.finishLasso(lassoModeRef.current, createOptions));
  };

  const updateMarquee = (e: { shiftKey: boolean; altKey: boolean }, local: Point) => {
    selectionEngineRef.current?.updateMarquee(local.x, local.y, { square: e.shiftKey, fromCenter: e.altKey });
  };

  const startMarquee = (kind: 'rect' | 'ellipse', e: ModifierKeys, local: Point) => {
    marqueeModeRef.current = selectionModeFor(e, { isMarquee: true });
    selectionEngineRef.current?.startMarquee(kind, local.x, local.y);
    updateMarquee({ shiftKey: e.shiftKey, altKey: Boolean(e.altKey) }, local);
  };

  const finishMarquee = () => {
    const engine = selectionEngineRef.current;
    if (engine?.isMarqueeActive()) {
      const label = ctx.currentToolRef.current === 'select_ellipse' ? t.tools.selectEllipse : t.tools.selectRect;
      withSelectionUndo(label, () => engine.finishMarquee(marqueeModeRef.current, createOptions));
    }
  };

  const cancelMarquee = () => selectionEngineRef.current?.cancelMarquee();

  const finishPolygonLasso = () => {
    withSelectionUndo(t.tools.selectPolygon, () => selectionEngineRef.current?.finishPolygonLasso(polygonModeRef.current, createOptions));
    polygonLastClickRef.current = null;
    setPolygonPointCount(0);
  };

  const cancelPolygonLasso = () => {
    selectionEngineRef.current?.cancelPolygonLasso();
    polygonLastClickRef.current = null;
    setPolygonPointCount(0);
  };

  const handlePolygonPointerDown = (e: ModifierKeys, local: Point, zoom: number) => {
    const engine = selectionEngineRef.current;
    if (!engine) return;
    const count = engine.getPolygonPointCount();
    const now = performance.now();
    if (count === 0) polygonModeRef.current = selectionModeFor(e);
    if (count >= 3) {
      const first = engine.getPolygonFirstPoint();
      const last = polygonLastClickRef.current;
      const nearStart = first && Math.hypot(local.x - first.x, local.y - first.y) < 9 / zoom;
      const doubleClick = last && now - last.time <= 350 && Math.hypot(local.x - last.point.x, local.y - last.point.y) < 6 / zoom;
      if (nearStart || doubleClick) {
        finishPolygonLasso();
        return;
      }
    }
    polygonLastClickRef.current = { point: local, time: now };
    setPolygonPointCount(engine.startOrAddPolygonPoint(local.x, local.y));
  };

  const updatePolygonHover = (local: Point) => selectionEngineRef.current?.updatePolygonHover(local.x, local.y);

  const undoPolygonPoint = () => {
    polygonLastClickRef.current = null;
    setPolygonPointCount(selectionEngineRef.current?.undoPolygonPoint() ?? 0);
  };

  const handleSelectionKey = (ev: KeyboardEvent): boolean => {
    const engine = selectionEngineRef.current;
    if (engine?.isPolygonLassoActive()) {
      switch (ev.key) {
        case 'Enter': finishPolygonLasso(); return true;
        case 'Backspace': undoPolygonPoint(); return true;
        case 'Escape': cancelPolygonLasso(); return true;
      }
    }
    if (ev.key === 'Escape' && engine?.isMarqueeActive()) {
      cancelMarquee();
      return true;
    }
    return false;
  };

  return {
    wandTolerance, setWandTolerance,
    wandContiguous, setWandContiguous,
    hasSelectionState, setHasSelectionState,
    selectionMode, setSelectionMode,
    selectionAntialias, setSelectionAntialias,
    selectionFeather, setSelectionFeather,
    polygonPointCount,
    handleClearSelection,
    invertSelection,
    copySelection,
    copyMerged,
    cutSelection,
    deleteSelection,
    clipboardRef,
    hasClipboard,
    growSelection,
    refreshSelection: syncSelection,
    featherSelection,
    selectColorRange,
    applyColorRangeMask,
    quickMaskActive,
    isQuickMaskActive,
    toggleQuickMask,
    startQuickMaskStroke,
    moveQuickMaskStroke,
    finishQuickMaskStroke,
    loadLayerSelection,
    startSelectBrush,
    moveSelectBrush,
    finishSelectBrush,
    lassoErase, setLassoErase, eraseLasso,
    pasteToNewLayer, setPasteToNewLayer,
    selectWand,
    startLasso,
    addLassoPoint,
    finishLasso,
    startMarquee, updateMarquee, finishMarquee, cancelMarquee,
    handlePolygonPointerDown, updatePolygonHover, undoPolygonPoint, finishPolygonLasso, cancelPolygonLasso,
    handleSelectionKey,
  };
}

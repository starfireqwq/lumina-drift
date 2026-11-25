import { useEffect, useRef } from 'react';
import type React from 'react';
import type { LayerModel, ToolType } from '@atelier/shared';
import { RulerManager } from '../../../engine/RulerManager';
import type { BrushProperties } from '../../../engine/BrushRenderer';
import type { OutlineSettings } from '../../../engine/colorOutline';
import { eraserStrokeProperties, loadBrushTool } from '../../../engine/brushToolSettings';
import { hasDrawingContact, isTabletEraser } from '../../../engine/tabletInput';
import {
  classifyMultiFingerTap,
  detectThreeFingerSwipeDown,
  getTouchGestureSettings,
  QuickPinchTracker,
  RAPID_UNDO_HOLD_DELAY_MS,
  RAPID_UNDO_REPEAT_MS,
} from '../../../engine/touchGestures';
import type { TouchEyedropperState } from '../../TouchEyedropperLoupe';
import type { Point, ToolContext } from './toolContext';
import { LIQUIFY_TOOLS, useLiquifyTool } from './useLiquifyTool';
import { SHAPE_TOOLS, useShapeTools } from './useShapeTools';
import type { useSelectionTools } from './useSelectionTools';
import type { useFillTools } from './useFillTools';
import type { useVectorTools } from './useVectorTools';
import type { useBrushTool } from './useBrushTool';
import type { useTransformTool } from './useTransformTool';

/** A two-finger twist turns the view only past this (~8°): a pinch never tilts it by accident */
const TOUCH_ROTATE_ENGAGE = (8 * Math.PI) / 180;
/** Within this (~5°) of a right angle the twisted view snaps to it */
const TOUCH_ROTATE_SNAP = (5 * Math.PI) / 180;

/** The same angle in (−π, π] */
function wrapAngle(a: number) {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
}

function snapRightAngle(a: number) {
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(a - q) < TOUCH_ROTATE_SNAP ? q : a;
}

interface TouchTwist {
  /** The two pointers it follows (another pair restarts it) */
  a: number;
  b: number;
  /** Angle of the line between the fingers at the last move */
  last: number;
  /** Turned so far before engaging */
  twist: number;
  engaged: boolean;
  /** The view's rotation without snapping */
  raw: number;
}

export interface CanvasTools {
  brush: ReturnType<typeof useBrushTool>;
  liquify: ReturnType<typeof useLiquifyTool>;
  shapes: ReturnType<typeof useShapeTools>;
  selection: ReturnType<typeof useSelectionTools>;
  fill: ReturnType<typeof useFillTools>;
  vector: ReturnType<typeof useVectorTools>;
  transform: ReturnType<typeof useTransformTool>;
}

interface PointerDeps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  lassoOutline?: OutlineSettings;
  /** While a filter dialog or a palette is open the canvas ignores the pointer */
  filterModalOpenRef: React.MutableRefObject<boolean>;
  radialMenuOpenRef: React.MutableRefObject<boolean>;
  desktopPopupOpenRef: React.MutableRefObject<boolean>;
  clipboardMenuOpenRef?: React.MutableRefObject<boolean>;
  /** While the canvas resize frame is open, prevent accidental strokes while still allowing pan/zoom */
  resizeModalOpenRef?: React.MutableRefObject<boolean>;
  updateBrushCursor: (clientX: number, clientY: number) => void;
  hideBrushCursor: () => void;
  setEraserHover: (active: boolean) => void;
  openRadialMenu: (pos: Point) => void;
  onOpenClipboardMenu?: (pos: Point) => void;
  onQuickFitCanvas?: () => void;
  onToggleFullscreen?: () => void;
  onTouchEyedropperChange?: (state: TouchEyedropperState | null) => void;
  onTouchEyedropperCommit?: (hex: string) => void;
  emitCursor: (x: number, y: number, isDrawing: boolean, brushSize?: number) => void;
  undo: () => void;
  redo: () => void;
  setCurrentTool: (tool: ToolType) => void;
  onSelectLayer?: (layerId: string) => void;
  onRequestCreateMyLayer?: () => void;
  /** Text tool click: edit the text layer under the point, or start a new one there */
  onTextTool?: (local: Point) => void;
  /** Optional v2.5 custom plugin tool pointer hook */
  pluginTool?: {
    isActive: () => boolean;
    onDown: (e: PointerEvent, local: Point) => boolean;
    onMove: (e: PointerEvent, local: Point) => boolean;
    onUp: (e: PointerEvent, local: Point | null, cancelled: boolean) => boolean;
    onCancel: () => void;
  };
}

/**
 * Pointer input on the canvas: picks the layer to work on (and checks it may be edited), routes
 * the press / drag / release to the active tool, and owns the navigation gestures (space / middle
 * button / hand pan, pinch zoom, two-finger undo, three-finger redo, long-press radial menu).
 */
export function useCanvasPointer(ctx: ToolContext, tools: CanvasTools, deps: PointerDeps) {
  const { brush, liquify, shapes, selection, fill, vector, transform } = tools;
  const {
    currentTool, activeLayer, layers, user, brushProps, canEditPixels,
    viewportRef, layerManagerRef, strokePipelineRef, selectionEngineRef, shapeGraphicRef, activeLayerRef, warn, requestRender,
  } = ctx;
  const {
    containerRef, filterModalOpenRef, radialMenuOpenRef, desktopPopupOpenRef, clipboardMenuOpenRef, resizeModalOpenRef, updateBrushCursor, hideBrushCursor,
    openRadialMenu, onOpenClipboardMenu, onQuickFitCanvas, onToggleFullscreen, onTouchEyedropperChange, onTouchEyedropperCommit,
    emitCursor, setEraserHover, undo, redo, setCurrentTool, onSelectLayer, onRequestCreateMyLayer, onTextTool, pluginTool, lassoOutline,
  } = deps;
  const isLassoErase = () => currentTool === 'eraser' && selection.lassoErase;
  const isTransformActive = transform.isTransformActive;
  const paintUnfilledPointerRef = useRef<number | null>(null);
  const marqueePointerRef = useRef<number | null>(null);
  const cancelMarquee = () => {
    marqueePointerRef.current = null;
    selection.cancelMarquee();
  };
  const cancelPaintUnfilled = () => {
    paintUnfilledPointerRef.current = null;
    fill.cancelPaintUnfilled();
  };

  const lastCursorEmitTimeRef = useRef<number>(0);
  // Mobile touch gestures: Procreate/Procraft multi-touch gestures, deferred one-finger bucket & long press
  const isMultiTouchGestureRef = useRef<boolean>(false);
  const touchSessionRef = useRef<{
    startTime: number;
    startPos: Point;
    /** Where each finger touched down: a tap is "no finger moved from its own start" */
    starts: Map<number, Point>;
    maxPointers: number;
    hasMoved: boolean;
    toolStarted: boolean;
    pendingBucketTarget: LayerModel | null;
    rapidTriggered: boolean;
    swipeTriggered: boolean;
    quickPinchTriggered: boolean;
  } | null>(null);
  // Long press opens the radial menu or live eyedropper loupe; the press is held back until it moves or lifts
  const radialLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTouchDownRef = useRef<PointerEvent | null>(null);
  const pendingSingleFingerPanRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const radialTouchRef = useRef<number | null>(null);
  const eyedropperTouchRef = useRef<{
    pointerId: number;
    previousColor: string;
    pickedColor: string;
    hasSampled: boolean;
    sampling: boolean;
    queued: Point | null;
  } | null>(null);
  // 2/3-finger hold rapid undo/redo timers
  const rapidHoldTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rapidRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Quick inward pinch-to-fit tracker
  const quickPinchRef = useRef<QuickPinchTracker | null>(null);
  // Latest undo/redo refs so rapid interval always invokes fresh callbacks
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  undoRef.current = undo;
  redoRef.current = redo;

  const clearRapidTimers = () => {
    if (rapidHoldTimerRef.current !== undefined) {
      clearTimeout(rapidHoldTimerRef.current);
      rapidHoldTimerRef.current = undefined;
    }
    if (rapidRepeatIntervalRef.current !== undefined) {
      clearInterval(rapidRepeatIntervalRef.current);
      rapidRepeatIntervalRef.current = undefined;
    }
  };

  const armRapidUndoRedo = (fingerCount: 2 | 3) => {
    clearRapidTimers();
    if (!getTouchGestureSettings().rapidUndoRedoHold || isTransformActive) return;
    const session = touchSessionRef.current;
    if (!session || session.hasMoved || session.swipeTriggered) return;
    rapidHoldTimerRef.current = setTimeout(() => {
      rapidHoldTimerRef.current = undefined;
      const cur = touchSessionRef.current;
      if (!cur || cur.hasMoved || cur.swipeTriggered || activePointersRef.current.size !== fingerCount) return;
      cur.rapidTriggered = true;
      quickPinchRef.current = null;
      const run = () => {
        if (fingerCount === 2) undoRef.current();
        else redoRef.current();
      };
      run();
      try { navigator.vibrate?.(18); } catch {}
      warn(fingerCount === 2 ? '↩️ 雙指長按：連續復原中' : '↪️ 三指長按：連續重做中', 1200);
      rapidRepeatIntervalRef.current = setInterval(() => {
        const s = touchSessionRef.current;
        if (!s || s.hasMoved || activePointersRef.current.size !== fingerCount) {
          clearRapidTimers();
          return;
        }
        run();
      }, RAPID_UNDO_REPEAT_MS);
    }, RAPID_UNDO_HOLD_DELAY_MS);
  };

  const sampleTouchEyedropper = (clientX: number, clientY: number) => {
    const ed = eyedropperTouchRef.current;
    if (!ed) return;
    onTouchEyedropperChange?.({
      active: true,
      clientX,
      clientY,
      pickedColor: ed.pickedColor,
      previousColor: ed.previousColor,
    });
    if (ed.sampling) {
      ed.queued = { x: clientX, y: clientY };
      return;
    }
    const local = viewportRef.current?.screenToCanvas(clientX, clientY);
    if (!local) return;
    ed.sampling = true;
    void brush.sampleColorAt(local).then((hex) => {
      const cur = eyedropperTouchRef.current;
      if (!cur || cur !== ed) return;
      cur.sampling = false;
      if (hex) {
        cur.pickedColor = hex;
        cur.hasSampled = true;
        onTouchEyedropperChange?.({
          active: true,
          clientX: cur.queued?.x ?? clientX,
          clientY: cur.queued?.y ?? clientY,
          pickedColor: cur.pickedColor,
          previousColor: cur.previousColor,
        });
      }
      if (cur.queued) {
        const next = cur.queued;
        cur.queued = null;
        sampleTouchEyedropper(next.x, next.y);
      }
    }).catch(() => {
      if (eyedropperTouchRef.current === ed) ed.sampling = false;
    });
  };
  // Panning (space / middle button / hand tool) and pinch zoom
  const isPanningRef = useRef<boolean>(false);
  const lastPanPosRef = useRef<Point>({ x: 0, y: 0 });
  const isSpacePressedRef = useRef<boolean>(false);
  const activePointersRef = useRef<Map<number, Point>>(new Map());
  const tailRef = useRef<{ id: number; props: BrushProperties; vector?: boolean } | null>(null);
  const touchInitialDistRef = useRef<number | null>(null);
  const touchLastMidRef = useRef<Point | null>(null);
  const touchTwistRef = useRef<TouchTwist | null>(null);

  const finishTail = (pointerId: number, event?: PointerEvent) => {
    const tail = tailRef.current;
    if (tail?.id !== pointerId) return false;
    tailRef.current = null;
    activePointersRef.current.delete(pointerId);
    setEraserHover(false);
    if (tail.vector) vector.finishDrag(true);
    else if (event?.type === 'pointerup') brush.finish(event);
    else brush.interrupt(pointerId);
    return true;
  };
  const blurRef = useRef(() => {});
  blurRef.current = () => {
    if (tailRef.current) finishTail(tailRef.current.id);
    clearTimeout(radialLongPressTimerRef.current);
    clearRapidTimers();
    if (eyedropperTouchRef.current) {
      eyedropperTouchRef.current = null;
      onTouchEyedropperChange?.(null);
    }
    pendingSingleFingerPanRef.current = null;
    quickPinchRef.current = null;
    pluginTool?.onCancel();
    for (const id of activePointersRef.current.keys()) brush.interrupt(id);
    setEraserHover(false);
    hideBrushCursor();
  };
  useEffect(() => {
    const onBlur = () => blurRef.current();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (filterModalOpenRef.current || radialMenuOpenRef.current || desktopPopupOpenRef.current || clipboardMenuOpenRef?.current) return;
    if ((e.target as HTMLElement | null)?.closest?.('[data-transform-overlay], [data-canvas-resize-overlay], button, select, input, textarea, [role="dialog"], [role="menu"]')) return;
    if ((isTransformActive || resizeModalOpenRef?.current) && e.button !== 1 && !isSpacePressedRef.current && currentTool !== 'hand') return;
    if (e.pointerType === 'mouse' && e.button === 2) return;
    if (e.pointerType === 'pen' && e.button !== 0 && e.button !== 5 && !hasDrawingContact(e)) return;
    const tail = tailRef.current;
    if (tail) finishTail(tail.id);
    if (e.button === 0 || e.button === 5) updateBrushCursor(e.clientX, e.clientY);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}

    // Prevent mobile gesture scrolling, zoom jumping, and touch cancellation
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      try {
        e.preventDefault();
      } catch {}
    }

    // A primary touch begins a new gesture with no other finger down: anything still listed is a
    // lift the browser never reported. Left there, it kept the old gesture open forever (taps timed
    // from long ago, two fingers counted as three), so two- / three-finger undo and redo stopped working.
    if (e.pointerType === 'touch' && e.isPrimary) {
      for (const id of [...activePointersRef.current.keys()]) if (id !== e.pointerId) activePointersRef.current.delete(id);
      touchSessionRef.current = null;
      isMultiTouchGestureRef.current = false;
      pendingSingleFingerPanRef.current = null;
      eyedropperTouchRef.current = null;
      quickPinchRef.current = null;
      clearRapidTimers();
    }

    // Stylus / Samsung S-Pen is a dedicated drawing instrument
    if (e.pointerType === 'pen') {
      activePointersRef.current.clear();
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (e.pointerType === 'touch') {
      if (!touchSessionRef.current) {
        touchSessionRef.current = {
          startTime: Date.now(),
          startPos: { x: e.clientX, y: e.clientY },
          starts: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]),
          maxPointers: activePointersRef.current.size,
          hasMoved: false,
          toolStarted: false,
          pendingBucketTarget: null,
          rapidTriggered: false,
          swipeTriggered: false,
          quickPinchTriggered: false,
        };
      } else {
        touchSessionRef.current.starts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        touchSessionRef.current.maxPointers = Math.max(
          touchSessionRef.current.maxPointers,
          activePointersRef.current.size
        );
        touchSessionRef.current.pendingBucketTarget = null;
      }
    }

    // Multi-touch gestures (Pinch-zoom / Quick-pinch fit / 2-finger Undo / 3-finger Redo / 3-finger Swipe / 4-finger Fullscreen)
    if (e.pointerType === 'touch' && activePointersRef.current.size >= 2) {
      isMultiTouchGestureRef.current = true;
      cancelPaintUnfilled();
      cancelMarquee();
      clearTimeout(radialLongPressTimerRef.current);
      pendingTouchDownRef.current = null;
      pendingSingleFingerPanRef.current = null;
      isPanningRef.current = false;
      if (eyedropperTouchRef.current) {
        eyedropperTouchRef.current = null;
        onTouchEyedropperChange?.(null);
      }
      const pipeline = strokePipelineRef.current;
      const layer = activeLayerRef.current;
      if (pipeline?.getIsDrawing() || brush.isHolding() || liquify.isActive()) {
        // A held stroke never reached the layer: reverting would wipe the stroke before it
        const drawn = brush.cancel();
        if (layer && (drawn || liquify.isActive())) layerManagerRef.current?.revertToPingPong(layer.id);
      }
      if (touchSessionRef.current?.toolStarted) {
        pluginTool?.onCancel();
        RulerManager.getInstance().onStrokeEnd();
        selectionEngineRef.current?.clearDraft();
        shapeGraphicRef.current?.clear();
        requestRender();
        vector.cancelDrag();
        shapes.cancel();
        liquify.cancel();
      }

      if (activePointersRef.current.size === 2) {
        const pts = Array.from(activePointersRef.current.values());
        const initDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        touchInitialDistRef.current = initDist;
        touchLastMidRef.current = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        touchTwistRef.current = null; // restarts on the first move of this pair
        quickPinchRef.current = new QuickPinchTracker(initDist, Date.now());
        armRapidUndoRedo(2);
      } else if (activePointersRef.current.size === 3) {
        quickPinchRef.current = null;
        armRapidUndoRedo(3);
      } else {
        quickPinchRef.current = null;
        clearRapidTimers();
      }
      return;
    }

    if (isMultiTouchGestureRef.current && e.pointerType === 'touch') return;

    // Middle click, Spacebar or the hand tool = Pan
    if (e.button === 1 || isSpacePressedRef.current || (currentTool === 'hand' && e.button === 0)) {
      isPanningRef.current = true;
      lastPanPosRef.current = { x: e.clientX, y: e.clientY };
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0 && (e.buttons & 1) === 0 && e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (isTransformActive) return;

    if (e.pointerType === 'touch') {
      const gestures = getTouchGestureSettings();
      // Stylus-only mode: ignore single-finger touch completely (multi-finger gestures still work above)
      if (gestures.singleFingerMode === 'ignore') {
        return;
      }
      const down = e.nativeEvent;
      if (gestures.singleFingerMode === 'pan') {
        pendingSingleFingerPanRef.current = { pointerId: down.pointerId, x: down.clientX, y: down.clientY };
      } else {
        pendingTouchDownRef.current = down;
      }
      clearTimeout(radialLongPressTimerRef.current);
      radialLongPressTimerRef.current = setTimeout(() => {
        if (gestures.singleFingerMode === 'pan') {
          if (pendingSingleFingerPanRef.current?.pointerId !== down.pointerId) return;
          pendingSingleFingerPanRef.current = null;
        } else {
          if (pendingTouchDownRef.current !== down) return;
          pendingTouchDownRef.current = null;
        }
        hideBrushCursor();
        if (gestures.longPressAction === 'eyedropper') {
          eyedropperTouchRef.current = {
            pointerId: down.pointerId,
            previousColor: brushProps.color,
            pickedColor: brushProps.color,
            hasSampled: false,
            sampling: false,
            queued: null,
          };
          try { navigator.vibrate?.(22); } catch {}
          sampleTouchEyedropper(down.clientX, down.clientY);
        } else {
          radialTouchRef.current = down.pointerId;
          openRadialMenu({ x: down.clientX, y: down.clientY });
        }
      }, gestures.longPressDelayMs);
      return;
    }

    const eraserTail = isTabletEraser(e.nativeEvent, true);
    setEraserHover(eraserTail);
    startCanvasTool(e.nativeEvent, eraserTail);
  };

  const startCanvasTool = (e: PointerEvent, eraserTail = false) => {
    const currentTool = eraserTail ? 'eraser' : ctx.currentTool;
    if (e.pointerType === 'touch' && touchSessionRef.current) touchSessionRef.current.toolStarted = true;
    // Active v2.5 custom plugin tool intercepts single-pointer canvas strokes
    if (!eraserTail && pluginTool?.isActive()) {
      const at = viewportRef.current?.screenToCanvas(e.clientX, e.clientY);
      if (at) pluginTool.onDown(e, at);
      return;
    }
    // The text tool makes or edits a text layer of its own, whatever layer is active
    if (currentTool === 'text') {
      const at = viewportRef.current?.screenToCanvas(e.clientX, e.clientY);
      if (at) onTextTool?.(at);
      return;
    }
    // Selection pen / eraser only change the selection, like the lasso
    if (currentTool === 'select_brush' || currentTool === 'select_eraser') {
      const at = viewportRef.current?.screenToCanvas(e.clientX, e.clientY);
      if (at) selection.startSelectBrush(at, currentTool === 'select_brush');
      return;
    }
    // Check & Auto-select Active Layer (Always allow seamless painting on reconnect)
    let targetLayer = activeLayer;
    if (targetLayer?.layerType === 'group') {
      warn('圖層組是資料夾。請選取組內的圖層再作畫。', 3000);
      return;
    }
    if (!targetLayer && layers.length > 0) {
      targetLayer = layers.find((l) => l.layerType !== 'group' && !l.isLocked) ?? null;
      if (targetLayer && onSelectLayer) {
        onSelectLayer(targetLayer.id);
      }
    }

    if (!targetLayer) {
      if (onRequestCreateMyLayer) {
        onRequestCreateMyLayer();
      }
      warn('🎨 畫布中尚無可用圖層，請先建立新圖層！', 3000);
      return;
    }

    // Keep pipeline active layer synchronized immediately
    strokePipelineRef.current?.setActiveLayer(targetLayer.id);

    // Check Layer Lock: if locked, smoothly auto-switch to any available unlocked layer
    if (targetLayer.isLocked && currentTool !== 'eyedropper') {
      const unlocked = layers.find((l) => l.layerType !== 'group' && !l.isLocked);
      if (unlocked) {
        targetLayer = unlocked;
        activeLayerRef.current = unlocked;
        if (onSelectLayer) onSelectLayer(unlocked.id);
        strokePipelineRef.current?.setActiveLayer(unlocked.id);
        warn(`💡 已為您切換至未鎖定圖層：「${unlocked.name}」`, 2500);
      } else {
        warn('⚠️ 此圖層目前已被鎖定，無法繪製或編輯！', 3000);
        return;
      }
    }

    const isReadOnlyTool = ['eyedropper', 'lasso', 'magic_wand', 'select_rect', 'select_ellipse', 'select_polygon'].includes(currentTool);
    if (!isReadOnlyTool && !canEditPixels(targetLayer)) {
      warn(
        ctx.isCanvasViewer
          ? (ctx.viewerReadOnlyWarn || '目前為旁觀模式，無法編輯畫布')
          : '請先選擇自己的圖層、接管圖層，或請擁有者共用圖層。',
        3500
      );
      return;
    }
    const local = viewportRef.current?.screenToCanvas(e.clientX, e.clientY);
    // A text layer's pixels come from its text: only selections and the eyedropper act on it
    if (targetLayer.layerType === 'text' && !isReadOnlyTool) {
      warn('這是文字圖層：用「文字」工具點它就能編輯；要用筆刷畫，請在圖層面板按「點陣化」或新增圖層。', 3500);
      return;
    }
    if (!eraserTail && isLassoErase()) {
      if (local) selection.startLasso(e, local, currentTool);
      return;
    }
    // Eyedropper
    if (currentTool === 'eyedropper') {
      if (local) brush.pickColor(local, targetLayer);
      setCurrentTool('brush');
      return;
    }

    // Paint bucket: lasso fill draws an outline; a click fills (on touch deferred to pointerup so a pinch never fills)
    if (currentTool === 'bucket') {
      if (fill.bucketMode === 'lasso') {
        if (local) selection.startLasso(e, local, currentTool);
      } else if (e.pointerType !== 'touch') {
        fill.handleBucketFill(e.clientX, e.clientY, targetLayer);
      } else if (touchSessionRef.current && activePointersRef.current.size === 1) {
        touchSessionRef.current.pendingBucketTarget = targetLayer;
      }
      return;
    }

    if (currentTool === 'paint_unfilled') {
      if (local && fill.startPaintUnfilled(local, targetLayer)) paintUnfilledPointerRef.current = e.pointerId;
      return;
    }

    // Transform Tool
    if (currentTool === 'transform' || currentTool === 'mesh_warp') {
      transform.startTransformMode(currentTool === 'mesh_warp' ? 'mesh' : 'transform', targetLayer);
      return;
    }

    // Liquify, Blur, and Smudge Tools
    if (LIQUIFY_TOOLS.includes(currentTool)) {
      if (local) liquify.start(targetLayer, local);
      return;
    }

    // Shapes and the gradient
    if (SHAPE_TOOLS.includes(currentTool) || currentTool === 'gradient') {
      if (local) shapes.start(local);
      return;
    }

    if (currentTool === 'select_rect' || currentTool === 'select_ellipse') {
      if (local) {
        marqueePointerRef.current = e.pointerId;
        selection.startMarquee(currentTool === 'select_rect' ? 'rect' : 'ellipse', e, local);
      }
      return;
    }
    if (currentTool === 'select_polygon') {
      if (local) selection.handlePolygonPointerDown(e, local, viewportRef.current?.getState().zoom ?? 1);
      return;
    }
    // The magic wand selects at once. The lasso and smart fill draw an outline.
    if (currentTool === 'magic_wand') {
      if (local) selection.selectWand(e, local, targetLayer);
      return;
    }
    if (currentTool === 'lasso' || currentTool === 'smart_fill') {
      if (local) selection.startLasso(e, local, currentTool);
      return;
    }

    // Vector tools: Bézier pen points, node editing, and the drag tools (pen, eraser, pinch, width)
    const eraserProps = currentTool === 'eraser' ? eraserStrokeProperties(eraserTail && ctx.currentTool !== 'eraser'
      ? { ...brushProps, ...loadBrushTool('eraser') } : brushProps) : undefined;
    if (currentTool === 'vector_bezier') {
      if (local) vector.penPointerDown(local, e, targetLayer);
      return;
    }
    if (currentTool === 'vector_edit') {
      if (local) vector.vectorEditPointerDown(local, targetLayer, e.shiftKey || e.ctrlKey || e.metaKey);
      return;
    }
    if (vector.isVectorDragTool(currentTool, targetLayer)) {
      if (local) {
        const tailSize = eraserTail ? eraserProps?.size : undefined;
        if (eraserTail && eraserProps) tailRef.current = { id: e.pointerId, props: eraserProps, vector: true };
        vector.startDrag(e, local, targetLayer, tailSize);
      }
      return;
    }

    // Brush, pencil, eraser
    if (local) {
      if (eraserTail && eraserProps) tailRef.current = { id: e.pointerId, props: eraserProps };
      brush.start(e, local, targetLayer, eraserProps);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const tail = tailRef.current;
    if (tail?.id === e.pointerId) {
      if (!hasDrawingContact(e) || filterModalOpenRef.current || radialMenuOpenRef.current || desktopPopupOpenRef.current) {
        finishTail(e.pointerId);
        return;
      }
      updateBrushCursor(e.clientX, e.clientY);
      const local = viewportRef.current?.screenToCanvas(e.clientX, e.clientY);
      if (tail.vector) {
        if (local) vector.moveDrag(e.nativeEvent, local, tail.props.size);
      } else {
        if (local) brush.trackTiles(e, local, tail.props.size);
        brush.move(e.nativeEvent);
      }
      return;
    }
    if (radialTouchRef.current === e.pointerId) return;
    if (filterModalOpenRef.current || radialMenuOpenRef.current || desktopPopupOpenRef.current) return;
    if (e.pointerType === 'touch' && !activePointersRef.current.has(e.pointerId)) return;
    if (!tail) setEraserHover(e.pointerType === 'pen' && isTabletEraser(e.nativeEvent));
    updateBrushCursor(e.clientX, e.clientY);
    if (activePointersRef.current.has(e.pointerId)) activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerType === 'touch') {
      // Live touch long-press eyedropper dragging
      if (eyedropperTouchRef.current?.pointerId === e.pointerId) {
        sampleTouchEyedropper(e.clientX, e.clientY);
        return;
      }

      if (touchSessionRef.current) {
        // Each finger against its own touch-down point (the second finger is never near the
        // first one's, so comparing with that made every two-finger tap look like a drag)
        const start = touchSessionRef.current.starts.get(e.pointerId) ?? touchSessionRef.current.startPos;
        const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        // Several fingers landing together wobble more than one
        if (dist > (activePointersRef.current.size >= 2 ? 18 : 10)) {
          touchSessionRef.current.hasMoved = true;
          touchSessionRef.current.pendingBucketTarget = null;
          clearRapidTimers();
        }
      }

      // If in multi-touch gesture mode (pinch-to-zoom / quick-pinch / 2-finger pan / 3-finger swipe / multi-finger undo-redo)
      if (isMultiTouchGestureRef.current || activePointersRef.current.size >= 2) {
        // 3-finger swipe down: open Copy & Paste menu
        if (
          activePointersRef.current.size === 3 &&
          touchSessionRef.current &&
          !touchSessionRef.current.swipeTriggered &&
          !touchSessionRef.current.rapidTriggered &&
          getTouchGestureSettings().threeFingerSwipeCopyPaste
        ) {
          const swipe = detectThreeFingerSwipeDown(touchSessionRef.current.starts, activePointersRef.current);
          if (swipe.triggered) {
            clearRapidTimers();
            touchSessionRef.current.swipeTriggered = true;
            touchSessionRef.current.hasMoved = true;
            try { navigator.vibrate?.(25); } catch {}
            onOpenClipboardMenu?.(swipe.centroid);
            return;
          }
        }

        if (activePointersRef.current.size === 2 && viewportRef.current) {
          const pts = Array.from(activePointersRef.current.values());
          const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          const currentMid = {
            x: (pts[0].x + pts[1].x) / 2,
            y: (pts[0].y + pts[1].y) / 2,
          };

          quickPinchRef.current?.record(currentDist, Date.now());

          if (touchInitialDistRef.current && touchInitialDistRef.current > 10) {
            const zoomDelta = currentDist / touchInitialDistRef.current;
            const anchor = touchLastMidRef.current ?? currentMid;
            viewportRef.current.zoomAt(anchor.x, anchor.y, zoomDelta);
            touchInitialDistRef.current = currentDist;
          }

          // Twisting the fingers turns the view about them (after a small dead zone; snaps near right angles)
          const [idA, idB] = Array.from(activePointersRef.current.keys());
          const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
          const twist = touchTwistRef.current;
          if (!twist || twist.a !== idA || twist.b !== idB) {
            touchTwistRef.current = {
              a: idA, b: idB, last: angle, twist: 0,
              engaged: twist?.engaged ?? false,
              raw: viewportRef.current.getState().rotation,
            };
          } else {
            const d = wrapAngle(angle - twist.last);
            twist.last = angle;
            if (!twist.engaged) {
              twist.twist += d;
              if (Math.abs(twist.twist) > TOUCH_ROTATE_ENGAGE) {
                twist.engaged = true;
                if (touchSessionRef.current) touchSessionRef.current.hasMoved = true; // not a two-finger tap
                clearRapidTimers();
              }
            } else {
              twist.raw += d;
              const anchor = touchLastMidRef.current ?? currentMid;
              const current = viewportRef.current.getState().rotation;
              viewportRef.current.rotateAt(anchor.x, anchor.y, wrapAngle(snapRightAngle(twist.raw) - current));
            }
          }

          if (touchLastMidRef.current) {
            const panX = currentMid.x - touchLastMidRef.current.x;
            const panY = currentMid.y - touchLastMidRef.current.y;
            viewportRef.current.panBy(panX, panY);
          }
          touchLastMidRef.current = currentMid;
        }
        return;
      }

      // Stylus-only single-finger pan mode: promote to pan once moved past slop
      const pendingPan = pendingSingleFingerPanRef.current;
      if (pendingPan?.pointerId === e.pointerId) {
        if (!touchSessionRef.current?.hasMoved) return;
        clearTimeout(radialLongPressTimerRef.current);
        pendingSingleFingerPanRef.current = null;
        isPanningRef.current = true;
        lastPanPosRef.current = { x: pendingPan.x, y: pendingPan.y };
      }

      // Stylus-only ignore mode: do not route single-finger touch to drawing tools
      if (!isPanningRef.current && getTouchGestureSettings().singleFingerMode === 'ignore') {
        return;
      }
    }

    const touchDown = pendingTouchDownRef.current;
    if (touchDown?.pointerId === e.pointerId) {
      if (!touchSessionRef.current?.hasMoved) return;
      clearTimeout(radialLongPressTimerRef.current);
      pendingTouchDownRef.current = null;
      startCanvasTool(touchDown);
    }

    // Active Liquify / Blur / Smudge brush execution
    if (viewportRef.current && liquify.move(viewportRef.current.screenToCanvas(e.clientX, e.clientY))) return;

    // Pan via spacebar or middle click
    if (isPanningRef.current) {
      const dx = e.clientX - lastPanPosRef.current.x;
      const dy = e.clientY - lastPanPosRef.current.y;
      lastPanPosRef.current = { x: e.clientX, y: e.clientY };
      viewportRef.current?.panBy(dx, dy);
      return;
    }

    // Broadcast cursor with 35ms throttle to eliminate websocket flooding
    if (viewportRef.current) {
      const local = viewportRef.current.screenToCanvas(e.clientX, e.clientY);
      const now = performance.now();
      if (now - lastCursorEmitTimeRef.current > 35) {
        lastCursorEmitTimeRef.current = now;
        emitCursor(
          Math.round(local.x),
          Math.round(local.y),
          Boolean((e.buttons & 1) && activeLayer && canEditPixels(activeLayer)),
          brushProps.size
        );
      }

      if (pluginTool?.isActive() && pluginTool.onMove(e.nativeEvent, local)) {
        return;
      }

      if (currentTool === 'select_rect' || currentTool === 'select_ellipse') {
        if (marqueePointerRef.current === e.pointerId) selection.updateMarquee(e, local);
        return;
      }
      if (currentTool === 'select_polygon') {
        selection.updatePolygonHover(local);
        return;
      }

      if (currentTool === 'paint_unfilled') {
        if (paintUnfilledPointerRef.current === e.pointerId && ((e.buttons & 1) !== 0 || e.pointerType === 'touch')) {
          fill.movePaintUnfilled(local);
        }
        return;
      }

      if (currentTool === 'vector_bezier') {
        vector.penPointerMove(local);
        return;
      }
      if (currentTool === 'vector_edit') {
        vector.vectorEditPointerMove(local, e.altKey);
        return;
      }
      if (vector.moveDrag(e.nativeEvent, local)) return;

      // Tiles the stroke crosses (undo restores all of them); no GPU read here
      if (selection.moveSelectBrush(local)) return;
      if (currentTool !== 'lasso' && currentTool !== 'magic_wand') brush.trackTiles(e, local);

      // Lasso outline (selection, bucket lasso, smart fill, lasso erase) — only on active contact, never pen hover
      if ((currentTool === 'lasso' || fill.isLassoFill(currentTool) || isLassoErase()) && ((e.buttons & 1) !== 0 || e.pointerType === 'touch')) {
        selection.addLassoPoint(local);
        return;
      }

      // Shape / gradient live preview (Shift = square / circle / 45°, Alt = from the centre)
      if (shapes.move(e, local)) return;
    }

    // Stroke pipeline (brush, pencil, eraser), with the live outline preview
    brush.move(e.nativeEvent);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (finishTail(e.pointerId, e.nativeEvent)) return;
    if (!activePointersRef.current.has(e.pointerId)) return;
    const cancelled = e.type === 'pointercancel';
    if (cancelled && paintUnfilledPointerRef.current === e.pointerId) cancelPaintUnfilled();
    if (cancelled && marqueePointerRef.current === e.pointerId) cancelMarquee();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    clearTimeout(radialLongPressTimerRef.current);
    clearRapidTimers();
    if (e.pointerType === "touch") hideBrushCursor();

    // Finish touch long-press eyedropper
    const activeEyedropper = eyedropperTouchRef.current;
    if (activeEyedropper?.pointerId === e.pointerId) {
      eyedropperTouchRef.current = null;
      activePointersRef.current.delete(e.pointerId);
      touchSessionRef.current = null;
      onTouchEyedropperChange?.(null);
      if (!cancelled && activeEyedropper.hasSampled) {
        onTouchEyedropperCommit?.(activeEyedropper.pickedColor);
      }
      return;
    }

    if (pendingSingleFingerPanRef.current?.pointerId === e.pointerId) {
      pendingSingleFingerPanRef.current = null;
    }

    const touchDown = pendingTouchDownRef.current;
    if (touchDown?.pointerId === e.pointerId) {
      pendingTouchDownRef.current = null;
      if (!cancelled) startCanvasTool(touchDown);
    }
    const prevCount = activePointersRef.current.size;
    activePointersRef.current.delete(e.pointerId);
    if (radialTouchRef.current === e.pointerId) {
      radialTouchRef.current = null;
      touchSessionRef.current = null;
      return;
    }

    // Check quick inward pinch-to-fit as the 2-finger pair parts
    if (e.pointerType === 'touch' && prevCount === 2 && activePointersRef.current.size < 2 && quickPinchRef.current) {
      const tracker = quickPinchRef.current;
      quickPinchRef.current = null;
      if (
        !cancelled &&
        !isTransformActive &&
        getTouchGestureSettings().quickPinchToFit &&
        tracker.shouldFitOnRelease(Date.now())
      ) {
        if (touchSessionRef.current) touchSessionRef.current.quickPinchTriggered = true;
        onQuickFitCanvas?.();
        try { navigator.vibrate?.(25); } catch {}
        warn('🔍 雙指快捏：已符合畫面', 1400);
      }
    }

    // Process touch gestures: 2-finger Undo, 3-finger Redo, 4-finger Fullscreen, and single-finger Paint Bucket
    if (e.pointerType === 'touch') {
      if (isMultiTouchGestureRef.current) {
        if (activePointersRef.current.size === 0) {
          const session = touchSessionRef.current;
          const duration = session ? Date.now() - session.startTime : 0;
          const action = session && !isTransformActive
            ? classifyMultiFingerTap({
                maxPointers: session.maxPointers,
                hasMoved: session.hasMoved,
                durationMs: duration,
                cancelled,
                rapidTriggered: session.rapidTriggered,
                swipeTriggered: session.swipeTriggered,
                quickPinchTriggered: session.quickPinchTriggered,
                fourFingerFullscreenEnabled: getTouchGestureSettings().fourFingerTapFullscreen,
              })
            : null;
          if (action === 'undo') {
            undo();
            try { navigator.vibrate?.(35); } catch {}
            warn('↩️ 雙指輕點：已撤銷 (Undo)', 1500);
          } else if (action === 'redo') {
            redo();
            try { navigator.vibrate?.(35); } catch {}
            warn('↪️ 三指輕點：已重做 (Redo)', 1500);
          } else if (action === 'fullscreen') {
            onToggleFullscreen?.();
            try { navigator.vibrate?.(30); } catch {}
          }
          isMultiTouchGestureRef.current = false;
          touchSessionRef.current = null;
          touchInitialDistRef.current = null;
          touchLastMidRef.current = null;
          touchTwistRef.current = null;
          quickPinchRef.current = null;
        }
        return;
      }

      if (touchSessionRef.current && activePointersRef.current.size === 0) {
        const session = touchSessionRef.current;
        const duration = Date.now() - session.startTime;
        if (!cancelled && !session.hasMoved && duration < 400 && session.pendingBucketTarget) {
          fill.handleBucketFill(session.startPos.x, session.startPos.y, session.pendingBucketTarget);
        }
        touchSessionRef.current = null;
        if (!session.toolStarted && !isPanningRef.current) return;
      }
    }

    if (activePointersRef.current.size < 2) {
      touchInitialDistRef.current = null;
      touchLastMidRef.current = null;
      touchTwistRef.current = null;
    }

    if (paintUnfilledPointerRef.current === e.pointerId) {
      paintUnfilledPointerRef.current = null;
      const local = viewportRef.current?.screenToCanvas(e.clientX, e.clientY);
      if (local) fill.movePaintUnfilled(local);
      if (fill.finishPaintUnfilled()) return;
    }

    if (currentTool === 'vector_bezier' && !isPanningRef.current) {
      vector.endPenDrag();
      return;
    }
    if (currentTool === 'vector_edit' && !isPanningRef.current) {
      vector.vectorEditPointerUp();
      return;
    }

    // Vector pen stroke / vector edit drag
    if (vector.finishDrag()) return;

    // Finalize Liquify / Blur / Smudge Tool
    if (liquify.finish()) return;

    if (isPanningRef.current) {
      isPanningRef.current = false;
      if (containerRef.current) {
        containerRef.current.style.cursor = isSpacePressedRef.current ? 'grab' : '';
      }
      return;
    }

    const pluginUpLocal = viewportRef.current?.screenToCanvas(e.clientX, e.clientY) ?? null;
    if (pluginTool?.onUp(e.nativeEvent, pluginUpLocal, cancelled)) return;

    if (currentTool === 'select_rect' || currentTool === 'select_ellipse') {
      if (marqueePointerRef.current === e.pointerId) {
        marqueePointerRef.current = null;
        if (pluginUpLocal) selection.updateMarquee(e, pluginUpLocal);
        selection.finishMarquee();
      }
      return;
    }
    if (currentTool === 'select_polygon') return;

    // Lasso outline tools: fill the shape (bucket lasso / smart fill) or make the selection
    if (currentTool === 'smart_fill') {
      fill.executeSmartFill();
      return;
    }
    if (currentTool === 'bucket' && fill.bucketMode === 'lasso') {
      if (cancelled) selectionEngineRef.current?.clearDraft();
      else fill.executeLassoFill(lassoOutline);
      return;
    }
    if (currentTool === 'lasso') {
      selection.finishLasso();
      return;
    }
    if (selection.finishSelectBrush()) return;
    if (isLassoErase()) {
      selection.eraseLasso();
      return;
    }

    // Shapes / gradient: paint what was previewed
    const upLocal = viewportRef.current?.screenToCanvas(e.clientX, e.clientY);
    if (upLocal && shapes.finish(e, upLocal)) return;

    brush.finish(e.nativeEvent);
  };

  const handleLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (finishTail(e.pointerId)) return;
    if (paintUnfilledPointerRef.current === e.pointerId) cancelPaintUnfilled();
    if (marqueePointerRef.current === e.pointerId) cancelMarquee();
    if (activePointersRef.current.has(e.pointerId)) brush.interrupt(e.pointerId);
  };

  /** Canvas switch / engine rebuild: forget every pointer, gesture and pan in progress */
  const reset = () => {
    if (radialLongPressTimerRef.current) clearTimeout(radialLongPressTimerRef.current);
    clearRapidTimers();
    pluginTool?.onCancel();
    cancelPaintUnfilled();
    cancelMarquee();
    selection.cancelPolygonLasso();
    activePointersRef.current.clear();
    tailRef.current = null;
    setEraserHover(false);
    radialTouchRef.current = null;
    if (eyedropperTouchRef.current) {
      eyedropperTouchRef.current = null;
      onTouchEyedropperChange?.(null);
    }
    pendingTouchDownRef.current = null;
    pendingSingleFingerPanRef.current = null;
    touchSessionRef.current = null;
    isMultiTouchGestureRef.current = false;
    touchInitialDistRef.current = null;
    touchLastMidRef.current = null;
    touchTwistRef.current = null;
    quickPinchRef.current = null;
    isSpacePressedRef.current = false;
    isPanningRef.current = false;
  };

  return { handlePointerDown, handlePointerMove, handlePointerUp, handleLostPointerCapture, isSpacePressedRef, reset };
}

import { useEffect, useRef } from 'react';
import type React from 'react';
import type { LayerModel, ToolType } from '@atelier/shared';
import { RulerManager } from '../../../engine/RulerManager';
import type { BrushProperties } from '../../../engine/BrushRenderer';
import { eraserStrokeProperties, loadBrushTool } from '../../../engine/brushToolSettings';
import { hasDrawingContact, isTabletEraser } from '../../../engine/tabletInput';
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
  /** While a filter dialog or the radial menu is open the canvas ignores the pointer */
  filterModalOpenRef: React.MutableRefObject<boolean>;
  radialMenuOpenRef: React.MutableRefObject<boolean>;
  /** While the canvas resize frame is open, prevent accidental strokes while still allowing pan/zoom */
  resizeModalOpenRef?: React.MutableRefObject<boolean>;
  updateBrushCursor: (clientX: number, clientY: number) => void;
  hideBrushCursor: () => void;
  setEraserHover: (active: boolean) => void;
  openRadialMenu: (pos: Point) => void;
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
    containerRef, filterModalOpenRef, radialMenuOpenRef, resizeModalOpenRef, updateBrushCursor, hideBrushCursor, openRadialMenu, emitCursor,
    setEraserHover, undo, redo, setCurrentTool, onSelectLayer, onRequestCreateMyLayer, onTextTool, pluginTool,
  } = deps;
  const isLassoErase = () => currentTool === 'eraser' && selection.lassoErase;
  const isTransformActive = transform.isTransformActive;

  const lastCursorEmitTimeRef = useRef<number>(0);
  // Mobile touch gestures: Procreate-like 2-finger undo / 3-finger redo, deferred one-finger bucket
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
  } | null>(null);
  // Long press opens the radial menu; the press is held back until it moves or lifts
  const radialLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTouchDownRef = useRef<PointerEvent | null>(null);
  const radialTouchRef = useRef<number | null>(null);
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
    if (filterModalOpenRef.current || radialMenuOpenRef.current) return;
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

    // Multi-touch gestures (Pinch-zoom / 2-finger Undo / 3-finger Redo)
    if (e.pointerType === 'touch' && activePointersRef.current.size >= 2) {
      isMultiTouchGestureRef.current = true;
      clearTimeout(radialLongPressTimerRef.current);
      pendingTouchDownRef.current = null;
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
        touchInitialDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        touchLastMidRef.current = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        touchTwistRef.current = null; // restarts on the first move of this pair
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
      const down = e.nativeEvent;
      pendingTouchDownRef.current = down;
      clearTimeout(radialLongPressTimerRef.current);
      radialLongPressTimerRef.current = setTimeout(() => {
        if (pendingTouchDownRef.current !== down) return;
        pendingTouchDownRef.current = null;
        radialTouchRef.current = down.pointerId;
        hideBrushCursor();
        openRadialMenu({ x: down.clientX, y: down.clientY });
      }, 550);
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

    const isReadOnlyTool = currentTool === 'eyedropper' || currentTool === 'lasso' || currentTool === 'magic_wand';
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
    if (targetLayer.layerType === 'text' && !['eyedropper', 'lasso', 'magic_wand'].includes(currentTool)) {
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

    // Selection: the magic wand selects at once, the lasso (and smart fill) draw an outline
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
      if (local) vector.vectorEditPointerDown(local, targetLayer);
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
      if (!hasDrawingContact(e) || filterModalOpenRef.current || radialMenuOpenRef.current) {
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
    if (filterModalOpenRef.current || radialMenuOpenRef.current) return;
    if (e.pointerType === 'touch' && !activePointersRef.current.has(e.pointerId)) return;
    if (!tail) setEraserHover(e.pointerType === 'pen' && isTabletEraser(e.nativeEvent));
    updateBrushCursor(e.clientX, e.clientY);
    if (activePointersRef.current.has(e.pointerId)) activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerType === 'touch') {
      if (touchSessionRef.current) {
        // Each finger against its own touch-down point (the second finger is never near the
        // first one's, so comparing with that made every two-finger tap look like a drag)
        const start = touchSessionRef.current.starts.get(e.pointerId) ?? touchSessionRef.current.startPos;
        const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        // Several fingers landing together wobble more than one
        if (dist > (activePointersRef.current.size >= 2 ? 18 : 10)) {
          touchSessionRef.current.hasMoved = true;
          touchSessionRef.current.pendingBucketTarget = null;
        }
      }

      // If in multi-touch gesture mode (pinch-to-zoom / 2-finger pan / multi-finger undo-redo)
      if (isMultiTouchGestureRef.current || activePointersRef.current.size >= 2) {
        if (activePointersRef.current.size === 2 && viewportRef.current) {
          const pts = Array.from(activePointersRef.current.values());
          const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          const currentMid = {
            x: (pts[0].x + pts[1].x) / 2,
            y: (pts[0].y + pts[1].y) / 2,
          };

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
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    clearTimeout(radialLongPressTimerRef.current);
    if (e.pointerType === "touch") hideBrushCursor();

    const touchDown = pendingTouchDownRef.current;
    if (touchDown?.pointerId === e.pointerId) {
      pendingTouchDownRef.current = null;
      if (!cancelled) startCanvasTool(touchDown);
    }
    activePointersRef.current.delete(e.pointerId);
    if (radialTouchRef.current === e.pointerId) {
      radialTouchRef.current = null;
      touchSessionRef.current = null;
      return;
    }

    // Process touch gestures: Procreate 2-finger Undo, 3-finger Redo, and single-finger Paint Bucket
    if (e.pointerType === 'touch') {
      if (isMultiTouchGestureRef.current) {
        if (activePointersRef.current.size === 0) {
          const session = touchSessionRef.current;
          const duration = session ? Date.now() - session.startTime : 0;
          if (!cancelled && !isTransformActive && session && !session.hasMoved && duration < 500) {
            if (session.maxPointers === 2) {
              undo();
              try { navigator.vibrate?.(35); } catch {}
              warn('↩️ 雙指輕點：已撤銷 (Undo)', 1500);
            } else if (session.maxPointers >= 3) {
              redo();
              try { navigator.vibrate?.(35); } catch {}
              warn('↪️ 三指輕點：已重做 (Redo)', 1500);
            }
          }
          isMultiTouchGestureRef.current = false;
          touchSessionRef.current = null;
          touchInitialDistRef.current = null;
          touchLastMidRef.current = null;
          touchTwistRef.current = null;
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
        containerRef.current.style.cursor = isSpacePressedRef.current ? 'grab' : 'crosshair';
      }
      return;
    }

    const pluginUpLocal = viewportRef.current?.screenToCanvas(e.clientX, e.clientY) ?? null;
    if (pluginTool?.onUp(e.nativeEvent, pluginUpLocal, cancelled)) return;

    // Lasso outline tools: fill the shape (bucket lasso / smart fill) or make the selection
    if (currentTool === 'smart_fill') {
      fill.executeSmartFill();
      return;
    }
    if (currentTool === 'bucket' && fill.bucketMode === 'lasso') {
      fill.executeLassoFill(brush.outlineBrush);
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
    if (activePointersRef.current.has(e.pointerId)) brush.interrupt(e.pointerId);
  };

  /** Canvas switch / engine rebuild: forget every pointer, gesture and pan in progress */
  const reset = () => {
    if (radialLongPressTimerRef.current) clearTimeout(radialLongPressTimerRef.current);
    pluginTool?.onCancel();
    activePointersRef.current.clear();
    tailRef.current = null;
    setEraserHover(false);
    radialTouchRef.current = null;
    pendingTouchDownRef.current = null;
    touchSessionRef.current = null;
    isMultiTouchGestureRef.current = false;
    touchInitialDistRef.current = null;
    touchLastMidRef.current = null;
    touchTwistRef.current = null;
    isSpacePressedRef.current = false;
    isPanningRef.current = false;
  };

  return { handlePointerDown, handlePointerMove, handlePointerUp, handleLostPointerCapture, isSpacePressedRef, reset };
}

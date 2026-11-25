import { BrushProperties, BrushRenderer } from './BrushRenderer';
import { CanvasViewport } from './Viewport';
import type { TileCoord, TileData } from '@atelier/shared';
import { LayerManager, type BrushTarget, type StrokeInk } from './LayerManager';
import { FLOATS_PER_DAB, RawPoint, StrokeWorkerEngine } from '../workers/stroke.worker';
import { RulerManager } from './RulerManager';
import { startTabletStroke, type TabletMotion, type TabletPoint, type TabletStroke } from './tabletInput';
import { getQuickShapeDelayMs, getQuickShapeEnabled } from './inputPreferences';
import { adjustQuickShapeByPointer, buildQuickShapeDabs, recognizeQuickShape, sampleQuickShapePoints,
  type QuickShapeCandidate, type QuickShapeKind, type QuickShapePoint } from './quickShape';
import { getWrappedStampPoints } from './wrapAround';

/** When the pen was there (same clock as performance.now); some synthetic events report 0 */
const eventTime = (e: { timeStamp?: number }) => (e.timeStamp && e.timeStamp > 0 ? e.timeStamp : performance.now());
const maxFrameDabFloats = 500 * FLOATS_PER_DAB;
const isDesktopInput = () => typeof window !== 'undefined' && Boolean(
  (window as { atelierDesktop?: { isElectron?: boolean } }).atelierDesktop?.isElectron,
);

type StrokePoint = { x: number; y: number; pressure: number };

export interface StrokeCommitData {
  brush: 'CustomBrush' | 'StandardBrush';
  color: string;
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  isEraser: boolean;
  pointsCount: number;
  samplePoints: StrokePoint[];
  allPoints?: StrokePoint[];
  quickShapeKind?: QuickShapeKind;
  quickShapePreviewId?: number;
  originalTiles?: TileCoord[];
  originalPoints?: StrokePoint[];
  wrapAround?: boolean;
}

export interface StrokePipelineCallbacks {
  coalesceTouch?: boolean;
  onEmitPreviewDabs?: (
    dabs: StrokePoint[], isEraser: boolean, quickShapePreviewId?: number, layerId?: string,
  ) => void;
  onCommitStroke?: (strokeData: StrokeCommitData, inkTiles?: Promise<TileData[]>) => void;
  onQuickShapeChange?: (shape: QuickShapeCandidate | null) => void;
}

export class StrokePipeline {
  private engine = new StrokeWorkerEngine();
  private brushRenderer: BrushRenderer;
  private layerManager: LayerManager;
  private viewport: CanvasViewport;
  private callbacks: StrokePipelineCallbacks;

  private isDrawing: boolean = false;
  private strokeId = 0;
  private cancelledThroughStrokeId = 0;
  private activeLayerId: string | null = null;
  private wrapAroundEnabled = false;
  private strokeWrapAroundEnabled = false;
  private currentStrokePoints: StrokePoint[] = [];
  private lastValidPoint: RawPoint | null = null;
  private tabletStroke: TabletStroke | null = null;
  private motionPending = false;
  private touchMotion: TabletPoint[] = [];
  private onNeedsRender: (() => void) | null = null;

  public setOnNeedsRender(cb: (() => void) | null) {
    this.onNeedsRender = cb;
  }

  public setWrapAround(enabled: boolean): void {
    this.wrapAroundEnabled = enabled;
  }

  public isStrokeWrapped(): boolean {
    return this.strokeWrapAroundEnabled;
  }

  public hasPendingWork(): boolean {
    return this.motionPending || this.touchMotion.length > 0 || this.frameDabFloats > 0 ||
      Boolean(this.quickShapeCurrent && this.callbacks.onEmitPreviewDabs && this.pendingPreviewDabs.length);
  }
  private frameDabs: Float32Array[] = [];
  private frameDabFloats = 0;
  private pendingRelease?: PointerEvent;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private eraserProps?: BrushProperties;
  private strokeInk?: StrokeInk;
  private captureInkForStroke = false;
  private rawQuickShapePoints: QuickShapePoint[] = [];
  private quickShapeTimer?: ReturnType<typeof setTimeout>;
  private quickShapeHoldPoint?: QuickShapePoint;
  private quickShapeInitial?: QuickShapeCandidate;
  private quickShapeCurrent?: QuickShapeCandidate;
  private quickShapeAnchor?: QuickShapePoint;
  private quickShapePointer?: { point: QuickShapePoint; shift: boolean };
  private quickShapeShift = false;
  private quickShapeAvgPressure = 0.7;
  private quickShapeDabStyle?: { size: number; pressure: number; alpha: number };
  private quickShapePreviewId?: number;
  private quickShapeOriginalTiles: TileCoord[] = [];
  private quickShapeOriginalPoints: StrokePoint[] = [];
  private quickShapeAllowed = false;
  private strokeProps?: BrushProperties;
  private lastEventTime = 0;
  private strokePeakPressure = 0;
  private prevPositivePressure = 0;
  private inTailTaper = false;
  private taperLowPressure = 1;
  private taperLowTime = 0;
  private pendingSpikePoints: RawPoint[] = [];

  // Throttled preview dab buffer for socket streaming
  private pendingPreviewDabs: StrokePoint[] = [];
  private lastPreviewEmitTime: number = 0;
  private previewIntervalMs: number = 24; // ~40Hz streaming for smooth live preview

  constructor(
    brushRenderer: BrushRenderer,
    layerManager: LayerManager,
    viewport: CanvasViewport,
    callbacks: StrokePipelineCallbacks = {}
  ) {
    this.brushRenderer = brushRenderer;
    this.layerManager = layerManager;
    this.viewport = viewport;
    this.callbacks = callbacks;
  }

  public setActiveLayer(layerId: string | null) {
    if (this.activeLayerId !== layerId) {
      if (this.quickShapeCurrent && this.activeLayerId) {
        this.layerManager.revertToPingPong(this.activeLayerId);
        this.cancelStroke();
      } else {
        this.flushFrameDabs();
        this.quickShapeAllowed = false;
        clearTimeout(this.quickShapeTimer);
      }
    }
    this.activeLayerId = layerId;
    this.brushRenderer.setMixerTileReader(
      layerId ? (col, row) => this.layerManager.readTileSync(layerId, col, row, 'after') : null
    );
  }

  public setCallbacks(callbacks: StrokePipelineCallbacks) {
    this.callbacks = callbacks;
  }

  public renderFrame() {
    this.flushTouchMotion();
    if (this.motionPending && this.tabletStroke) {
      this.motionPending = false;
      const motion = this.tabletStroke.consumeMotion();
      if (motion) this.applyMotion(this.tabletStroke, motion);
    }
    this.flushFrameDabs();
    if (this.quickShapeCurrent) this.emitQuickShapePreview();
  }

  private queueFrameDabs(dabs: Float32Array) {
    if (!dabs.length) return;
    if (this.frameDabFloats + dabs.length > maxFrameDabFloats) this.flushFrameDabs();
    if (dabs.length > maxFrameDabFloats || this.eraserProps || !this.brushRenderer.canBatchStrokeDabs() ||
      RulerManager.getInstance().state.mode === 'symmetry') {
      this.flushFrameDabs();
      this.emitDabs(dabs, this.strokeId, false, false);
      return;
    }
    this.frameDabs.push(dabs);
    this.frameDabFloats += dabs.length;
    this.onNeedsRender?.();
  }

  private flushFrameDabs() {
    if (!this.frameDabFloats) return;
    let merged = this.frameDabs[0];
    if (this.frameDabs.length > 1) {
      merged = new Float32Array(this.frameDabFloats);
      let offset = 0;
      for (const batch of this.frameDabs) {
        merged.set(batch, offset);
        offset += batch.length;
      }
    }
    this.frameDabs = [];
    this.frameDabFloats = 0;
    this.emitDabs(merged, this.strokeId, false, false);
  }

  private emitDabs(dabsArray: Float32Array, strokeId: number, isStart: boolean, isFinish: boolean) {
    if (strokeId <= this.cancelledThroughStrokeId) return;

    const count = Math.floor(dabsArray.length / FLOATS_PER_DAB);
    const props = this.eraserProps ?? this.brushRenderer.getProperties();

    if (count > 0 && this.activeLayerId) {
      const layerItem = this.layerManager.getLayerItem(this.activeLayerId);
      if (layerItem) {
        const isAlphaLocked = Boolean(layerItem.model.alphaLocked);

        // Local zero-latency GPU rendering onto active layer: into the tiles the dabs touch (a sparse
        // layer never becomes one 305 MB texture for a stroke), unless the brush needs the whole layer
        const target = this.layerManager.drawTarget(this.activeLayerId, {
          whole: this.brushRenderer.needsWholeLayer(), ink: this.strokeInk,
        });
        if (target) {
          if (this.strokeWrapAroundEnabled) {
            this.stampWrappedDabs(target, dabsArray, count, isAlphaLocked, props);
          } else {
            this.brushRenderer.stampDabs(target, dabsArray, count, undefined, undefined, isAlphaLocked, this.eraserProps);
            this.onNeedsRender?.();

            // Collect points for preview streaming and final Op commit
            const rulerMgr = RulerManager.getInstance();
            const shouldSnap = props.snapToRuler !== false;
            const isSymmetry = shouldSnap && rulerMgr.state.mode === 'symmetry';

            if (isSymmetry) {
              // Collect and immediately stamp all mirrored dabs across symmetry axes on GPU
              const extraDabs: number[] = [];

              for (let i = 0; i < count; i++) {
                const offset = i * FLOATS_PER_DAB;
                const origPt = {
                  x: Math.round(dabsArray[offset] * 10) / 10,
                  y: Math.round(dabsArray[offset + 1] * 10) / 10,
                  pressure: Math.round(dabsArray[offset + 3] * 100) / 100,
                };
                this.currentStrokePoints.push(origPt);
                if (this.callbacks.onEmitPreviewDabs) this.pendingPreviewDabs.push(origPt);

                const symPts = rulerMgr.getSymmetryPoints(origPt);
                // symPts[0] is the original point; subsequent entries are mirrored counterparts
                for (let s = 1; s < symPts.length; s++) {
                  const sp = symPts[s];
                  const symDab = { x: sp.x, y: sp.y, pressure: origPt.pressure };
                  this.currentStrokePoints.push(symDab);
                  if (this.callbacks.onEmitPreviewDabs) this.pendingPreviewDabs.push(symDab);

                  extraDabs.push(
                    sp.x,
                    sp.y,
                    dabsArray[offset + 2], // size
                    dabsArray[offset + 3], // pressure
                    dabsArray[offset + 4], // alpha
                    dabsArray[offset + 5], // rotation
                    dabsArray[offset + 6]  // tilt
                  );
                }
              }

              if (extraDabs.length > 0) {
                const extraDabsArray = new Float32Array(extraDabs);
                this.brushRenderer.stampDabs(
                  target,
                  extraDabsArray,
                  extraDabs.length / FLOATS_PER_DAB,
                  undefined,
                  undefined,
                  isAlphaLocked,
                  this.eraserProps
                );
              }
            } else {
              for (let i = 0; i < count; i++) {
                const offset = i * FLOATS_PER_DAB;
                const pt = {
                  x: Math.round(dabsArray[offset] * 10) / 10,
                  y: Math.round(dabsArray[offset + 1] * 10) / 10,
                  pressure: Math.round(dabsArray[offset + 3] * 100) / 100,
                };
                this.currentStrokePoints.push(pt);
                if (this.callbacks.onEmitPreviewDabs) this.pendingPreviewDabs.push(pt);
              }
            }
          }

          // Check throttled preview dab emission
          const now = this.callbacks.onEmitPreviewDabs ? performance.now() : 0;
          if (
            !this.quickShapeCurrent && this.callbacks.onEmitPreviewDabs &&
            this.pendingPreviewDabs.length > 0 &&
            (now - this.lastPreviewEmitTime >= this.previewIntervalMs || isStart || isFinish)
          ) {
            this.emitFreehandPreview(props.isEraser, now);
          }
        }
      }
    }

    if (isFinish) {
      if (this.strokeWrapAroundEnabled && !this.quickShapeCurrent && this.pendingPreviewDabs.length) {
        this.emitFreehandPreview(props.isEraser, performance.now());
      }
      // Finalize stroke Op
      if (this.callbacks.onCommitStroke && this.currentStrokePoints.length > 0) {
        this.callbacks.onCommitStroke({
          brush: props.customBrushUrl ? 'CustomBrush' : 'StandardBrush',
          color: props.color,
          size: props.size,
          opacity: props.opacity,
          flow: props.flow,
          hardness: props.hardness,
          spacing: props.spacing,
          isEraser: props.isEraser,
          pointsCount: this.currentStrokePoints.length,
          // Spread over the whole stroke (not its first 200 points): others use it as the stroke's footprint
          samplePoints: this.currentStrokePoints.filter((_, i, all) => i % Math.ceil(all.length / 400) === 0 || i === all.length - 1),
          allPoints: [...this.currentStrokePoints],
          ...(this.strokeWrapAroundEnabled && { wrapAround: true }),
          ...(this.quickShapeCurrent && {
            quickShapeKind: this.quickShapeCurrent.kind,
            quickShapePreviewId: this.quickShapePreviewId,
            originalTiles: this.quickShapeOriginalTiles,
            originalPoints: this.quickShapeOriginalPoints,
          }),
        }, this.strokeInk && this.layerManager.readStrokeInk(this.strokeInk));
        this.strokeInk = undefined;
      } else if (this.strokeInk) {
        this.layerManager.releaseStrokeInk(this.strokeInk);
        this.strokeInk = undefined;
      }
      this.currentStrokePoints = [];
      this.pendingPreviewDabs = [];
      this.lastValidPoint = null;
      this.isDrawing = false;
      this.eraserProps = undefined;
      this.clearQuickShape();
    }
  }

  private emitFreehandPreview(isEraser: boolean, now: number) {
    const points = this.pendingPreviewDabs;
    const chunkSize = this.strokeWrapAroundEnabled ? 512 : points.length;
    for (let i = 0; i < points.length; i += chunkSize) {
      this.callbacks.onEmitPreviewDabs?.(points.slice(i, i + chunkSize), isEraser);
    }
    this.pendingPreviewDabs = [];
    this.lastPreviewEmitTime = now;
  }

  private stampWrappedDabs(target: BrushTarget, dabs: Float32Array, count: number,
    isAlphaLocked: boolean, props: BrushProperties,
  ) {
    const { width, height } = this.layerManager.getCanvasDimensions();
    const ruler = RulerManager.getInstance();
    const symmetry = props.snapToRuler !== false && ruler.state.mode === 'symmetry';
    const instances: Array<Array<{ x: number; y: number }>> = [];
    const baseDabs: number[] = [];
    for (let i = 0; i < count; i++) {
      const offset = i * FLOATS_PER_DAB;
      const point = { x: dabs[offset], y: dabs[offset + 1] };
      const size = dabs[offset + 2];
      const pressure = Math.round(dabs[offset + 3] * 100) / 100;
      const tiltScale = 1 + (props.tiltSize ?? 0) * dabs[offset + 6] * 1.5;
      const radius = Math.max(size * 0.65, size * tiltScale * (props.customBrushUrl ? 0.71 : 0.65) + 1);
      for (const { x, y } of symmetry ? ruler.getSymmetryPoints(point) : [point]) {
        const copies = getWrappedStampPoints(x, y, radius, width, height);
        if (!copies.length) continue;
        instances.push(copies);
        baseDabs.push(copies[0].x, copies[0].y, size, dabs[offset + 3], dabs[offset + 4], dabs[offset + 5], dabs[offset + 6]);
        for (const copy of copies) {
          const preview = { x: copy.x, y: copy.y, pressure };
          this.currentStrokePoints.push(preview);
          if (this.callbacks.onEmitPreviewDabs) this.pendingPreviewDabs.push(preview);
        }
      }
    }
    this.brushRenderer.stampDabs(target, Float32Array.from(baseDabs), instances.length,
      undefined, undefined, isAlphaLocked, this.eraserProps, instances);
    this.onNeedsRender?.();
  }

  private trackQuickShapePoint(point: QuickShapePoint) {
    if (!this.quickShapeAllowed || !getQuickShapeEnabled()) return;
    const mode = RulerManager.getInstance().state.mode;
    if (mode !== 'off' && mode !== 'symmetry') {
      this.quickShapeAllowed = false;
      return;
    }
    const previous = this.rawQuickShapePoints.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.5) {
      this.rawQuickShapePoints.push(point);
    }
    const hold = this.quickShapeHoldPoint;
    const tolerance = Math.max(5, 6 / Math.max(0.1, this.viewport.getState().zoom));
    if (hold && Math.hypot(point.x - hold.x, point.y - hold.y) <= tolerance) return;
    this.quickShapeHoldPoint = point;
    clearTimeout(this.quickShapeTimer);
    const timer = setTimeout(() => {
      if (!this.isDrawing || this.pendingRelease || this.quickShapeTimer !== timer) return;
      // Coalesced or native samples can be waiting for the next frame when the hold expires.
      this.renderFrame();
      if (!this.isDrawing || this.quickShapeTimer !== timer) return;
      this.quickShapeTimer = undefined;
      const currentMode = RulerManager.getInstance().state.mode;
      if (!this.quickShapeAllowed || !getQuickShapeEnabled() || (currentMode !== 'off' && currentMode !== 'symmetry')) return;
      const candidate = recognizeQuickShape(this.rawQuickShapePoints);
      if (!candidate || !this.activeLayerId) return;
      let weightedPressure = 0;
      let length = 0;
      for (let i = 1; i < this.rawQuickShapePoints.length; i++) {
        const a = this.rawQuickShapePoints[i - 1];
        const b = this.rawQuickShapePoints[i];
        const step = Math.hypot(b.x - a.x, b.y - a.y);
        weightedPressure += step * ((a.pressure ?? 0.7) + (b.pressure ?? 0.7)) / 2;
        length += step;
      }
      this.quickShapeAvgPressure = length ? weightedPressure / length : 0.7;
      this.quickShapeAnchor = this.rawQuickShapePoints.at(-1)!;
      this.quickShapeInitial = candidate;
      this.quickShapePreviewId = performance.timeOrigin + performance.now();
      this.quickShapeOriginalTiles = this.layerManager.editedSparseTiles(this.activeLayerId) ?? [];
      this.quickShapeOriginalPoints = this.currentStrokePoints;
      // Reuse the worker's pressure/opacity/flow calculation once so adjustments use a stable tip.
      const dab = this.engine.startSegment({ ...this.lastValidPoint!, ...this.quickShapeAnchor, pressure: this.quickShapeAvgPressure });
      this.quickShapeDabStyle = { size: dab[2], pressure: dab[3], alpha: dab[4] };
      this.renderSnappedQuickShape(candidate);
    }, getQuickShapeDelayMs());
    this.quickShapeTimer = timer;
  }

  private renderSnappedQuickShape(candidate: QuickShapeCandidate) {
    if (!this.activeLayerId || !this.strokeProps || !this.quickShapeDabStyle) return;
    const props = this.strokeProps;
    const { size, pressure, alpha } = this.quickShapeDabStyle;
    this.layerManager.revertToPingPong(this.activeLayerId);
    if (this.strokeInk) this.layerManager.releaseStrokeInk(this.strokeInk);
    this.strokeInk = this.captureInkForStroke ? new Map() : undefined;
    this.brushRenderer.resetStrokeState();
    this.quickShapeCurrent = candidate;
    this.currentStrokePoints = [];
    this.pendingPreviewDabs = [];
    const points = sampleQuickShapePoints(candidate, size * props.spacing, pressure);
    const closed = candidate.kind !== 'line' && candidate.kind !== 'arc';
    const dabs = buildQuickShapeDabs(points, size, alpha, props.angleMode === 'fixed' ? 0 : undefined);
    // The closing sample supplies the seam tangent. Stamp that position once.
    const limit = closed ? dabs.length - FLOATS_PER_DAB : dabs.length;
    for (let i = 0; i < limit; i += maxFrameDabFloats) {
      this.emitDabs(dabs.subarray(i, Math.min(i + maxFrameDabFloats, limit)), this.strokeId, false, false);
    }
    this.emitQuickShapePreview();
    this.onNeedsRender?.();
    this.callbacks.onQuickShapeChange?.(candidate);
  }

  private emitQuickShapePreview(force = false) {
    const now = performance.now();
    if (this.pendingPreviewDabs.length && (force || now - this.lastPreviewEmitTime >= this.previewIntervalMs)) {
      const points = this.pendingPreviewDabs;
      // The room accepts at most 512 dabs per preview packet. Keep its full footprint.
      const preview = points.length <= 512 ? points : Array.from({ length: 512 }, (_, i) =>
        points[Math.round(i * (points.length - 1) / 511)]);
      this.callbacks.onEmitPreviewDabs?.(
        preview, Boolean(this.strokeProps?.isEraser), this.quickShapePreviewId, this.activeLayerId ?? undefined,
      );
      this.pendingPreviewDabs = [];
      this.lastPreviewEmitTime = now;
    }
  }

  private adjustQuickShape(clientX: number, clientY: number) {
    if (!this.quickShapeInitial || !this.quickShapeAnchor) return;
    const point = this.viewport.screenToCanvas(clientX, clientY);
    const previous = this.quickShapePointer;
    if (previous?.point.x === point.x && previous.point.y === point.y && previous.shift === this.quickShapeShift) return;
    this.quickShapePointer = { point, shift: this.quickShapeShift };
    this.renderSnappedQuickShape(adjustQuickShapeByPointer(this.quickShapeInitial, this.quickShapeAnchor, point, this.quickShapeShift));
  }

  private clearQuickShape(cancelled = false) {
    clearTimeout(this.quickShapeTimer);
    this.quickShapeTimer = undefined;
    if (cancelled && this.quickShapeCurrent) {
      this.callbacks.onEmitPreviewDabs?.(
        [], Boolean(this.strokeProps?.isEraser), this.quickShapePreviewId, this.activeLayerId ?? undefined,
      );
    }
    this.captureInkForStroke = false;
    this.quickShapeAllowed = false;
    this.rawQuickShapePoints = [];
    this.quickShapeHoldPoint = undefined;
    this.quickShapeInitial = undefined;
    this.quickShapeCurrent = undefined;
    this.quickShapeAnchor = undefined;
    this.quickShapePointer = undefined;
    this.quickShapeDabStyle = undefined;
    this.quickShapePreviewId = undefined;
    this.quickShapeOriginalTiles = [];
    this.quickShapeOriginalPoints = [];
    this.callbacks.onQuickShapeChange?.(null);
  }

  /**
   * Handle pointer down event
   */
  public handlePointerDown(e: React.PointerEvent<HTMLCanvasElement> | PointerEvent, eraserProps?: BrushProperties, captureInk = false) {
    if (!this.activeLayerId || this.isDrawing) return;

    const tablet = startTabletStroke(e);
    this.tabletStroke = tablet;
    this.eraserProps = eraserProps;
    this.captureInkForStroke = captureInk && !eraserProps && !this.brushRenderer.getProperties().colorMixing;
    if (this.captureInkForStroke) this.strokeInk = new Map();
    this.quickShapeAllowed = getQuickShapeEnabled();
    this.quickShapeShift = e.shiftKey;
    this.strokeId++;
    this.strokeWrapAroundEnabled = this.wrapAroundEnabled;
    this.isDrawing = true;
    this.layerManager.markInteractive();
    this.currentStrokePoints = [];
    this.lastValidPoint = null;
    this.pendingPreviewDabs = [];
    this.lastPreviewEmitTime = performance.now();

    this.brushRenderer.resetStrokeState();

    this.strokeProps = { ...(eraserProps ?? this.brushRenderer.getProperties()) };
    if (!tablet.awaitingNativeStart) this.beginStroke(tablet, tablet.initialPoint);
    tablet.onMotionAvailable = () => {
      this.motionPending = true;
      this.onNeedsRender?.();
    };
    this.motionPending = tablet.hasNativeMotion;
    if (this.motionPending) this.onNeedsRender?.();
  }

  private beginStroke(tablet: TabletStroke, initial: TabletPoint) {
    const props = this.strokeProps!;
    const shouldSnap = props.snapToRuler !== false;

    const localPt = this.viewport.screenToCanvas(initial.clientX, initial.clientY);
    const rulerMgr = RulerManager.getInstance();
    if (shouldSnap) rulerMgr.onStrokeStart(localPt);
    const snapped = shouldSnap ? rulerMgr.snapPoint(localPt) : { point: localPt, snapped: false };
    const strokeStartPt = snapped.point;

    const pressure = this.eraserProps && !tablet.isPen && !tablet.isTouchSimulated ? 1 : tablet.pressure(initial).normalized;
    const time = eventTime(initial);
    this.lastEventTime = time;

    const initialPoint: RawPoint = {
      x: strokeStartPt.x,
      y: strokeStartPt.y,
      pressure,
      tiltX: initial.tiltX,
      tiltY: initial.tiltY,
      twist: initial.twist,
      time,
    };
    this.lastValidPoint = initialPoint;
    this.trackQuickShapePoint({ ...localPt, pressure });
    this.resetTailTaperState(initialPoint);

    const dabs = this.engine.initStroke(
      {
        size: props.size,
        minSize: props.minSize,
        hardness: props.hardness,
        flow: props.flow,
        spacing: props.spacing,
        isEraser: props.isEraser,
        eraserMode: this.eraserProps?.eraserMode,
        opacity: props.opacity,
        stabilizerLevel: props.stabilizerLevel,
        // Pen points already pass through the stabilizer. A midpoint spline would add half a packet of lag.
        followSamples: tablet.isPen || (props.stabilizerLevel === 0 && isDesktopInput() && initial.pointerType !== 'touch'),
        lowRateInput: !tablet.isPen && !tablet.hasNativeMotion && !isDesktopInput(),
        scatter: props.scatter,
        pressureCurve: tablet.curve ?? props.pressureCurve,
        colorMixing: props.colorMixing,
        paintAmount: props.paintAmount,
        brushType: props.brushType,
        antiAlias: props.antiAlias,
        angleMode: props.angleMode,
        dynamics: props.dynamics,
      },
      initialPoint
    );
    this.emitDabs(dabs, this.strokeId, true, false);
  }

  /**
   * Handle pointer move event with high-frequency Chromium coalesced events
   */
  public handlePointerMove(e: React.PointerEvent<HTMLCanvasElement> | PointerEvent) {
    const tablet = this.tabletStroke;
    if (!this.isDrawing || !tablet || tablet.pointerId !== e.pointerId) return;

    this.quickShapeShift = e.shiftKey;
    const motion = tablet.contactPoints('nativeEvent' in e ? e.nativeEvent : e);
    if (this.quickShapeCurrent) {
      if (motion.lifted) this.finishInterruptedStroke(tablet.pointerId);
      else this.adjustQuickShape(e.clientX, e.clientY);
      return;
    }
    if (this.callbacks.coalesceTouch && e.pointerType === 'touch' && !motion.lifted && motion.runs.length === 1) {
      const samples = motion.runs[0];
      if (this.touchMotion.length + samples.length > 256) this.flushTouchMotion();
      if (samples.length > 256) {
        this.applyMotion(tablet, motion);
      } else if (samples.length > 0) {
        this.touchMotion.push(...samples);
        this.onNeedsRender?.();
      }
      return;
    }
    this.flushTouchMotion();
    this.applyMotion(tablet, motion);
  }

  private flushTouchMotion() {
    if (!this.touchMotion.length) return;
    const run = this.touchMotion;
    this.touchMotion = [];
    if (this.tabletStroke) this.applyMotion(this.tabletStroke, { runs: [run], lifted: false });
  }

  private applyMotion(tablet: TabletStroke, { runs, lifted }: TabletMotion) {
    if (this.quickShapeCurrent) {
      if (lifted) this.finishInterruptedStroke(tablet.pointerId);
      else {
        const last = runs.at(-1)?.at(-1);
        if (last) this.adjustQuickShape(last.clientX, last.clientY);
      }
      return;
    }
    // A tablet contact gap is kept as separate painted segments, so it cannot become one shape.
    if (runs.length > 1) this.quickShapeAllowed = false;
    const rulerMgr = RulerManager.getInstance();
    const props = this.strokeProps!;
    const shouldSnap = props.snapToRuler !== false;

    runs.forEach((contactEvents, index) => {
      if (contactEvents.length === 0) return;
      if (!this.lastValidPoint) {
        if (tablet.hasNativeMotion) {
          this.beginStroke(tablet, contactEvents[0]);
          contactEvents = contactEvents.slice(1);
          index = 0;
        } else {
          this.beginStroke(tablet, tablet.initialPoint);
        }
        if (contactEvents.length === 0) return;
      }
      let time = this.lastEventTime;
      const points: RawPoint[] = contactEvents.map((ev) => {
        const local = this.viewport.screenToCanvas(ev.clientX, ev.clientY);
        const snapped = shouldSnap ? rulerMgr.snapPoint(local) : { point: local, snapped: false };
        const pressure = tablet.pressure(ev).normalized;
        this.trackQuickShapePoint({ ...local, pressure });
        const capturedAt = eventTime(ev);
        time = capturedAt > time ? capturedAt : time + 0.5;
        return {
          x: snapped.point.x,
          y: snapped.point.y,
          pressure: this.eraserProps && !tablet.isPen && !tablet.isTouchSimulated ? 1 : pressure,
          tiltX: ev.tiltX,
          tiltY: ev.tiltY,
          twist: ev.twist,
          time,
        };
      });
      if (index > 0 && tablet.curve) {
        this.engine.setPressureCurve(tablet.curve, tablet.isPen);
      }

      if (index > 0) {
        // Finish the last known path without drawing across the location gap. Both runs stay in one undo step.
        this.flushPendingSpikePoints(true);
        this.flushFrameDabs();
        this.emitDabs(this.engine.finishStroke(this.lastValidPoint ?? undefined), this.strokeId, false, false);
        this.resetTailTaperState(points[0]);
        this.emitDabs(this.engine.startSegment(points[0]), this.strokeId, false, false);
        this.lastValidPoint = points[0];
      }
      this.lastEventTime = points[points.length - 1].time ?? this.lastEventTime;
      const filteredPoints = this.filterPenTailPoints(index > 0 ? points.slice(1) : points, tablet.isPen);
      if (filteredPoints.length > 0) {
        this.lastValidPoint = filteredPoints[filteredPoints.length - 1];
        this.queueFrameDabs(this.engine.addRawPoints(filteredPoints));
      }
    });

    // Release ends the stroke at its last recorded contact point.
    if (lifted) this.finishInterruptedStroke(tablet.pointerId);
  }

  private resetTailTaperState(initialPoint?: RawPoint) {
    const p = initialPoint?.pressure ?? 0;
    this.strokePeakPressure = p;
    this.prevPositivePressure = p > 0 ? p : 0;
    this.inTailTaper = false;
    this.taperLowPressure = 1;
    this.taperLowTime = initialPoint?.time ?? this.lastEventTime;
    this.pendingSpikePoints = [];
  }

  private filterPenTailPoints(points: RawPoint[], isPen: boolean): RawPoint[] {
    if (!isPen) return points;
    const accepted: RawPoint[] = [];
    for (const pt of points) {
      const p = pt.pressure;
      const t = pt.time ?? this.lastEventTime;

      if (this.inTailTaper) {
        const spikeCeiling = Math.max(this.taperLowPressure + 0.035, this.taperLowPressure * 1.35);
        if (p <= spikeCeiling && p < 0.18) {
          if (this.pendingSpikePoints.length > 0) {
            for (const sp of this.pendingSpikePoints) {
              accepted.push({ ...sp, pressure: Math.min(sp.pressure, this.taperLowPressure) });
            }
            this.pendingSpikePoints = [];
          }
          if (p > 0 && p < this.taperLowPressure) {
            this.taperLowPressure = p;
          }
          this.taperLowTime = t;
          if (p > 0) this.prevPositivePressure = p;
          accepted.push(pt);
          continue;
        }

        const dt = t - this.taperLowTime;
        if (this.pendingSpikePoints.length < 2 && dt <= 32) {
          this.pendingSpikePoints.push(pt);
          continue;
        }

        for (const sp of this.pendingSpikePoints) {
          this.strokePeakPressure = Math.max(this.strokePeakPressure, sp.pressure);
          if (sp.pressure > 0) this.prevPositivePressure = sp.pressure;
          accepted.push(sp);
        }
        this.pendingSpikePoints = [];
        if (p > 0 && p < 0.18) {
          this.inTailTaper = true;
          this.taperLowPressure = p;
          this.taperLowTime = t;
        } else {
          this.inTailTaper = false;
          this.taperLowPressure = 1;
        }
        this.strokePeakPressure = Math.max(this.strokePeakPressure, p);
        if (p > 0) this.prevPositivePressure = p;
        accepted.push(pt);
        continue;
      }

      if (
        this.strokePeakPressure >= 0.12 &&
        p > 0 &&
        p < 0.18 &&
        p <= this.strokePeakPressure * 0.65 &&
        p <= this.prevPositivePressure
      ) {
        this.inTailTaper = true;
        this.taperLowPressure = p;
        this.taperLowTime = t;
      } else {
        this.strokePeakPressure = Math.max(this.strokePeakPressure, p);
      }
      if (p > 0) this.prevPositivePressure = p;
      accepted.push(pt);
    }
    return accepted;
  }

  private flushPendingSpikePoints(clamp: boolean) {
    if (this.pendingSpikePoints.length === 0) return;
    const toFlush = clamp
      ? this.pendingSpikePoints.map((sp) => ({
          ...sp,
          pressure: Math.min(sp.pressure, this.taperLowPressure),
        }))
      : this.pendingSpikePoints;
    this.pendingSpikePoints = [];
    this.lastValidPoint = toFlush[toFlush.length - 1];
    this.lastEventTime = this.lastValidPoint.time ?? this.lastEventTime;
    this.queueFrameDabs(this.engine.addRawPoints(toFlush));
  }

  public finishInterruptedStroke(pointerId: number) {
    const tablet = this.tabletStroke;
    if (!this.isDrawing || !tablet || tablet.pointerId !== pointerId) return;
    this.flushTouchMotion();
    this.isDrawing = false;
    this.clearPendingRelease();
    this.motionPending = false;
    this.tabletStroke = null;
    tablet.finish();
    if (this.quickShapeCurrent) {
      if (this.strokeProps?.snapToRuler !== false) RulerManager.getInstance().onStrokeEnd();
      this.emitQuickShapePreview(true);
      this.emitDabs(new Float32Array(), this.strokeId, false, true);
      return;
    }
    this.flushPendingSpikePoints(true);
    if (!this.lastValidPoint) {
      this.cancelStroke();
      return;
    }
    const props = this.strokeProps!;
    if (props.snapToRuler !== false) RulerManager.getInstance().onStrokeEnd();
    const endPt = tablet.isPen && !tablet.hasNativeMotion && props.brushType !== 'pen' && props.minSize > 0
      ? { ...this.lastValidPoint, pressure: Math.min(this.lastValidPoint.pressure, Math.max(0.04, this.lastValidPoint.pressure * 0.55)) }
      : this.lastValidPoint;
    this.flushFrameDabs();
    this.emitDabs(this.engine.finishStroke(endPt), this.strokeId, false, true);
  }

  /**
   * Handle pointer up event
   */
  public handlePointerUp(e: React.PointerEvent<HTMLCanvasElement> | PointerEvent) {
    const tablet = this.tabletStroke;
    if (!this.isDrawing || !tablet || tablet.pointerId !== e.pointerId) return;
    if (this.quickShapeCurrent) {
      this.finishInterruptedStroke(e.pointerId);
      return;
    }
    this.flushTouchMotion();
    const event = 'nativeEvent' in e ? e.nativeEvent : e;
    if (event.type === 'pointerup' && (tablet.hasNativeMotion || tablet.awaitingNativeStart)) {
      if (this.pendingRelease) return;
      const motion = tablet.contactPoints(event, true);
      this.applyMotion(tablet, { ...motion, lifted: tablet.hasNativeMotion && motion.lifted });
      if (!this.isDrawing) return;
      // Native IPC can arrive just after the terminal DOM event.
      this.pendingRelease = event;
      this.releaseTimer = setTimeout(() => this.finishPendingRelease(), 32);
      return;
    }
    this.completePointerUp(tablet, event);
  }

  public finishPendingRelease() {
    const event = this.pendingRelease;
    const tablet = this.tabletStroke;
    if (event && tablet) this.completePointerUp(tablet, event);
  }

  private clearPendingRelease() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    this.pendingRelease = undefined;
  }

  private completePointerUp(tablet: TabletStroke, e: PointerEvent) {
    this.clearPendingRelease();
    const motion = tablet.contactPoints(e);
    if (tablet.hasNativeMotion) {
      this.applyMotion(tablet, motion);
      return;
    }
    this.applyMotion(tablet, { ...motion, lifted: false });
    if (e.type === 'pointercancel') {
      this.finishInterruptedStroke(e.pointerId);
      return;
    }
    if (!this.lastValidPoint) this.beginStroke(tablet, tablet.initialPoint);
    if (e.pointerType !== 'touch') {
      // Up coordinates can be newer than the last position measured with contact.
      this.finishInterruptedStroke(e.pointerId);
      return;
    }
    // Clear synchronously before finishing so trailing hover/duplicate pointerup events cannot re-enter
    this.isDrawing = false;
    this.motionPending = false;
    this.tabletStroke = null;

    const props = this.strokeProps!;
    const shouldSnap = props.snapToRuler !== false;

    const localPt = this.viewport.screenToCanvas(e.clientX, e.clientY);
    const rulerMgr = RulerManager.getInstance();
    const snapped = shouldSnap ? rulerMgr.snapPoint(localPt) : { point: localPt, snapped: false };
    if (shouldSnap) rulerMgr.onStrokeEnd();

    const releasePressure = tablet.isTouchSimulated ? tablet.releasePressure(e).normalized : undefined;

    let finishPoint: RawPoint | undefined;
    if (this.lastValidPoint) {
      const dist = Math.hypot(snapped.point.x - this.lastValidPoint.x, snapped.point.y - this.lastValidPoint.y);
      const maxJump = Math.max(24, (props.size || 24) * 1.5);
      const endPressure = releasePressure !== undefined ? releasePressure : this.lastValidPoint.pressure;
      if (dist > maxJump * 2) {
        finishPoint = {
          ...this.lastValidPoint,
          pressure: endPressure,
          time: Math.max(this.lastEventTime + 1, eventTime(e)),
        };
      } else {
        finishPoint = {
          x: snapped.point.x,
          y: snapped.point.y,
          pressure: endPressure,
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          twist: e.twist,
          time: Math.max(this.lastEventTime + 1, eventTime(e)),
        };
      }
    } else {
      finishPoint = {
        x: snapped.point.x,
        y: snapped.point.y,
        pressure: releasePressure ?? tablet.pressure(e).normalized,
        tiltX: e.tiltX,
        tiltY: e.tiltY,
        twist: e.twist,
        time: Math.max(this.lastEventTime + 1, eventTime(e)),
      };
    }

    tablet.finish();
    const dabs = this.engine.finishStroke(finishPoint);
    this.flushFrameDabs();
    this.emitDabs(dabs, this.strokeId, false, true);
  }

  public cancelStroke() {
    this.clearQuickShape(true);
    this.touchMotion.length = 0;
    if (this.strokeInk) this.layerManager.releaseStrokeInk(this.strokeInk);
    this.strokeInk = undefined;
    this.clearPendingRelease();
    this.motionPending = false;
    this.frameDabs = [];
    this.frameDabFloats = 0;
    this.tabletStroke?.finish();
    this.tabletStroke = null;
    this.cancelledThroughStrokeId = this.strokeId;
    this.isDrawing = false;
    this.currentStrokePoints = [];
    this.pendingPreviewDabs = [];
    this.lastValidPoint = null;
    this.eraserProps = undefined;
    this.resetTailTaperState();
  }

  /** Points stamped so far in the stroke being drawn (live outline preview); not a copy */
  public getCurrentPoints(): ReadonlyArray<StrokePoint> {
    return this.currentStrokePoints;
  }

  public getIsDrawing() {
    return this.isDrawing;
  }

  public getIsAdjustingQuickShape() {
    return this.quickShapeCurrent !== undefined;
  }

  public destroy() {
    this.cancelStroke();
  }
}

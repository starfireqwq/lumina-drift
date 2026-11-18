import { BrushProperties, BrushRenderer } from './BrushRenderer';
import { CanvasViewport } from './Viewport';
import type { TileData } from '@atelier/shared';
import { LayerManager, type StrokeInk } from './LayerManager';
import { FLOATS_PER_DAB, RawPoint, StrokeWorkerEngine } from '../workers/stroke.worker';
import { RulerManager } from './RulerManager';
import { startTabletStroke, type TabletMotion, type TabletPoint, type TabletStroke } from './tabletInput';

/** When the pen was there (same clock as performance.now); some synthetic events report 0 */
const eventTime = (e: { timeStamp?: number }) => (e.timeStamp && e.timeStamp > 0 ? e.timeStamp : performance.now());
const maxFrameDabFloats = 500 * FLOATS_PER_DAB;
const isDesktopInput = () => typeof window !== 'undefined' && Boolean(
  (window as { atelierDesktop?: { isElectron?: boolean } }).atelierDesktop?.isElectron,
);

export interface StrokePipelineCallbacks {
  onEmitPreviewDabs?: (dabs: Array<{ x: number; y: number; pressure: number }>, isEraser: boolean) => void;
  onCommitStroke?: (strokeData: any, inkTiles?: Promise<TileData[]>) => void;
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
  private currentStrokePoints: Array<{ x: number; y: number; pressure: number }> = [];
  private lastValidPoint: RawPoint | null = null;
  private tabletStroke: TabletStroke | null = null;
  private motionPending = false;
  private onNeedsRender: (() => void) | null = null;

  public setOnNeedsRender(cb: (() => void) | null) {
    this.onNeedsRender = cb;
  }

  public hasPendingWork(): boolean {
    return this.motionPending || this.frameDabFloats > 0;
  }
  private frameDabs: Float32Array[] = [];
  private frameDabFloats = 0;
  private pendingRelease?: PointerEvent;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private eraserProps?: BrushProperties;
  private strokeInk?: StrokeInk;
  private strokeProps?: BrushProperties;
  private lastEventTime = 0;

  // Throttled preview dab buffer for socket streaming
  private pendingPreviewDabs: Array<{ x: number; y: number; pressure: number }> = [];
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
    if (this.activeLayerId !== layerId) this.flushFrameDabs();
    this.activeLayerId = layerId;
    this.brushRenderer.setMixerTileReader(
      layerId ? (col, row) => this.layerManager.readTileSync(layerId, col, row, 'after') : null
    );
  }

  public setCallbacks(callbacks: StrokePipelineCallbacks) {
    this.callbacks = callbacks;
  }

  public renderFrame() {
    if (this.motionPending && this.tabletStroke) {
      this.motionPending = false;
      const motion = this.tabletStroke.consumeMotion();
      if (motion) this.applyMotion(this.tabletStroke, motion);
    }
    this.flushFrameDabs();
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
              this.pendingPreviewDabs.push(origPt);

              const symPts = rulerMgr.getSymmetryPoints(origPt);
              // symPts[0] is the original point; subsequent entries are mirrored counterparts
              for (let s = 1; s < symPts.length; s++) {
                const sp = symPts[s];
                const symDab = { x: sp.x, y: sp.y, pressure: origPt.pressure };
                this.currentStrokePoints.push(symDab);
                this.pendingPreviewDabs.push(symDab);

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
              this.pendingPreviewDabs.push(pt);
            }
          }

          // Check throttled preview dab emission
          const now = performance.now();
          if (
            this.callbacks.onEmitPreviewDabs &&
            this.pendingPreviewDabs.length > 0 &&
            (now - this.lastPreviewEmitTime >= this.previewIntervalMs || isStart || isFinish)
          ) {
            this.callbacks.onEmitPreviewDabs([...this.pendingPreviewDabs], props.isEraser);
            this.pendingPreviewDabs = [];
            this.lastPreviewEmitTime = now;
          }
        }
      }
    }

    if (isFinish) {
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
    }
  }

  /**
   * Handle pointer down event
   */
  public handlePointerDown(e: React.PointerEvent<HTMLCanvasElement> | PointerEvent, eraserProps?: BrushProperties, captureInk = false) {
    if (!this.activeLayerId || this.isDrawing) return;

    const tablet = startTabletStroke(e);
    this.tabletStroke = tablet;
    this.eraserProps = eraserProps;
    if (captureInk && !eraserProps && !this.brushRenderer.getProperties().colorMixing) this.strokeInk = new Map();
    this.strokeId++;
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

    const pressure = this.eraserProps && !tablet.isPen ? 1 : tablet.pressure(initial).normalized;
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
        followSamples: props.stabilizerLevel === 0 && (tablet.hasNativeMotion || isDesktopInput()) && initial.pointerType !== 'touch',
        lowRateInput: !tablet.hasNativeMotion && !isDesktopInput(),
        scatter: props.scatter,
        pressureCurve: tablet.curve ?? props.pressureCurve,
        colorMixing: props.colorMixing,
        paintAmount: props.paintAmount,
        brushType: props.brushType,
        antiAlias: props.antiAlias,
        angleMode: props.angleMode,
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

    this.applyMotion(tablet, tablet.contactPoints('nativeEvent' in e ? e.nativeEvent : e));
  }

  private applyMotion(tablet: TabletStroke, { runs, lifted }: TabletMotion) {
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
        const capturedAt = eventTime(ev);
        time = capturedAt > time ? capturedAt : time + 0.5;
        return {
          x: snapped.point.x,
          y: snapped.point.y,
          pressure: this.eraserProps && !tablet.isPen ? 1 : pressure,
          tiltX: ev.tiltX,
          tiltY: ev.tiltY,
          twist: ev.twist,
          time,
        };
      });
      if (index > 0 && tablet.curve) {
        this.engine.setPressureCurve(tablet.curve, props.stabilizerLevel === 0 && (tablet.hasNativeMotion || isDesktopInput()));
      }

      if (index > 0) {
        // Finish the last known path without drawing across the location gap. Both runs stay in one undo step.
        this.flushFrameDabs();
        this.emitDabs(this.engine.finishStroke(this.lastValidPoint ?? undefined), this.strokeId, false, false);
        this.emitDabs(this.engine.startSegment(points[0]), this.strokeId, false, false);
      }
      this.lastEventTime = points[points.length - 1].time ?? this.lastEventTime;
      this.lastValidPoint = points[points.length - 1];
      this.queueFrameDabs(this.engine.addRawPoints(index > 0 ? points.slice(1) : points));
    });

    // Release ends the stroke at its last recorded contact point.
    if (lifted) this.finishInterruptedStroke(tablet.pointerId);
  }

  public finishInterruptedStroke(pointerId: number) {
    const tablet = this.tabletStroke;
    if (!this.isDrawing || !tablet || tablet.pointerId !== pointerId) return;
    this.isDrawing = false;
    this.clearPendingRelease();
    this.motionPending = false;
    this.tabletStroke = null;
    tablet.finish();
    if (!this.lastValidPoint) return;
    const props = this.strokeProps!;
    if (props.snapToRuler !== false) RulerManager.getInstance().onStrokeEnd();
    const endPt = tablet.isPen
      ? { ...this.lastValidPoint, pressure: props.brushType === 'pen' || props.minSize === 0
        ? 0
        : tablet.hasNativeMotion ? this.lastValidPoint.pressure : Math.max(0.04, this.lastValidPoint.pressure * 0.55) }
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

    let finishPoint: RawPoint | undefined;
    if (this.lastValidPoint) {
      const dist = Math.hypot(snapped.point.x - this.lastValidPoint.x, snapped.point.y - this.lastValidPoint.y);
      const maxJump = Math.max(24, (props.size || 24) * 1.5);
      if (dist > maxJump * 2) {
        finishPoint = this.lastValidPoint;
      } else {
        finishPoint = {
          x: snapped.point.x,
          y: snapped.point.y,
          pressure: this.lastValidPoint.pressure,
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
        pressure: tablet.pressure(e).normalized,
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
  }

  /** Points stamped so far in the stroke being drawn (live outline preview); not a copy */
  public getCurrentPoints(): ReadonlyArray<{ x: number; y: number; pressure: number }> {
    return this.currentStrokePoints;
  }

  public getIsDrawing() {
    return this.isDrawing;
  }

  public destroy() {
    this.cancelStroke();
  }
}

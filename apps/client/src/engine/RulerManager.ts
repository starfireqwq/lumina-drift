import {
  computeSymmetryPoints,
  ConcentricConfig,
  ParallelConfig,
  PerspectiveConfig,
  Point2D,
  RulerMode,
  snapConcentricPoint,
  snapParallelPoint,
  snapPerspectivePoint,
  SymmetryConfig,
} from '@atelier/shared';

export interface RulerState {
  mode: RulerMode;
  symmetry: SymmetryConfig;
  perspective: PerspectiveConfig;
  parallel: ParallelConfig;
  concentric: ConcentricConfig;
}

export type RulerChangeListener = (state: RulerState) => void;

export class RulerManager {
  private static instance: RulerManager | null = null;

  public state: RulerState = {
    mode: 'off',
    symmetry: {
      mode: '2-axis',
      axesCount: 6,
      centerX: 1024,
      centerY: 1024,
      kaleidoscope: false,
    },
    perspective: {
      mode: '2-point',
      horizonY: 1024,
      vp1: { x: 200, y: 1024 },
      vp2: { x: 1848, y: 1024 },
      vp3: { x: 1024, y: 2200 },
      snapThreshold: 40,
    },
    parallel: {
      angleDeg: 30,
      snapThreshold: 30,
    },
    concentric: {
      centerX: 1024,
      centerY: 1024,
      stepRadius: 50,
    },
  };

  private listeners: Set<RulerChangeListener> = new Set();
  private lockedConcentricRadius: number | null = null;
  private strokeAnchorPoint: Point2D | null = null;
  private perspectiveAxis: string | undefined;

  private constructor() {}

  public static getInstance(): RulerManager {
    if (!RulerManager.instance) {
      RulerManager.instance = new RulerManager();
    }
    return RulerManager.instance;
  }

  public subscribe(fn: RulerChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  public setMode(mode: RulerMode) {
    this.state.mode = mode;
    this.notify();
  }

  public updateSymmetry(partial: Partial<SymmetryConfig>) {
    this.state.symmetry = { ...this.state.symmetry, ...partial };
    this.notify();
  }

  public updatePerspective(partial: Partial<PerspectiveConfig>) {
    const previous = this.state.perspective;
    const horizonY = partial.horizonY ?? partial.vp1?.y ?? partial.vp2?.y ?? previous.horizonY;
    this.state.perspective = {
      ...previous, ...partial, horizonY,
      vp1: { x: partial.vp1?.x ?? previous.vp1.x, y: horizonY },
      vp2: { x: partial.vp2?.x ?? previous.vp2.x, y: horizonY },
    };
    this.notify();
  }

  public updateParallel(partial: Partial<ParallelConfig>) {
    this.state.parallel = { ...this.state.parallel, ...partial };
    this.notify();
  }

  public updateConcentric(partial: Partial<ConcentricConfig>) {
    this.state.concentric = { ...this.state.concentric, ...partial };
    this.notify();
  }

  public initDimensions(width: number, height: number) {
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    this.state.symmetry.centerX = cx;
    this.state.symmetry.centerY = cy;
    this.state.perspective.horizonY = cy;
    this.state.perspective.vp1 = { x: this.state.perspective.mode === '1-point' ? cx : Math.round(width * 0.1), y: cy };
    this.state.perspective.vp2 = { x: Math.round(width * 0.9), y: cy };
    this.state.perspective.vp3 = { x: cx, y: Math.round(height * 1.5) };
    this.state.concentric.centerX = cx;
    this.state.concentric.centerY = cy;
    this.notify();
  }

  /**
   * Called when a stroke begins to lock snapping anchors and concentric radius
   */
  public onStrokeStart(pt: Point2D) {
    this.strokeAnchorPoint = { ...pt };
    this.perspectiveAxis = undefined;

    if (this.state.mode === 'concentric') {
      const dx = pt.x - this.state.concentric.centerX;
      const dy = pt.y - this.state.concentric.centerY;
      this.lockedConcentricRadius = Math.hypot(dx, dy);
    } else {
      this.lockedConcentricRadius = null;
    }
  }

  /**
   * Called when a stroke ends
   */
  public onStrokeEnd() {
    this.strokeAnchorPoint = null;
    this.perspectiveAxis = undefined;
    this.lockedConcentricRadius = null;
  }

  /**
   * Transforms input stroke point to snapped point based on active ruler
   */
  public snapPoint(currentPt: Point2D): { point: Point2D; snapped: boolean; axisLabel?: string } {
    if (this.state.mode === 'off' || this.state.mode === 'symmetry') {
      return { point: currentPt, snapped: false };
    }

    const anchor = this.strokeAnchorPoint || currentPt;

    if (this.state.mode === 'perspective') {
      const snapped = snapPerspectivePoint(currentPt, anchor, this.state.perspective, this.perspectiveAxis);
      this.perspectiveAxis ??= snapped.axisLabel;
      return snapped.snapped ? snapped : { point: anchor, snapped: false };
    }

    if (this.state.mode === 'parallel') {
      const snapped = snapParallelPoint(currentPt, anchor, this.state.parallel.angleDeg);
      return { point: snapped, snapped: true, axisLabel: `${this.state.parallel.angleDeg}°` };
    }

    if (this.state.mode === 'concentric') {
      const { point, radius } = snapConcentricPoint(
        currentPt,
        { x: this.state.concentric.centerX, y: this.state.concentric.centerY },
        this.lockedConcentricRadius
      );
      return { point, snapped: true, axisLabel: `R=${Math.round(radius)}` };
    }

    return { point: currentPt, snapped: false };
  }

  /**
   * If symmetry ruler is active, returns all mirrored counterpart points for stamping
   */
  public getSymmetryPoints(pt: Point2D): Point2D[] {
    if (this.state.mode !== 'symmetry') {
      return [pt];
    }
    return computeSymmetryPoints(pt, this.state.symmetry);
  }
}

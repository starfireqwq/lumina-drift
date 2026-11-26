import {
  ActiveRulerMode,
  CanvasGuide,
  CanvasGuideAxis,
  computeSymmetryPoints,
  ConcentricConfig,
  createDefaultCurveRuler,
  CurveAnchorPoint,
  CurveRulerConfig,
  evaluateCurveSegment,
  GuidesConfig,
  LayerModel as Layer,
  LayerRulerMeta,
  LayerRulerScope,
  ParallelConfig,
  PerspectiveConfig,
  PerspectiveGridConfig,
  Point2D,
  RadialLineConfig,
  resolveActiveLayerRuler,
  RulerMode,
  snapConcentricPoint,
  snapCurveRulerPoint,
  snapParallelPoint,
  snapPerspectivePoint,
  snapRadialLinePoint,
  SymmetryConfig,
} from '@atelier/shared';

export interface BoundLayerRulerSource {
  ownerLayerId: string;
  ownerLayerName: string;
  scope: LayerRulerScope;
  enabled: boolean;
  editable: boolean;
}

export interface RulerState {
  mode: RulerMode;
  symmetry: SymmetryConfig;
  perspective: PerspectiveConfig & { grid: PerspectiveGridConfig };
  parallel: ParallelConfig;
  concentric: ConcentricConfig;
  radialLine: RadialLineConfig;
  curve: CurveRulerConfig;
  guides: GuidesConfig;
  boundSource: BoundLayerRulerSource | null;
}

export type RulerChangeListener = (state: RulerState) => void;

type RulerSettings = Omit<RulerState, 'guides' | 'boundSource'>;
type PerspectiveGridUpdate = Partial<Omit<PerspectiveGridConfig, 'planes'>> & {
  planes?: Partial<PerspectiveGridConfig['planes']>;
};
type LayerContextOptions = {
  canEditLayer?: (layer: Layer) => boolean;
  onCommitLayerRuler?: (layerId: string, ruler: LayerRulerMeta | null) => void;
  includeHiddenOwner?: boolean;
};

const rulerConfigByMode = {
  symmetry: 'symmetry',
  perspective: 'perspective',
  parallel: 'parallel',
  concentric: 'concentric',
  radial_line: 'radialLine',
  curve: 'curve',
} as const satisfies Record<ActiveRulerMode, keyof Omit<RulerSettings, 'mode'>>;

const defaultPerspectiveGrid: PerspectiveGridConfig = {
  enabled: false,
  planes: { xy: false, xz: true, yz: false },
  spacing: 80,
  opacity: 0.35,
};

function createDefaultRulerSettings(): RulerSettings {
  return {
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
      grid: structuredClone(defaultPerspectiveGrid),
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
    radialLine: { centerX: 1024, centerY: 1024, rayCount: 24, innerRadius: 0 },
    curve: createDefaultCurveRuler(2048, 2048),
  };
}

function createDetachedRulerState(settings: RulerSettings): RulerState {
  return {
    ...structuredClone(settings),
    guides: { visible: true, items: [], selectedIds: [] },
    boundSource: null,
  };
}

function resizeRulerSettings(settings: RulerSettings, width: number, height: number): Partial<RulerSettings> {
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const { perspective } = settings;
  return {
    symmetry: { ...settings.symmetry, centerX: cx, centerY: cy },
    perspective: {
      ...perspective,
      horizonY: cy,
      vp1: { x: perspective.mode === '1-point' ? cx : Math.round(width * 0.1), y: cy },
      vp2: { x: Math.round(width * 0.9), y: cy },
      vp3: { x: cx, y: Math.round(height * 1.5) },
      grid: { ...perspective.grid, gridOrigin: { x: cx, y: Math.round(height * 0.78) } },
    },
    concentric: { ...settings.concentric, centerX: cx, centerY: cy },
    radialLine: { ...settings.radialLine, centerX: cx, centerY: cy },
    curve: createDefaultCurveRuler(width, height),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mergePerspectiveGrid(previous: PerspectiveGridConfig, partial: PerspectiveGridUpdate = {}): PerspectiveGridConfig {
  return {
    ...previous,
    ...partial,
    planes: { ...previous.planes, ...partial.planes },
    spacing: clamp(partial.spacing ?? previous.spacing, 20, 300),
    opacity: clamp(partial.opacity ?? previous.opacity ?? 0.35, 0.1, 0.9),
  };
}

function equalRulerValues(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys({ ...a, ...b }).every((key) => equalRulerValues(a[key], b[key]));
}

export class RulerManager {
  private static instance: RulerManager | null = null;

  private detachedState = createDefaultRulerSettings();
  public state = createDetachedRulerState(this.detachedState);
  private layerContext: LayerContextOptions = {};

  private listeners: Set<RulerChangeListener> = new Set();
  private lockedConcentricRadius: number | null = null;
  private strokeAnchorPoint: Point2D | null = null;
  private radialLineAnchor: Point2D | null = null;
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

  public syncLayerContext(activeLayerId: string | null, layers: readonly Layer[], opts?: LayerContextOptions) {
    this.layerContext = opts ?? {};
    const resolved = resolveActiveLayerRuler(activeLayerId, layers, { includeHiddenOwner: opts?.includeHiddenOwner });
    if (!resolved) {
      if (!this.state.boundSource) return;
      this.state = { ...this.state, ...structuredClone(this.detachedState), boundSource: null };
      this.notify();
      return;
    }

    const { ownerLayerId, ownerLayer, ruler } = resolved;
    const boundSource: BoundLayerRulerSource = {
      ownerLayerId,
      ownerLayerName: ownerLayer.name,
      scope: ruler.scope,
      enabled: ruler.enabled,
      editable: opts?.canEditLayer ? Boolean(opts.canEditLayer(ownerLayer)) : true,
    };
    const key = rulerConfigByMode[ruler.mode];
    const perspective = ruler.perspective ?? this.detachedState.perspective;
    const config: Partial<RulerSettings> = key === 'perspective'
      ? { perspective: { ...perspective, grid: mergePerspectiveGrid(defaultPerspectiveGrid, perspective.grid) } }
      : { [key]: ruler[key] ?? this.detachedState[key] };

    if (this.state.mode === ruler.mode && equalRulerValues(this.state[key], config[key]) &&
        equalRulerValues(this.state.boundSource, boundSource)) return;

    this.state = { ...this.state, ...structuredClone(config), mode: ruler.mode, boundSource };
    this.notify();
  }

  private canEditRuler(): boolean {
    return this.state.boundSource?.editable ?? true;
  }

  private updateRulerSettings(partial: Partial<RulerSettings>) {
    if (!this.canEditRuler()) return;
    const next = { ...this.state, ...structuredClone(partial) };
    if (equalRulerValues(this.state, next)) return;
    if (!next.boundSource) this.detachedState = { ...this.detachedState, ...structuredClone(partial) };
    this.state = next;
    this.notify();
  }

  public setMode(mode: RulerMode) {
    this.updateRulerSettings({ mode });
  }

  public updateSymmetry(partial: Partial<SymmetryConfig>) {
    this.updateRulerSettings({ symmetry: { ...this.state.symmetry, ...partial } });
  }

  public updatePerspective(partial: Partial<PerspectiveConfig>) {
    const previous = this.state.perspective;
    const horizonY = partial.horizonY ?? partial.vp1?.y ?? partial.vp2?.y ?? previous.horizonY;
    const perspective = {
      ...previous, ...partial, horizonY,
      vp1: { x: partial.vp1?.x ?? previous.vp1.x, y: horizonY },
      vp2: { x: partial.vp2?.x ?? previous.vp2.x, y: horizonY },
      grid: mergePerspectiveGrid(previous.grid, partial.grid),
    };
    this.updateRulerSettings({ perspective });
  }

  public updatePerspectiveGrid(partial: PerspectiveGridUpdate) {
    const previous = this.state.perspective;
    const grid = mergePerspectiveGrid(previous.grid, partial);
    this.updateRulerSettings({ perspective: { ...previous, grid } });
  }

  public updateParallel(partial: Partial<ParallelConfig>) {
    this.updateRulerSettings({ parallel: { ...this.state.parallel, ...partial } });
  }

  public updateConcentric(partial: Partial<ConcentricConfig>) {
    this.updateRulerSettings({ concentric: { ...this.state.concentric, ...partial } });
  }

  public updateRadialLine(partial: Partial<RadialLineConfig>) {
    const radialLine = { ...this.state.radialLine, ...partial };
    if (radialLine.rayCount !== undefined) radialLine.rayCount = Math.floor(clamp(radialLine.rayCount, 4, 72));
    if (radialLine.innerRadius !== undefined) radialLine.innerRadius = Math.max(0, radialLine.innerRadius);
    this.updateRulerSettings({ radialLine });
  }

  public updateCurve(partial: Partial<CurveRulerConfig>) {
    if (partial.anchors && (partial.anchors.length < 2 || partial.anchors.length > 64)) return;
    this.updateRulerSettings({ curve: { ...this.state.curve, ...partial } });
  }

  public updateCurveAnchor(anchorId: string, partial: Partial<Omit<CurveAnchorPoint, 'id'>>) {
    const anchors = this.state.curve.anchors.map((anchor) =>
      anchor.id === anchorId ? { ...anchor, ...partial, id: anchor.id } : anchor);
    this.updateCurve({ anchors });
  }

  public addCurveAnchor(pt?: Point2D, afterIndex?: number): CurveAnchorPoint | null {
    const curve = this.state.curve;
    const { anchors, closed } = curve;
    if (!this.canEditRuler() || anchors.length >= 64) return null;

    const lastIndex = anchors.length - 1;
    const index = afterIndex === undefined || !Number.isFinite(afterIndex)
      ? (pt || closed ? lastIndex : lastIndex - 1)
      : clamp(Math.trunc(afterIndex), -1, lastIndex);
    const hasSegment = index >= 0 && (index < lastIndex || closed);
    const before = anchors[index];
    const after = anchors[index + 1];
    const neighbor = before ?? after ?? { x: this.state.radialLine.centerX, y: this.state.radialLine.centerY };
    const point = pt ?? (hasSegment ? evaluateCurveSegment(curve, index, 0.5)
      : { x: neighbor.x + (before ? 48 : -48), y: neighbor.y });
    const start = hasSegment ? evaluateCurveSegment(curve, index, 0.4) : before ?? point;
    const end = hasSegment ? evaluateCurveSegment(curve, index, 0.6) : after ?? point;
    const tangent = { x: (end.x - start.x) / 2, y: (end.y - start.y) / 2 };
    const handle = Math.hypot(tangent.x, tangent.y) > 1e-3 ? tangent : { x: 24, y: 0 };

    const ids = new Set(anchors.map(({ id }) => id));
    let nextId = anchors.length + 1;
    while (ids.has(`c${nextId}`)) nextId++;
    const anchor: CurveAnchorPoint = {
      id: `c${nextId}`,
      x: point.x,
      y: point.y,
      handleIn: { x: point.x - handle.x, y: point.y - handle.y },
      handleOut: { x: point.x + handle.x, y: point.y + handle.y },
    };
    this.updateCurve({ anchors: [...anchors.slice(0, index + 1), anchor, ...anchors.slice(index + 1)] });
    return anchor;
  }

  public removeCurveAnchor(anchorId: string): boolean {
    const { anchors } = this.state.curve;
    if (!this.canEditRuler() || anchors.length <= 2) return false;
    const next = anchors.filter((anchor) => anchor.id !== anchorId);
    if (next.length < 2 || next.length === anchors.length) return false;
    this.updateCurve({ anchors: next });
    return true;
  }

  public resetCurveToCanvas(width: number, height: number) {
    this.updateRulerSettings({ curve: createDefaultCurveRuler(width, height) });
  }

  public initDimensions(width: number, height: number, opts?: { forceBound?: boolean }) {
    this.detachedState = { ...this.detachedState, ...resizeRulerSettings(this.detachedState, width, height) };
    const settings = this.state.boundSource
      ? (opts?.forceBound && this.canEditRuler() ? resizeRulerSettings(this.state, width, height) : {})
      : structuredClone(this.detachedState);
    const previousGuides = this.state.guides;
    const guides = previousGuides.items.length === 0 ? previousGuides : {
      ...previousGuides,
      items: previousGuides.items.map((g) => ({
        ...g,
        position: Math.max(0, Math.min(g.axis === 'x' ? width : height, Math.round(g.position))),
      })),
    };
    const next = { ...this.state, ...settings, guides };
    if (equalRulerValues(this.state, next)) return;
    this.state = next;
    this.notify();
  }

  public exportCurrentAsLayerRuler(scope: LayerRulerScope = 'same_folder', enabled = true): LayerRulerMeta | null {
    const { mode } = this.state;
    if (mode === 'off') return null;
    const key = rulerConfigByMode[mode];
    return { mode, scope, enabled, [key]: structuredClone(this.state[key]) };
  }

  /** Clears the detached canvas ruler mode after transferring it onto a layer/folder. */
  public clearDetachedMode() {
    this.detachedState = { ...this.detachedState, mode: 'off' };
    if (!this.state.boundSource && this.state.mode !== 'off') {
      this.state = { ...this.state, mode: 'off' };
      this.notify();
    }
  }

  public commitBoundLayerRuler(override?: Partial<Pick<LayerRulerMeta, 'scope' | 'enabled'>>): boolean {
    const { boundSource } = this.state;
    const { onCommitLayerRuler } = this.layerContext;
    if (!boundSource?.editable || !onCommitLayerRuler) return false;

    const scope = override?.scope ?? boundSource.scope;
    const enabled = override?.enabled ?? boundSource.enabled;
    const ruler = this.exportCurrentAsLayerRuler(scope, enabled);
    onCommitLayerRuler(boundSource.ownerLayerId, ruler);
    if (ruler && this.state.boundSource === boundSource && (scope !== boundSource.scope || enabled !== boundSource.enabled)) {
      this.state = { ...this.state, boundSource: { ...boundSource, scope, enabled } };
      this.notify();
    }
    return true;
  }

  public resetState(width = 2048, height = 2048) {
    this.detachedState = createDefaultRulerSettings();
    if (width !== 2048 || height !== 2048) {
      this.detachedState = { ...this.detachedState, ...resizeRulerSettings(this.detachedState, width, height) };
    }
    this.state = createDetachedRulerState(this.detachedState);
    this.layerContext = {};
    this.onStrokeEnd();
    this.notify();
  }

  public setGuidesVisible(visible: boolean) {
    if (this.state.guides.visible === visible) return;
    this.state.guides = { ...this.state.guides, visible };
    this.notify();
  }

  public addGuide(axis: CanvasGuideAxis, position: number): CanvasGuide {
    const guide: CanvasGuide = {
      id: `guide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      axis,
      position: Math.round(position),
      locked: false,
    };
    this.state.guides = {
      ...this.state.guides,
      visible: true,
      items: [...this.state.guides.items, guide],
    };
    this.notify();
    return guide;
  }

  public updateGuide(id: string, partial: Partial<Pick<CanvasGuide, 'position' | 'locked'>>) {
    let changed = false;
    const nextItems = this.state.guides.items.map((g) => {
      if (g.id !== id) return g;
      changed = true;
      return {
        ...g,
        ...(partial.position !== undefined ? { position: Math.round(partial.position) } : {}),
        ...(partial.locked !== undefined ? { locked: partial.locked } : {}),
      };
    });
    if (!changed) return;
    this.state.guides = { ...this.state.guides, items: nextItems };
    this.notify();
  }

  public removeGuide(id: string) {
    const nextItems = this.state.guides.items.filter((g) => g.id !== id);
    if (nextItems.length === this.state.guides.items.length) return;
    this.state.guides = {
      ...this.state.guides,
      items: nextItems,
      selectedIds: this.state.guides.selectedIds.filter((sid) => sid !== id),
    };
    this.notify();
  }

  public clearGuides() {
    if (this.state.guides.items.length === 0 && this.state.guides.selectedIds.length === 0) return;
    this.state.guides = {
      ...this.state.guides,
      items: [],
      selectedIds: [],
    };
    this.notify();
  }

  public setSelectedGuides(ids: string[]) {
    const valid = new Set(this.state.guides.items.map((g) => g.id));
    const next = [...new Set(ids.filter((id) => valid.has(id)))];
    this.state.guides = { ...this.state.guides, selectedIds: next };
    this.notify();
  }

  public toggleGuideSelected(id: string, additive = false) {
    if (!this.state.guides.items.some((g) => g.id === id)) return;
    const prev = this.state.guides.selectedIds;
    const exists = prev.includes(id);
    const next = additive
      ? (exists ? prev.filter((sid) => sid !== id) : [...prev, id])
      : (exists && prev.length === 1 ? [] : [id]);
    this.state.guides = { ...this.state.guides, selectedIds: next };
    this.notify();
  }

  public getActiveGuides(): CanvasGuide[] {
    if (!this.state.guides.visible) return [];
    return this.state.guides.items;
  }

  /**
   * Called when a stroke begins to lock snapping anchors and concentric radius
   */
  public onStrokeStart(pt: Point2D) {
    this.strokeAnchorPoint = { ...pt };
    this.radialLineAnchor = null;
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
    this.radialLineAnchor = null;
    this.perspectiveAxis = undefined;
    this.lockedConcentricRadius = null;
  }

  /**
   * Transforms input stroke point to snapped point based on active ruler
   */
  public snapPoint(currentPt: Point2D): { point: Point2D; snapped: boolean; axisLabel?: string } {
    if (this.state.mode === 'off' || this.state.mode === 'symmetry' || this.state.boundSource?.enabled === false) {
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

    if (this.state.mode === 'radial_line') {
      const config = this.state.radialLine;
      const { point, snapped, angleDeg } = snapRadialLinePoint(currentPt, this.radialLineAnchor ?? anchor, config);
      if (snapped && this.strokeAnchorPoint && !this.radialLineAnchor) {
        // A stroke that starts at the center gets its direction from the first usable sample.
        const atCenter = Math.hypot(anchor.x - config.centerX, anchor.y - config.centerY) < 1e-3;
        this.radialLineAnchor = atCenter ? { ...currentPt } : anchor;
      }
      return { point, snapped, axisLabel: angleDeg !== undefined ? `${Math.round(angleDeg)}°` : undefined };
    }

    if (this.state.mode === 'curve') {
      const { point, snapped } = snapCurveRulerPoint(currentPt, this.state.curve);
      return { point, snapped, axisLabel: snapped ? 'Curve' : undefined };
    }

    return { point: currentPt, snapped: false };
  }

  /**
   * If symmetry ruler is active, returns all mirrored counterpart points for stamping
   */
  public getSymmetryPoints(pt: Point2D): Point2D[] {
    if (this.state.mode !== 'symmetry' || this.state.boundSource?.enabled === false) {
      return [pt];
    }
    return computeSymmetryPoints(pt, this.state.symmetry);
  }
}

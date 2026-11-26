import type { LayerMeta, LayerType } from '../types/models';
import type {
  ConcentricConfig,
  CurveAnchorPoint,
  CurveRulerConfig,
  ParallelConfig,
  PerspectiveConfig,
  PerspectiveGridConfig,
  Point2D,
  RadialLineConfig,
  RulerMode,
  SymmetryConfig,
} from './ruler-math';

export type LayerRulerScope = 'all_layers' | 'same_folder' | 'target_layer';
export type ActiveRulerMode = Exclude<RulerMode, 'off'>;

export interface LayerRulerMeta {
  enabled: boolean;
  scope: LayerRulerScope;
  mode: ActiveRulerMode;
  symmetry?: SymmetryConfig;
  perspective?: PerspectiveConfig;
  parallel?: ParallelConfig;
  concentric?: ConcentricConfig;
  radialLine?: RadialLineConfig;
  curve?: CurveRulerConfig;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampCoordinate(value: number): number {
  return clamp(value, -1_000_000, 1_000_000);
}

function normalizeAngle(value: number): number {
  return (value % 360 + 360) % 360;
}

function normalizePoint(input: unknown): Point2D | null {
  const point = asRecord(input);
  if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null;
  return { x: clampCoordinate(point.x), y: clampCoordinate(point.y) };
}

function normalizeSymmetry(input: unknown): SymmetryConfig | null {
  const config = asRecord(input);
  if (!config) return null;
  const { mode, axesCount, centerX, centerY, angleDeg, kaleidoscope } = config;
  if ((mode !== '2-axis' && mode !== 'radial' && mode !== 'bilateral') ||
      !isFiniteNumber(axesCount) || !isFiniteNumber(centerX) || !isFiniteNumber(centerY) ||
      !isOptionalNumber(angleDeg) || (kaleidoscope !== undefined && typeof kaleidoscope !== 'boolean')) return null;
  return {
    mode,
    axesCount: Math.floor(clamp(axesCount, 2, 24)),
    centerX: clampCoordinate(centerX),
    centerY: clampCoordinate(centerY),
    ...(angleDeg === undefined ? {} : { angleDeg: normalizeAngle(angleDeg) }),
    ...(kaleidoscope === undefined ? {} : { kaleidoscope }),
  };
}

function normalizeGrid(input: unknown): PerspectiveGridConfig | null {
  const config = asRecord(input);
  if (!config) return null;
  const { enabled, spacing, opacity, gridOrigin } = config;
  const planes = asRecord(config.planes);
  if (typeof enabled !== 'boolean' || !isFiniteNumber(spacing) || !isOptionalNumber(opacity) ||
      !planes || typeof planes.xy !== 'boolean' || typeof planes.xz !== 'boolean' || typeof planes.yz !== 'boolean') return null;
  const origin = normalizePoint(gridOrigin);
  if (gridOrigin !== undefined && !origin) return null;
  return {
    enabled,
    planes: { xy: planes.xy, xz: planes.xz, yz: planes.yz },
    spacing: clamp(spacing, 20, 300),
    ...(origin ? { gridOrigin: origin } : {}),
    ...(opacity === undefined ? {} : { opacity: clamp(opacity, 0.1, 0.9) }),
  };
}

function normalizePerspective(input: unknown): PerspectiveConfig | null {
  const config = asRecord(input);
  if (!config) return null;
  const { mode, horizonY, snapThreshold } = config;
  if ((mode !== '1-point' && mode !== '2-point' && mode !== '3-point') ||
      !isFiniteNumber(horizonY) || !isOptionalNumber(snapThreshold)) return null;
  const vp1 = normalizePoint(config.vp1);
  const vp2 = normalizePoint(config.vp2);
  const vp3 = normalizePoint(config.vp3);
  const grid = normalizeGrid(config.grid);
  if (!vp1 || !vp2 || !vp3 || (config.grid !== undefined && !grid)) return null;
  return {
    mode, horizonY: clampCoordinate(horizonY), vp1, vp2, vp3,
    ...(snapThreshold === undefined ? {} : { snapThreshold: clamp(snapThreshold, 0, 200) }),
    ...(grid ? { grid } : {}),
  };
}

function normalizeParallel(input: unknown): ParallelConfig | null {
  const config = asRecord(input);
  if (!config || !isFiniteNumber(config.angleDeg) || !isOptionalNumber(config.snapThreshold)) return null;
  return {
    angleDeg: normalizeAngle(config.angleDeg),
    ...(config.snapThreshold === undefined ? {} : { snapThreshold: clamp(config.snapThreshold, 0, 200) }),
  };
}

function normalizeConcentric(input: unknown): ConcentricConfig | null {
  const config = asRecord(input);
  if (!config) return null;
  const { centerX, centerY, stepRadius } = config;
  if (!isFiniteNumber(centerX) || !isFiniteNumber(centerY) || !isOptionalNumber(stepRadius)) return null;
  return {
    centerX: clampCoordinate(centerX),
    centerY: clampCoordinate(centerY),
    ...(stepRadius === undefined ? {} : { stepRadius: clamp(stepRadius, 1, 4000) }),
  };
}

function normalizeRadialLine(input: unknown): RadialLineConfig | null {
  const config = asRecord(input);
  if (!config) return null;
  const { centerX, centerY, rayCount, innerRadius, snapThreshold } = config;
  if (!isFiniteNumber(centerX) || !isFiniteNumber(centerY) || !isOptionalNumber(rayCount) ||
      !isOptionalNumber(innerRadius) || !isOptionalNumber(snapThreshold)) return null;
  return {
    centerX: clampCoordinate(centerX),
    centerY: clampCoordinate(centerY),
    ...(rayCount === undefined ? {} : { rayCount: Math.floor(clamp(rayCount, 4, 72)) }),
    ...(innerRadius === undefined ? {} : { innerRadius: clamp(innerRadius, 0, 4000) }),
    ...(snapThreshold === undefined ? {} : { snapThreshold: clamp(snapThreshold, 0, 200) }),
  };
}

function normalizeCurve(input: unknown): CurveRulerConfig | null {
  const config = asRecord(input);
  if (!config) return null;
  const { curveType, closed, anchors, snapSamplesPerSegment } = config;
  if ((curveType !== 'bezier' && curveType !== 'quadratic' && curveType !== 'spline') ||
      typeof closed !== 'boolean' || !Array.isArray(anchors) || anchors.length < 2 || anchors.length > 64 ||
      !isOptionalNumber(snapSamplesPerSegment)) return null;

  const normalizedAnchors: CurveAnchorPoint[] = [];
  for (const inputAnchor of anchors) {
    const anchor = asRecord(inputAnchor);
    const point = normalizePoint(anchor);
    if (!point || !anchor || typeof anchor.id !== 'string' || !anchor.id.trim()) return null;
    const handleIn = normalizePoint(anchor.handleIn);
    const handleOut = normalizePoint(anchor.handleOut);
    if ((anchor.handleIn !== undefined && !handleIn) || (anchor.handleOut !== undefined && !handleOut)) return null;
    normalizedAnchors.push({
      id: anchor.id, ...point,
      ...(handleIn ? { handleIn } : {}),
      ...(handleOut ? { handleOut } : {}),
    });
  }
  return {
    curveType, closed, anchors: normalizedAnchors,
    ...(snapSamplesPerSegment === undefined ? {} : { snapSamplesPerSegment: Math.floor(clamp(snapSamplesPerSegment, 2, 256)) }),
  };
}

export function normalizeLayerRulerMeta(input: unknown): LayerRulerMeta | null {
  const ruler = asRecord(input);
  if (!ruler) return null;
  const { enabled = true, scope = 'same_folder', mode } = ruler;
  if (typeof enabled !== 'boolean' || (scope !== 'all_layers' && scope !== 'same_folder' && scope !== 'target_layer')) return null;
  const common = { enabled, scope } satisfies Pick<LayerRulerMeta, 'enabled' | 'scope'>;

  switch (mode) {
    case 'symmetry': {
      const symmetry = normalizeSymmetry(ruler.symmetry);
      return symmetry ? { ...common, mode, symmetry } : null;
    }
    case 'perspective': {
      const perspective = normalizePerspective(ruler.perspective);
      return perspective ? { ...common, mode, perspective } : null;
    }
    case 'parallel': {
      const parallel = normalizeParallel(ruler.parallel);
      return parallel ? { ...common, mode, parallel } : null;
    }
    case 'concentric': {
      const concentric = normalizeConcentric(ruler.concentric);
      return concentric ? { ...common, mode, concentric } : null;
    }
    case 'radial_line': {
      const radialLine = normalizeRadialLine(ruler.radialLine);
      return radialLine ? { ...common, mode, radialLine } : null;
    }
    case 'curve': {
      const curve = normalizeCurve(ruler.curve);
      return curve ? { ...common, mode, curve } : null;
    }
    default: return null;
  }
}

export interface LayerRulerNode {
  id: string;
  parentId?: string | null;
  layerType?: LayerType;
  isVisible?: boolean;
  orderIndex?: number;
  meta?: LayerMeta | null;
}

function* ancestorIds(layer: LayerRulerNode, layersById: ReadonlyMap<string, LayerRulerNode>): Iterable<string> {
  const visited = new Set([layer.id]);
  for (let id = layer.parentId; id && !visited.has(id); id = layersById.get(id)?.parentId) {
    visited.add(id);
    yield id;
  }
}

export function isLayerRulerEffectiveForLayer(
  ownerLayer: LayerRulerNode,
  activeLayerId: string | null,
  layersById: ReadonlyMap<string, LayerRulerNode>,
  opts?: { includeHiddenOwner?: boolean },
): boolean {
  const ruler = ownerLayer.meta?.ruler;
  if (!ruler?.enabled || !activeLayerId) return false;
  if (!opts?.includeHiddenOwner) {
    if (ownerLayer.isVisible === false) return false;
    for (const id of ancestorIds(ownerLayer, layersById)) {
      if (layersById.get(id)?.isVisible === false) return false;
    }
  }
  if (ruler.scope === 'all_layers') return true;
  if (ruler.scope === 'target_layer') return activeLayerId === ownerLayer.id;

  const active = activeLayerId === ownerLayer.id ? ownerLayer : layersById.get(activeLayerId);
  if (!active) return false;
  const folderId = ownerLayer.layerType === 'group' ? ownerLayer.id : ownerLayer.parentId ?? null;
  if (folderId === null) return active.parentId == null;
  if (active.id === folderId) return true;
  for (const id of ancestorIds(active, layersById)) {
    if (id === folderId) return true;
  }
  return false;
}

export function resolveActiveLayerRuler<T extends LayerRulerNode>(
  activeLayerId: string | null,
  layers: readonly T[],
  opts?: { includeHiddenOwner?: boolean },
): { ownerLayerId: string; ownerLayer: T; ruler: LayerRulerMeta } | null {
  if (!activeLayerId) return null;
  const layersById = new Map(layers.map((layer) => [layer.id, layer]));
  const active = layersById.get(activeLayerId);
  const effective = (ownerLayer: T) => {
    const ruler = ownerLayer.meta?.ruler;
    return ruler && isLayerRulerEffectiveForLayer(ownerLayer, activeLayerId, layersById, opts)
      ? { ownerLayerId: ownerLayer.id, ownerLayer, ruler }
      : null;
  };

  if (active) {
    const own = effective(active);
    if (own) return own;
    for (const id of ancestorIds(active, layersById)) {
      const ancestor = layersById.get(id);
      if (ancestor?.layerType !== 'group') continue;
      const inherited = effective(ancestor);
      if (inherited) return inherited;
    }
  }

  const ordered = layers.map((layer, index) => ({ layer, index }))
    .sort((a, b) => (b.layer.orderIndex ?? b.index) - (a.layer.orderIndex ?? a.index) || b.index - a.index);
  if (active) {
    for (const { layer } of ordered) {
      if (layer.id === active.id || layer.meta?.ruler?.scope !== 'same_folder' ||
          (layer.parentId ?? null) !== (active.parentId ?? null)) continue;
      const sibling = effective(layer);
      if (sibling) return sibling;
    }
  }
  for (const { layer } of ordered) {
    if (layer.meta?.ruler?.scope !== 'all_layers') continue;
    const global = effective(layer);
    if (global) return global;
  }
  return null;
}

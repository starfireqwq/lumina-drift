import type { RenderTexture, Sprite } from 'pixi.js';
import type { AdjustmentScope } from '@atelier/shared';
import type { AdjustmentFilter } from './adjustmentFilter';
import { computeSafeTextureScale } from './gpuProfile';

/** LayerManager's live state of one adjustment layer (see AdjustmentFilter) */
export interface AdjustmentView {
  /** Opaque canvas-sized quad: the filter input, its alpha after the masks is the coverage */
  quad: Sprite;
  filter: AdjustmentFilter;
  /** Parameters + blend mode + scope kind the filter was set up with ('' = not active) */
  paramsKey: string;
  scope: AdjustmentScope;
  /** Layers the scope composite depends on: members, their masks, clip bases and the bases' masks */
  dependencyIds: string[];
  /** Clip / group scope: the scope composite in canvas space, shown by an unrendered sprite */
  scopeRT: RenderTexture | null;
  scopeSprite: Sprite | null;
  /** Fingerprint of the dependencies scopeRT was rendered from, and what it covers (see adjustmentScopeIsFresh) */
  scopeKey: string;
  scopeMode: string;
}

/** Scope composites of bigger canvases are rendered at a lower resolution (≈ 64 MB per texture at most) */
export const MAX_SCOPE_PIXELS = 16_777_216;

export function adjustmentScopeRenderResolution(width: number, height: number, maxTextureSize = 4096, maxPixels = MAX_SCOPE_PIXELS): number {
  const { scale } = computeSafeTextureScale(width, height, maxTextureSize, maxPixels);
  return Math.ceil(width * scale) <= maxTextureSize && Math.ceil(height * scale) <= maxTextureSize
    ? scale : scale * (1 - Number.EPSILON);
}

/**
 * Whether a cached scope composite serves a render: rendered from the same dependencies, and
 * for the whole canvas ('full', composites / exports) or for this same on-screen tile grid.
 */
export function adjustmentScopeIsFresh(cachedKey: string, cachedMode: string, key: string, mode: string): boolean {
  return cachedKey !== '' && cachedKey === key && (cachedMode === 'full' || cachedMode === mode);
}

export interface ScopeDependencyState {
  id: string;
  /** LayerItem.version: bumps on every pixel change */
  version: number;
  visible: boolean;
  renderable: boolean;
  alpha: number;
  blendMode: string;
  clipToBelow: boolean;
  sortOrder: number;
  updatedAt: number;
  /** Display matrix a, b, c, d, tx, ty (animated transforms) */
  transform: readonly number[];
  /** Anything else that changes the look: nested adjustment params / scope, mask inversion, onion skin… */
  extra?: string;
}

/** Fingerprint of everything a scope composite is drawn from */
export function adjustmentScopeKey(kind: string, deps: readonly ScopeDependencyState[]): string {
  let key = kind;
  for (const d of deps) {
    key += `|${d.id}:${d.version}:${d.visible ? 1 : 0}${d.renderable ? 1 : 0}:${d.alpha}:${d.blendMode}:${d.clipToBelow ? 1 : 0}:${d.sortOrder}:${d.updatedAt}:${d.transform.join(',')}`;
    if (d.extra) key += `:${d.extra}`;
  }
  return key;
}

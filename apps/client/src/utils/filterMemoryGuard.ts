/**
 * Memory-protection and placement helpers for "Apply Filter to New Layer" (套用到新圖層).
 * Kept pure (no DOM / Pixi) so ui-logic.check.ts can verify thresholds, sparse tile pruning,
 * and above-active-layer placement rules.
 */

export type FilterCompositeMemoryTier = 'ok' | 'warn' | 'confirm' | 'block';

export interface FilterCompositeMemoryPlan {
  tier: FilterCompositeMemoryTier;
  pixels: number;
  /** Rough peak working RAM (MB) for compositing + filter worker + preview texture */
  estimatedMB: number;
  /** Force draft preview while sliding parameters to prevent UI stalls */
  forceDraft: boolean;
  /** Release the shared composite RenderTexture immediately after reading pixels */
  releaseCompositeAfterRead: boolean;
}

export const FILTER_COMPOSITE_LIMITS = {
  desktopWarnPx: 16_000_000,    // > 4000 × 4000
  desktopConfirmPx: 40_000_000, // > ~6325 × 6325 (e.g. 10000 × 8000 = 80M)
  touchWarnPx: 4_000_000,       // > 2000 × 2000
  touchConfirmPx: 12_000_000,   // > 4000 × 3000
  touchBlockPx: 16_000_000,     // > 4000 × 4000 on phones/tablets: prevent tab OOM
} as const;

export function assessFilterCompositeMemory(width: number, height: number, touch: boolean): FilterCompositeMemoryPlan {
  const pixels = Math.max(0, Math.round(width) * Math.round(height));
  // Composite buffer (4 B/px) + worker output (4 B/px) + preview texture (4 B/px) ≈ 12 B/px
  const estimatedMB = Math.max(1, Math.round((pixels * 12) / (1024 * 1024)));
  if (touch) {
    if (pixels > FILTER_COMPOSITE_LIMITS.touchBlockPx) {
      return { tier: 'block', pixels, estimatedMB, forceDraft: true, releaseCompositeAfterRead: true };
    }
    if (pixels > FILTER_COMPOSITE_LIMITS.touchConfirmPx) {
      return { tier: 'confirm', pixels, estimatedMB, forceDraft: true, releaseCompositeAfterRead: true };
    }
    if (pixels > FILTER_COMPOSITE_LIMITS.touchWarnPx) {
      return { tier: 'warn', pixels, estimatedMB, forceDraft: true, releaseCompositeAfterRead: true };
    }
    return { tier: 'ok', pixels, estimatedMB, forceDraft: false, releaseCompositeAfterRead: false };
  }
  if (pixels > FILTER_COMPOSITE_LIMITS.desktopConfirmPx) {
    return { tier: 'confirm', pixels, estimatedMB, forceDraft: true, releaseCompositeAfterRead: true };
  }
  if (pixels > FILTER_COMPOSITE_LIMITS.desktopWarnPx) {
    return { tier: 'warn', pixels, estimatedMB, forceDraft: true, releaseCompositeAfterRead: true };
  }
  return { tier: 'ok', pixels, estimatedMB, forceDraft: false, releaseCompositeAfterRead: false };
}

export interface TileCoordLike {
  col: number;
  row: number;
}

/**
 * Keeps only tiles that contain at least one pixel with alpha > 0, so applying a filter to a new
 * layer does not compress, store, or broadcast completely transparent tiles.
 */
export function filterNonEmptyTileCoords<T extends TileCoordLike>(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  tileSize: number,
  coords: readonly T[],
): T[] {
  const kept: T[] = [];
  for (const coord of coords) {
    const x0 = coord.col * tileSize;
    const y0 = coord.row * tileSize;
    const x1 = Math.min(width, x0 + tileSize);
    const y1 = Math.min(height, y0 + tileSize);
    let nonEmpty = false;
    outer: for (let y = y0; y < y1; y++) {
      let off = (y * width + x0) * 4 + 3;
      for (let x = x0; x < x1; x++, off += 4) {
        if (pixels[off] > 0) {
          nonEmpty = true;
          break outer;
        }
      }
    }
    if (nonEmpty) kept.push(coord);
  }
  return kept;
}

export interface MinimalLayerRef {
  id: string;
  layerType: string;
  parentId?: string | null;
  sortOrder: number;
}

/**
 * Picks where to insert the new filtered layer: directly above the active layer.
 * If the active layer is a mask, places it above its host layer instead of inside the mask slot.
 * If the active layer is a group, places it above the group as a sibling (parentId = group.parentId).
 */
export function filterNewLayerPlacement(
  active: MinimalLayerRef | null | undefined,
  layers: readonly MinimalLayerRef[],
): { afterLayerId: string | null; parentId: string | null | undefined; overlayZIndex: number } {
  const maxSort = layers.reduce((m, l) => Math.max(m, l.sortOrder), 0);
  if (!active) return { afterLayerId: null, parentId: undefined, overlayZIndex: maxSort + 0.5 };
  if (active.layerType === 'mask' && active.parentId) {
    const host = layers.find((l) => l.id === active.parentId);
    if (host) {
      return { afterLayerId: host.id, parentId: host.parentId ?? null, overlayZIndex: host.sortOrder + 0.5 };
    }
  }
  if (active.layerType === 'group') {
    // Find highest sortOrder within this group's descendants so the preview sits cleanly above the group
    const groupIds = new Set<string>([active.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of layers) {
        if (l.parentId && groupIds.has(l.parentId) && !groupIds.has(l.id)) {
          groupIds.add(l.id);
          changed = true;
        }
      }
    }
    let topSort = active.sortOrder;
    for (const l of layers) {
      if (groupIds.has(l.id) && l.sortOrder > topSort) topSort = l.sortOrder;
    }
    return { afterLayerId: active.id, parentId: active.parentId ?? null, overlayZIndex: topSort + 0.5 };
  }
  return { afterLayerId: active.id, parentId: undefined, overlayZIndex: active.sortOrder + 0.5 };
}

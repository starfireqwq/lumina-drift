import type { LayerModel } from '../types/models';

const compareLayerOrder = (a: LayerModel, b: LayerModel): number =>
  a.sortOrder - b.sortOrder ||
  (a.createdAt || 0) - (b.createdAt || 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface TidyLayerTreeResult<T extends LayerModel = LayerModel> {
  layers: T[];
  moved: boolean;
  orphanIds: string[];
}

/**
 * Ensures every group sits right above its own content (children keep their relative ascending
 * order, each followed by its own content), every mask sits right above its owner layer, and
 * dangling or cyclic `parentId` references are cleared.
 *
 * Output is ordered ascending (index 0 = bottommost, last = topmost) with clean 10-step sortOrders.
 */
export function tidyLayerModels<T extends LayerModel>(all: readonly T[]): TidyLayerTreeResult<T> {
  const byId = new Map(all.map((l) => [l.id, l]));
  const orphanIds: string[] = [];
  const parentOf = new Map<string, string | null>();

  for (const l of all) {
    if (l.layerType === 'mask') continue;
    const parent = l.parentId ? byId.get(l.parentId) : undefined;
    if (l.parentId && (!parent || parent.layerType !== 'group')) {
      orphanIds.push(l.id);
    }
    parentOf.set(l.id, parent?.layerType === 'group' ? parent.id : null);
  }

  // Cut any parent cycle
  const cycleBroken = new Set<string>();
  for (const l of all) {
    if (l.layerType === 'mask') continue;
    const seen = new Set<string>();
    for (let p = parentOf.get(l.id) ?? null; p; p = parentOf.get(p) ?? null) {
      if (p === l.id) {
        parentOf.set(l.id, null);
        cycleBroken.add(l.id);
        if (!orphanIds.includes(l.id)) orphanIds.push(l.id);
        break;
      }
      if (seen.has(p)) break;
      seen.add(p);
    }
  }

  const children = new Map<string | null, T[]>();
  const masksOf = new Map<string, T[]>();
  const strayMasks: T[] = [];

  for (const l of all) {
    if (l.layerType === 'mask') {
      const owner = l.parentId ? byId.get(l.parentId) : undefined;
      if (owner && owner.layerType !== 'mask') {
        const list = masksOf.get(owner.id);
        if (list) list.push(l);
        else masksOf.set(owner.id, [l]);
      } else {
        strayMasks.push(l);
      }
      continue;
    }
    const key = parentOf.get(l.id) ?? null;
    const list = children.get(key);
    if (list) list.push(l);
    else children.set(key, [l]);
  }

  const ordered: T[] = [...strayMasks.sort(compareLayerOrder)];
  const visited = new Set<string>();

  const emit = (l: T) => {
    if (visited.has(l.id)) return;
    visited.add(l.id);
    if (l.layerType === 'group') {
      const kids = children.get(l.id);
      if (kids) {
        for (const c of [...kids].sort(compareLayerOrder)) emit(c);
      }
    }
    ordered.push(l);
    const masks = masksOf.get(l.id);
    if (masks) {
      for (const m of [...masks].sort(compareLayerOrder)) ordered.push(m);
    }
  };

  const roots = children.get(null) ?? [];
  for (const root of [...roots].sort(compareLayerOrder)) {
    emit(root);
  }

  // Defensive fallback: if any non-mask somehow remained unvisited, append cleanly at root
  for (const l of [...all].sort(compareLayerOrder)) {
    if (l.layerType !== 'mask' && !visited.has(l.id)) {
      emit(l);
    }
  }

  const current = [...all].sort(compareLayerOrder);
  const moved = ordered.length !== current.length || ordered.some((l, i) => l.id !== current[i].id);
  const needsSortNormalization = ordered.some((l, i) => l.sortOrder !== (i + 1) * 10);

  if (!moved && orphanIds.length === 0 && !needsSortNormalization) {
    return { layers: ordered, moved: false, orphanIds: [] };
  }

  const orphanSet = new Set(orphanIds);
  const tidied = ordered.map((l, i) => {
    const nextOrder = (i + 1) * 10;
    const clearParent = l.layerType !== 'mask' && (orphanSet.has(l.id) || cycleBroken.has(l.id));
    if (l.sortOrder === nextOrder && !clearParent) return l;
    return {
      ...l,
      sortOrder: nextOrder,
      ...(clearParent ? { parentId: null } : {}),
    };
  });

  return { layers: tidied, moved: moved || needsSortNormalization, orphanIds };
}

/**
 * Filters a selection of layer IDs to only the top-level non-mask layers (omitting layers whose
 * ancestor group is already part of the selection so nested hierarchies stay intact).
 */
export function filterTopLevelSelectedLayers<T extends LayerModel>(
  all: readonly T[],
  selectedIds: Iterable<string>
): T[] {
  const idSet = new Set(selectedIds);
  const byId = new Map(all.map((l) => [l.id, l]));
  const picked = all.filter((l) => idSet.has(l.id) && l.layerType !== 'mask');
  const hasSelectedAncestor = (layer: T): boolean => {
    const seen = new Set<string>([layer.id]);
    for (let p = layer.parentId; p; p = byId.get(p)?.parentId ?? null) {
      if (seen.has(p)) break;
      seen.add(p);
      if (idSet.has(p)) return true;
    }
    return false;
  };
  return picked.filter((l) => !hasSelectedAncestor(l)).sort(compareLayerOrder);
}

/**
 * Walks up from `topLayer` to find its ancestor whose parent is `targetParentId`,
 * so inserting a new group above it keeps the group in the expected sibling slot.
 */
export function findTopAnchorForParent<T extends LayerModel>(
  all: readonly T[],
  topLayer: T,
  targetParentId: string | null
): T {
  const byId = new Map(all.map((l) => [l.id, l]));
  const seen = new Set<string>([topLayer.id]);
  let cur: T = topLayer;
  while ((cur.parentId ?? null) !== targetParentId) {
    const parentId = cur.parentId;
    if (!parentId || seen.has(parentId)) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    cur = parent;
  }
  return cur;
}

/**
 * Computes tidied bottom-to-top non-mask layer IDs suitable for `reorderLayers`.
 */
export function computeTidiedAscendingNonMaskIds(all: readonly LayerModel[]): string[] {
  return tidyLayerModels(all)
    .layers.filter((l) => l.layerType !== 'mask')
    .map((l) => l.id);
}

/** Moves the roots closest to the target first on each side so tidying keeps their order. */
export function orderLayersForReparenting<T extends LayerModel>(
  all: readonly T[],
  rootsAscending: readonly T[],
  targetGroupId: string | null,
): T[] {
  if (targetGroupId === null) return [...rootsAscending];

  const orderById = new Map(tidyLayerModels(all).layers.map((l) => [l.id, l.sortOrder]));
  const targetOrder = orderById.get(targetGroupId);
  if (targetOrder === undefined) return [...rootsAscending];

  const below: T[] = [];
  const above: T[] = [];
  for (const layer of rootsAscending) {
    const sortOrder = orderById.get(layer.id) ?? layer.sortOrder;
    (sortOrder < targetOrder ? below : above).push(layer);
  }
  return [...below.reverse(), ...above];
}

/** Plans the final order from the stack before any of the selected layers are moved. */
export function computeGroupedAscendingNonMaskIds(
  preGroupLayers: readonly LayerModel[],
  newGroup: LayerModel,
  anchorId: string,
  parentId: string | null,
  selectedRootIds: ReadonlySet<string>,
): string[] {
  const tidied = tidyLayerModels(preGroupLayers.filter((l) => l.id !== newGroup.id)).layers;
  const anchor = tidied.find((l) => l.id === anchorId);
  const sortOrder = anchor ? anchor.sortOrder + 5 : (tidied.length + 1) * 10;
  const patched = tidied.map((l) => selectedRootIds.has(l.id) ? { ...l, parentId: newGroup.id } : l);
  return computeTidiedAscendingNonMaskIds([...patched, { ...newGroup, parentId, sortOrder }]);
}

/**
 * Selects a contiguous slice of visible layer IDs between `anchorId` and `targetId`.
 * When `additive` is true, unions the range with `existing`.
 */
export function selectLayerRange(
  orderedIds: readonly string[],
  anchorId: string | null | undefined,
  targetId: string,
  additive = false,
  existing?: ReadonlySet<string>
): Set<string> {
  const result = additive && existing ? new Set(existing) : new Set<string>();
  const targetIdx = orderedIds.indexOf(targetId);
  if (targetIdx < 0) {
    result.add(targetId);
    return result;
  }
  const anchorIdx = anchorId ? orderedIds.indexOf(anchorId) : -1;
  if (anchorIdx < 0) {
    result.add(targetId);
    return result;
  }
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  for (let i = start; i <= end; i++) {
    result.add(orderedIds[i]);
  }
  return result;
}


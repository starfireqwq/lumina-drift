import type { LayerModel } from '../types/models';

type ScopeLayer = Pick<LayerModel, 'id' | 'parentId' | 'layerType' | 'sortOrder' | 'clipToBelow' | 'createdAt'>;

export type AdjustmentScope =
  | { kind: 'root' }
  | { kind: 'clip'; baseId: string; memberIds: string[] }
  | { kind: 'group'; groupId: string; memberIds: string[] }
  | { kind: 'none' };

function orderedDrawables(layers: readonly ScopeLayer[]): ScopeLayer[] {
  return layers
    .filter(({ layerType }) => layerType !== 'group' && layerType !== 'mask')
    .sort((a, b) => a.sortOrder - b.sortOrder ||
      (a.createdAt || 0) - (b.createdAt || 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function clipBaseIndex(drawables: readonly ScopeLayer[], index: number): number {
  if (!drawables[index]?.clipToBelow) return -1;
  let base = index - 1;
  while (base >= 0 && drawables[base].clipToBelow) base--;
  return base;
}

export function adjustmentClipBaseId(layers: readonly ScopeLayer[], layerId: string): string | null {
  const drawables = orderedDrawables(layers);
  const index = drawables.findIndex(({ id }) => id === layerId);
  return drawables[clipBaseIndex(drawables, index)]?.id ?? null;
}

function belongsToGroup(layer: ScopeLayer, groupId: string, byId: Map<string, ScopeLayer>): boolean {
  const visited = new Set<string>([layer.id]);
  let parentId = layer.parentId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === groupId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

export function resolveAdjustmentScope(layers: readonly ScopeLayer[], adjustmentId: string): AdjustmentScope {
  const drawables = orderedDrawables(layers);
  const index = drawables.findIndex(({ id }) => id === adjustmentId);
  const adjustment = drawables[index];
  if (adjustment?.layerType !== 'adjustment') return { kind: 'none' };

  const base = clipBaseIndex(drawables, index);
  if (base >= 0) {
    return { kind: 'clip', baseId: drawables[base].id, memberIds: drawables.slice(base, index).map(({ id }) => id) };
  }

  if (adjustment.parentId) {
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const groupId = adjustment.parentId;
    if (byId.get(groupId)?.layerType === 'group') {
      const memberIds = drawables.slice(0, index)
        .filter((layer) => belongsToGroup(layer, groupId, byId))
        .map(({ id }) => id);
      return { kind: 'group', groupId, memberIds };
    }
  }
  return { kind: 'root' };
}

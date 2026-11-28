import type { LayerModel } from '@atelier/shared';
import { hasActiveLayerEffects, type AdjustmentScope } from '@atelier/shared';

type ClipLayer = Pick<LayerModel, 'id' | 'parentId' | 'sortOrder' | 'layerType' | 'clipToBelow'>;

export function resolveLayerClipBases(layers: readonly ClipLayer[]): Map<string, string | null> {
  const bases = new Map<string | null, string>();
  const result = new Map<string, string | null>();
  for (const layer of [...layers].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (layer.layerType === 'mask') continue;
    const parentId = layer.parentId ?? null;
    result.set(layer.id, layer.clipToBelow ? bases.get(parentId) ?? null : null);
    if (!layer.clipToBelow) bases.set(parentId, layer.id);
  }
  return result;
}

export class LayerHierarchy {
  readonly byId: ReadonlyMap<string, LayerModel>;
  readonly clipBases: ReadonlyMap<string, string | null>;
  readonly baseIds: ReadonlySet<string>;
  private readonly children = new Map<string | null, LayerModel[]>();

  constructor(layers: readonly LayerModel[]) {
    this.byId = new Map(layers.map((layer) => [layer.id, layer]));
    this.clipBases = resolveLayerClipBases([...this.byId.values()]);
    this.baseIds = new Set([...this.clipBases.values()].filter((id): id is string => id !== null));
    for (const layer of [...this.byId.values()].sort((a, b) => a.sortOrder - b.sortOrder)) {
      if (layer.layerType === 'mask') continue;
      const parentId = this.parentOf(layer)?.id ?? null;
      const siblings = this.children.get(parentId);
      if (siblings) siblings.push(layer);
      else this.children.set(parentId, [layer]);
    }
  }

  parentOf(layer: LayerModel): LayerModel | undefined {
    return layer.parentId ? this.byId.get(layer.parentId) : undefined;
  }

  *ancestors(layer: LayerModel): Generator<LayerModel> {
    const seen = new Set([layer.id]);
    for (let parent = this.parentOf(layer); parent && !seen.has(parent.id); parent = this.parentOf(parent)) {
      seen.add(parent.id);
      yield parent;
    }
  }

  childrenOf(id: string | null): readonly LayerModel[] {
    return this.children.get(id) ?? [];
  }

  *descendants(id: string | null): Generator<LayerModel> {
    for (const child of this.childrenOf(id)) {
      yield child;
      if (child.layerType === 'group') yield* this.descendants(child.id);
    }
  }

  clipBase(layer: LayerModel): LayerModel | undefined {
    const id = this.clipBases.get(layer.id);
    return id ? this.byId.get(id) : undefined;
  }

  visible(layer: LayerModel): boolean {
    for (const node of [layer, ...this.ancestors(layer)]) {
      if (!node.isVisible || this.clipBase(node)?.isVisible === false) return false;
    }
    return true;
  }

  visibleGroupLayers(id: string): LayerModel[] {
    const group = this.byId.get(id);
    if (group?.layerType !== 'group' || !this.visible(group)) return [];
    return [...this.descendants(id)].filter((layer) =>
      layer.layerType !== 'group' && layer.layerType !== 'adjustment' && this.visible(layer));
  }

  isolatedGroups(masked: ReadonlySet<string>, hasEffects = (group: LayerModel) => hasActiveLayerEffects(group.meta?.effects)): Set<string> {
    const isolated = new Set<string>();
    for (const layer of this.descendants(null)) {
      if (layer.layerType !== 'group') continue;
      if (hasEffects(layer) || layer.blendMode !== 'normal' || layer.clipToBelow || this.baseIds.has(layer.id) ||
          (masked.has(layer.id) && [...this.ancestors(layer)].some((parent) => isolated.has(parent.id)))) {
        isolated.add(layer.id);
      }
    }
    return isolated;
  }

  adjustmentScope(layer: LayerModel): AdjustmentScope {
    const parent = this.parentOf(layer);
    const siblings = this.childrenOf(parent?.id ?? null);
    const below = siblings.slice(0, siblings.indexOf(layer));
    const base = this.clipBase(layer);
    if (!base && parent?.layerType !== 'group') return { kind: 'root' };
    const members = base ? below.slice(below.indexOf(base)) : below;
    const memberIds = members.flatMap((member) => member.layerType === 'group'
      ? [...this.descendants(member.id)].filter((child) => child.layerType !== 'group').map((child) => child.id)
      : [member.id]);
    return base ? { kind: 'clip', baseId: base.id, memberIds } : { kind: 'group', groupId: parent!.id, memberIds };
  }
}

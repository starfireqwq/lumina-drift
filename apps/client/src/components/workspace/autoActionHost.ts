import type { LayerModel, LayerPropsSnapshot, ScopedUndoOp } from '@atelier/shared';
import { AutoActionStepError, type AutoActionErrorCode, type AutoActionHost, type AutoActionStep } from '../../engine/ActionRecorder';
import type { ScopedUndoManager } from '../../engine/ScopedUndoManager';

type Params<K extends AutoActionStep['kind']> = Extract<AutoActionStep, { kind: K }>['params'];
type MergeResult = boolean | 'no_layer_below';

export interface AutoActionHostDeps {
  undo: Pick<ScopedUndoManager, 'beginGroup' | 'endGroup' | 'countGroupOps' | 'getLatestUndoGroup' | 'discardRedoGroup' | 'push'>;
  undoNow(groupId: string): Promise<void>;
  getUserId(): string;
  isReadOnly(): boolean;
  getActiveLayer(): LayerModel | null;
  canManageLayer(layer: LayerModel): boolean;
  canEditPixels(layer: LayerModel): boolean;
  resolveLayerName(key: NonNullable<Params<'layer.new'>['nameKey']>): string;
  createLayer(anchor: LayerModel, props: Omit<Params<'layer.new'>, 'nameKey'>): Promise<boolean>;
  duplicateLayer(layer: LayerModel): Promise<boolean>;
  mergeDown(layer: LayerModel): Promise<MergeResult>;
  deleteLayer(layer: LayerModel): Promise<boolean>;
  updateLayerProps(layerId: string, props: LayerPropsSnapshot): Promise<boolean>;
  applyFilter(layer: LayerModel, params: Params<'filter.apply'>): Promise<'ok' | 'unchanged' | AutoActionErrorCode>;
  createAdjustmentLayer(anchor: LayerModel, adjustment: Params<'adjustment.create'>['adjustment']): Promise<boolean>;
  getSelection(): { hasSelection(): boolean; grow(px: number): void; invert(): void; clear(): void } | null;
}

export function createAutoActionHost(deps: AutoActionHostDeps): AutoActionHost {
  async function setProps(layer: LayerModel, propsBefore: LayerPropsSnapshot, propsAfter: LayerPropsSnapshot) {
    if (!deps.canManageLayer(layer)) throw new AutoActionStepError('not_editable');
    if (Object.entries(propsAfter).every(([key, value]) => propsBefore[key as keyof LayerPropsSnapshot] === value)) return;
    if (!await deps.updateLayerProps(layer.id, propsAfter)) throw new AutoActionStepError('not_editable');
    const op: ScopedUndoOp = {
      opId: `op_layer_props_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      opType: 'LAYER_PROPS',
      userId: deps.getUserId(),
      layerId: layer.id,
      beforeTiles: [],
      afterTiles: [],
      propsBefore,
      propsAfter: { ...propsAfter },
      timestamp: Date.now(),
    };
    deps.undo.push(op);
  }

  return {
    beginUndoGroup: (id) => deps.undo.beginGroup(id),
    endUndoGroup: () => deps.undo.endGroup(),
    async rollbackUndoGroup(groupId) {
      if (deps.undo.countGroupOps(groupId) === 0 || deps.undo.getLatestUndoGroup(deps.getUserId()) !== groupId) return;
      try {
        await deps.undoNow(groupId);
      } finally {
        deps.undo.discardRedoGroup(groupId);
      }
    },
    async execute(step) {
      if (deps.isReadOnly()) throw new AutoActionStepError('read_only');
      if (step.kind === 'selection.grow' || step.kind === 'selection.invert' || step.kind === 'selection.clear') {
        const selection = deps.getSelection();
        if (!selection) throw new AutoActionStepError('selection_unavailable');
        if (step.kind === 'selection.invert') selection.invert();
        else if (step.kind === 'selection.clear') selection.clear();
        else if (selection.hasSelection()) selection.grow(step.params.px);
        return;
      }

      const layer = deps.getActiveLayer();
      if (!layer) throw new AutoActionStepError('no_layer');
      switch (step.kind) {
        case 'layer.new': {
          const { nameKey, name, ...props } = step.params;
          if (!await deps.createLayer(layer, { ...props, name: name ?? (nameKey && deps.resolveLayerName(nameKey)) })) {
            throw new AutoActionStepError('not_editable');
          }
          break;
        }
        case 'layer.duplicate':
          if (!deps.canManageLayer(layer) || !await deps.duplicateLayer(layer)) throw new AutoActionStepError('not_editable');
          break;
        case 'layer.merge_down': {
          const merged = await deps.mergeDown(layer);
          if (merged === 'no_layer_below') throw new AutoActionStepError('no_layer_below');
          if (!merged) throw new AutoActionStepError('merge_blocked');
          break;
        }
        case 'layer.delete':
          if (!deps.canManageLayer(layer) || !await deps.deleteLayer(layer)) throw new AutoActionStepError('not_editable');
          break;
        case 'layer.set_blend':
          await setProps(layer, { blendMode: layer.blendMode }, step.params);
          break;
        case 'layer.set_opacity':
          await setProps(layer, { opacity: layer.opacity }, step.params);
          break;
        case 'layer.set_clip':
          await setProps(layer, { clipToBelow: layer.clipToBelow }, step.params);
          break;
        case 'filter.apply': {
          if (layer.layerType !== 'adjustment' && !deps.canEditPixels(layer)) throw new AutoActionStepError('not_editable');
          const result = await deps.applyFilter(layer, step.params);
          if (result !== 'ok' && result !== 'unchanged') throw new AutoActionStepError(result);
          break;
        }
        case 'adjustment.create':
          if (!await deps.createAdjustmentLayer(layer, step.params.adjustment)) throw new AutoActionStepError('adjustment_blocked');
          break;
      }
    },
  };
}

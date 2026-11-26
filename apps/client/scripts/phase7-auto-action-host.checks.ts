import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAdjustment, type LayerModel, type ScopedUndoOp } from '@atelier/shared';
import { createAutoActionHost, type AutoActionHostDeps } from '../src/components/workspace/autoActionHost';
import {
  AutoActionStepError, BUILTIN_AUTO_ACTIONS, createAutoAction, normalizeAutoActionStep, playAutoAction,
  type AutoActionErrorCode, type AutoActionStepKind,
} from '../src/engine/ActionRecorder';
import { ScopedUndoManager } from '../src/engine/ScopedUndoManager';

const userId = 'painter';

const makeLayer = (id = 'source'): LayerModel => ({
  id, canvasId: 'canvas', parentId: null, ownerId: userId, name: id, layerType: 'raster',
  blendMode: 'normal', opacity: 1, isVisible: true, isLocked: false, alphaLocked: false,
  clipToBelow: false, sortOrder: 1, aclMode: 'owner_only', isPublic: false, createdAt: 0, updatedAt: 0,
});

function step(kind: AutoActionStepKind, params?: unknown) {
  const result = normalizeAutoActionStep({ kind, params });
  assert.ok(result, kind);
  return result;
}

function fixture() {
  const calls: unknown[][] = [];
  const undo = new ScopedUndoManager();
  let active: LayerModel | null = makeLayer();
  let hasSelection = false;
  const pushOp = (opType: string, layerId = active?.id ?? 'selection', owner = userId) => undo.push({
    opId: `${opType}-${calls.length}`, opType, userId: owner, layerId, beforeTiles: [], afterTiles: [], timestamp: 0,
  } satisfies ScopedUndoOp);
  const deps: AutoActionHostDeps = {
    undo,
    getUserId: () => userId,
    undoNow: async (id) => {
      calls.push(['undoNow', id]);
      undo.undoGroup(userId, undefined, id);
    },
    isReadOnly: () => false,
    getActiveLayer: () => active,
    canManageLayer: () => true,
    canEditPixels: () => true,
    resolveLayerName: (key) => `localized ${key}`,
    createLayer: async (layer, props) => {
      calls.push(['create', layer.id, props]);
      active = { ...makeLayer('new'), ...props, name: props.name ?? 'new' };
      pushOp('LAYER_CREATE');
      return true;
    },
    duplicateLayer: async (layer) => {
      calls.push(['duplicate', layer.id]);
      active = makeLayer('copy');
      pushOp('LAYER_CREATE');
      return true;
    },
    mergeDown: async (layer) => {
      calls.push(['merge', layer.id]);
      active = makeLayer('below');
      pushOp('STROKE');
      return true;
    },
    deleteLayer: async (layer) => {
      calls.push(['delete', layer.id]);
      active = makeLayer();
      pushOp('LAYER_DELETE', layer.id);
      return true;
    },
    updateLayerProps: async (id, props) => {
      calls.push(['props', id, props]);
      assert.ok(active);
      assert.equal(id, active.id);
      active = { ...active, ...props };
      return true;
    },
    applyFilter: async (layer, params) => {
      calls.push(['filter', layer.id, params]);
      pushOp('FILTER');
      return 'ok';
    },
    createAdjustmentLayer: async (layer, adjustment) => {
      calls.push(['adjustment', layer.id, adjustment]);
      active = { ...makeLayer('adjustment'), layerType: 'adjustment' };
      pushOp('LAYER_CREATE');
      return true;
    },
    getSelection: () => ({
      hasSelection: () => hasSelection,
      grow: (px) => { calls.push(['grow', px]); },
      invert: () => { hasSelection = !hasSelection; calls.push(['invert']); },
      clear: () => { hasSelection = false; calls.push(['clear']); },
    }),
  };
  const host = createAutoActionHost(deps);
  const execute = (kind: AutoActionStepKind, params?: unknown) => host.execute(step(kind, params), { index: 0 });
  const expectError = async (code: AutoActionErrorCode, kind: AutoActionStepKind, params?: unknown) =>
    assert.rejects(execute(kind, params), (error) => error instanceof AutoActionStepError && error.code === code);
  return { calls, deps, undo, host, execute, expectError, pushOp };
}

async function checkSteps() {
  const { calls, deps, execute, undo } = fixture();
  const adjustment = createDefaultAdjustment('brightness_contrast');
  const filter = { filterId: 'gaussian', values: { radius: 12 } };
  await execute('layer.new', { nameKey: 'shadow', blendMode: 'multiply', opacity: 0.6, clipToBelow: true });
  await execute('layer.duplicate');
  await execute('layer.set_blend', { blendMode: 'screen' });
  await execute('layer.set_opacity', { opacity: 0.4 });
  await execute('layer.set_opacity', { opacity: 0.4 });
  await execute('layer.set_clip', { clipToBelow: true });
  await execute('filter.apply', filter);
  await execute('layer.merge_down');
  await execute('adjustment.create', { adjustment });
  await execute('layer.delete');
  await execute('selection.grow', { px: 3 });
  await execute('selection.invert');
  await execute('selection.grow', { px: -3 });
  await execute('selection.clear');
  assert.deepEqual(calls, [
    ['create', 'source', { name: 'localized shadow', blendMode: 'multiply', opacity: 0.6, clipToBelow: true }],
    ['duplicate', 'new'],
    ['props', 'copy', { blendMode: 'screen' }],
    ['props', 'copy', { opacity: 0.4 }],
    ['props', 'copy', { clipToBelow: true }],
    ['filter', 'copy', filter], ['merge', 'copy'], ['adjustment', 'below', adjustment], ['delete', 'adjustment'],
    ['invert'], ['grow', -3], ['clear'],
  ]);
  const ops = Array.from({ length: undo.getUndoCount(userId) }, () => undo.undoGroup(userId)[0]);
  assert.deepEqual(ops.filter((op) => op.opType === 'LAYER_PROPS').map((op) =>
    [op.layerId, op.propsBefore, op.propsAfter, op.beforeTiles, op.afterTiles]), [
    ['copy', { clipToBelow: false }, { clipToBelow: true }, [], []],
    ['copy', { opacity: 1 }, { opacity: 0.4 }, [], []],
    ['copy', { blendMode: 'normal' }, { blendMode: 'screen' }, [], []],
  ]);
  deps.applyFilter = async () => 'unchanged';
  await execute('filter.apply', filter);
}

async function checkErrors() {
  const { calls, deps, expectError, execute, undo } = fixture();
  deps.isReadOnly = () => true;
  await expectError('read_only', 'layer.new');
  await expectError('read_only', 'selection.invert');
  deps.isReadOnly = () => false;
  deps.getActiveLayer = () => null;
  await expectError('no_layer', 'layer.duplicate');
  await execute('selection.invert');
  deps.getSelection = () => null;
  await expectError('selection_unavailable', 'selection.grow', { px: 3 });
  deps.getActiveLayer = () => makeLayer();
  deps.canManageLayer = () => false;
  await expectError('not_editable', 'layer.delete');
  await expectError('not_editable', 'layer.set_blend', { blendMode: 'multiply' });
  deps.canManageLayer = () => true;
  deps.updateLayerProps = async () => false;
  await expectError('not_editable', 'layer.set_opacity', { opacity: 0.6 });
  deps.canEditPixels = () => false;
  await expectError('not_editable', 'filter.apply', { filterId: 'gaussian', values: {} });
  deps.canEditPixels = () => true;
  deps.applyFilter = async () => 'filter_unavailable';
  await expectError('filter_unavailable', 'filter.apply', { filterId: 'plugin:missing', values: {} });
  deps.mergeDown = async () => 'no_layer_below';
  await expectError('no_layer_below', 'layer.merge_down');
  deps.mergeDown = async () => false;
  await expectError('merge_blocked', 'layer.merge_down');
  deps.createAdjustmentLayer = async () => false;
  await expectError('adjustment_blocked', 'adjustment.create', { adjustment: createDefaultAdjustment('brightness_contrast') });
  assert.deepEqual(calls, [['invert']]);
  assert.equal(undo.getUndoCount(), 0);
}

async function checkRollback() {
  const { calls, undo, host, pushOp } = fixture();
  await host.rollbackUndoGroup('empty');
  host.beginUndoGroup('partial');
  pushOp('LAYER_CREATE');
  host.endUndoGroup();
  pushOp('OTHER_EDIT');
  await host.rollbackUndoGroup('partial');
  assert.deepEqual(calls, []);
  assert.equal(undo.countGroupOps('partial'), 1);
  assert.equal(undo.undoGroup(userId)[0]?.opType, 'OTHER_EDIT');
  pushOp('OTHER_PAINTER_EDIT', 'foreign', 'other');
  await host.rollbackUndoGroup('partial');
  assert.deepEqual(calls, [['undoNow', 'partial']]);
  assert.equal(undo.countGroupOps('partial'), 0);
  assert.equal(undo.getRedoCount(), 0);
  assert.equal(undo.getUndoCount('other'), 1);

  const preserveRedo = fixture();
  preserveRedo.host.beginUndoGroup('partial');
  preserveRedo.pushOp('LAYER_CREATE');
  preserveRedo.host.endUndoGroup();
  preserveRedo.pushOp('OTHER_EDIT');
  preserveRedo.undo.undoGroup(userId);
  await preserveRedo.host.rollbackUndoGroup('partial');
  assert.equal(preserveRedo.undo.getRedoCount(userId), 1);
  assert.equal(preserveRedo.undo.redoGroup(userId)[0]?.opType, 'OTHER_EDIT');

  const failed = fixture();
  failed.deps.applyFilter = async () => 'filter_failed';
  const result = await playAutoAction(createAutoAction('partial', [step('layer.duplicate'), step('filter.apply', { filterId: 'gaussian', values: {} })]), failed.host);
  assert.match(result.groupId ?? '', /^auto_action_/);
  assert.ok(!result.ok && result.code === 'filter_failed');
  assert.equal(failed.undo.getUndoCount(), 0);
  assert.equal(failed.undo.getRedoCount(), 0);
}

async function checkSoftGlow() {
  const { calls, undo, host } = fixture();
  const softGlow = BUILTIN_AUTO_ACTIONS.find((action) => action.builtinKey === 'softGlow');
  assert.ok(softGlow);
  const result = await playAutoAction(softGlow, host);
  assert.ok(result.ok && result.groupId);
  assert.equal(result.executed, 4);
  assert.equal(undo.getActiveGroup(), null);
  assert.equal(undo.countGroupOps(result.groupId), 4);
  assert.equal(undo.getUndoCount(userId), 1);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ['duplicate', 'source'], ['filter', 'copy'], ['props', 'copy'], ['props', 'copy'],
  ]);
  const ops = undo.undoGroup(userId);
  assert.deepEqual(ops.map((op) => op.opType), ['LAYER_PROPS', 'LAYER_PROPS', 'FILTER', 'LAYER_CREATE']);
  assert.ok(ops.every((op) => op.groupId === result.groupId));
  assert.equal(undo.getUndoCount(userId), 0);
  assert.equal(undo.getRedoCount(userId), 1);
  undo.discardRedoGroup(result.groupId);
  assert.equal(undo.getRedoCount(userId), 0);
}

export async function runPhase7AutoActionHostChecks(): Promise<void> {
  await checkSteps();
  await checkErrors();
  await checkRollback();
  await checkSoftGlow();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase7AutoActionHostChecks().then(() => console.log('ok'), (error) => { console.error(error); process.exit(1); });
}

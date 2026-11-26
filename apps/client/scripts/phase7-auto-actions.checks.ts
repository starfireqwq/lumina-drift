import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScopedUndoOp } from '@atelier/shared';
import {
  ActionRecorder,
  AutoActionFileError,
  AutoActionStepError,
  BUILTIN_AUTO_ACTIONS,
  BUILTIN_AUTO_ACTION_KEYS,
  createAutoAction,
  createAutoActionStore,
  duplicateAutoAction,
  isAutoActionPlaying,
  moveAutoActionStep,
  normalizeAutoActionStep,
  parseAutoActionFile,
  playAutoAction,
  removeAutoActionStep,
  renameAutoAction,
  serializeAutoActionFile,
  setAutoActionStepEnabled,
  updateAutoActionStepParams,
  type AutoActionHost,
  type AutoActionStep,
  type AutoActionStepKind,
} from '../src/engine/ActionRecorder';
import { ONLINE_UNDO_LIMIT, ScopedUndoManager } from '../src/engine/ScopedUndoManager';
import { BUILTIN_FILTERS, normalizeFilterValues } from '../src/utils/filterRegistry';

function step(kind: AutoActionStepKind, params?: unknown): AutoActionStep {
  const normalized = normalizeAutoActionStep({ kind, params });
  assert.ok(normalized, kind);
  return normalized;
}

async function checkRecorder(): Promise<void> {
  const recorder = new ActionRecorder();
  const idle = recorder.getSnapshot();
  const duplicate = { kind: 'layer.duplicate' } as const;
  const recordOpacity = (opacity: number) =>
    recorder.record({ kind: 'layer.set_opacity', params: { opacity } }, { coalesceKey: 'opacity:layer' });
  assert.equal(recorder.record(duplicate), false);
  assert.equal(recorder.getSnapshot(), idle);

  let notifications = 0;
  const unsubscribe = recorder.subscribe(() => { notifications++; });
  recorder.start();
  assert.equal(recorder.getSnapshot().state, 'recording');
  assert.ok(recorder.record(duplicate));
  const recording = recorder.getSnapshot();
  assert.equal(recorder.getSnapshot(), recording);
  recorder.pause();
  const paused = recorder.getSnapshot();
  assert.equal(paused.state, 'paused');
  assert.equal(recorder.isCapturing(), false);
  assert.equal(recorder.record(duplicate), false);
  assert.equal(recorder.getSnapshot(), paused);
  recorder.resume();
  assert.equal(notifications, 4);
  unsubscribe();

  assert.ok(recordOpacity(0.2));
  const beforeReplacement = recorder.getSnapshot();
  assert.ok(recordOpacity(0.5));
  const updated = recorder.getSnapshot();
  assert.equal(updated.steps.length, 2);
  assert.equal(updated.steps[1].id, beforeReplacement.steps[1].id);
  assert.deepEqual(beforeReplacement.steps[1].params, { opacity: 0.2 });
  assert.deepEqual(updated.steps[1].params, { opacity: 0.5 });
  assert.equal('coalesceKey' in updated.steps[1], false);
  await assert.rejects(recorder.runSuppressed(async () => {
    assert.equal(recorder.isCapturing(), false);
    await recorder.runSuppressed(() => assert.equal(recorder.record(duplicate), false));
    assert.equal(recorder.record(duplicate), false);
    throw new Error('suppressed');
  }), /suppressed/);
  assert.equal(recorder.isCapturing(), true);
  assert.equal(recorder.getSnapshot(), updated);

  assert.ok(recorder.record(duplicate));
  assert.ok(recordOpacity(0.7));
  assert.equal(recorder.getSnapshot().steps.length, 4);
  for (let index = 4; index < 199; index++) assert.ok(recorder.record(duplicate));
  assert.ok(recordOpacity(0.8));
  assert.equal(recorder.getSnapshot().full, false);
  assert.equal(recorder.record(duplicate), false);
  const full = recorder.getSnapshot();
  assert.equal(full.full, true);
  assert.equal(full.steps.length, 200);
  assert.equal(recorder.record(duplicate), false);
  assert.equal(recorder.getSnapshot(), full);
  assert.ok(recordOpacity(0.9));
  const steps = recorder.stop();
  assert.equal(steps.length, 200);
  assert.deepEqual(steps[199].params, { opacity: 0.9 });
  assert.deepEqual(recorder.getSnapshot(), { state: 'idle', steps: [], full: false });
  assert.equal(notifications, 4);
  recorder.start();
  assert.ok(recorder.record(duplicate));
  recorder.cancel();
  assert.deepEqual(recorder.stop(), []);
}

function checkNormalization(): void {
  assert.deepEqual(step('layer.set_opacity', { opacity: -2 }).params, { opacity: 0 });
  assert.deepEqual(step('layer.set_opacity', { opacity: 8 }).params, { opacity: 1 });
  assert.deepEqual(step('selection.grow', { px: -800 }).params, { px: -500 });
  assert.deepEqual(step('selection.grow', { px: 1.7 }).params, { px: 2 });
  assert.equal(normalizeAutoActionStep({ kind: 'selection.grow', params: { px: 0 } }), null);
  assert.equal(normalizeAutoActionStep({ kind: 'layer.set_blend', params: { blendMode: 'toString' } }), null);
  assert.equal(normalizeAutoActionStep({ kind: 'layer.set_blend', params: { blendMode: 'neon' } }), null);
  assert.deepEqual(step('layer.new', { name: ' \u0000' + 'a'.repeat(65), opacity: 1.5 }).params, {
    name: 'a'.repeat(60), opacity: 1,
  });
  for (const filterId of ['missing', 'liquify', 'meshWarp']) {
    assert.equal(normalizeAutoActionStep({ kind: 'filter.apply', params: { filterId, values: {} } }), null);
  }
  assert.deepEqual(step('filter.apply', { filterId: 'gaussian', values: { radius: 99 } }).params, {
    filterId: 'gaussian', values: { radius: 32 },
  });
  assert.deepEqual(step('filter.apply', { filterId: 'curves', values: {
    options: { masterCurve: [{ x: 0, y: 12 }, { x: 255, y: 243 }] },
  } }).params, {
    filterId: 'curves', values: { options: { masterCurve: [{ x: 0, y: 12 }, { x: 255, y: 243 }] } },
  });

  const poisoned: unknown = JSON.parse(
    '{"mix":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"safe":true}}',
  );
  assert.deepEqual(step('filter.apply', { filterId: 'plugin:missing:filter', values: poisoned }).params, {
    filterId: 'plugin:missing:filter', values: { mix: { safe: true } },
  });
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.equal(normalizeAutoActionStep(Object.create({ kind: 'selection.clear' })), null);
  assert.equal(normalizeAutoActionStep({
    kind: 'layer.set_opacity', params: Object.create({ opacity: 0.5 }),
  }), null);
  assert.deepEqual(step('filter.apply', { filterId: 'gaussian', values: Object.create({ radius: 16 }) }).params, {
    filterId: 'gaussian', values: { radius: 8 },
  });
  assert.deepEqual(step('adjustment.create', { adjustment: {
    kind: 'hsl', params: Object.create({ hue: 120 }),
  } }).params, {
    adjustment: { kind: 'hsl', params: { hue: 0, saturation: 0, lightness: 0, colorize: false } },
  });
  assert.equal(normalizeAutoActionStep({ kind: 'adjustment.create', params: { adjustment: { kind: 'missing' } } }), null);

  const sparse = Array(2);
  sparse[1] = 'own';
  Object.setPrototypeOf(sparse, Object.assign(Object.create(Array.prototype), { 0: 'inherited' }));
  assert.deepEqual(step('filter.apply', { filterId: 'plugin:test:json', values: {
    sample: [sparse, [true, [[[1]]]]], long: 'a'.repeat(220), nil: null, infinity: Infinity, invalid: () => 1,
  } }).params, {
    filterId: 'plugin:test:json', values: { sample: [['own'], [true, []]], long: 'a'.repeat(200), nil: null },
  });
  const tooBig = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`key${i}`, '光'.repeat(200)]));
  assert.equal(normalizeAutoActionStep({ kind: 'filter.apply', params: { filterId: 'plugin:test:json', values: tooBig } }), null);
  assert.equal(normalizeAutoActionStep({
    kind: 'filter.apply', params: { filterId: 'plugin:test:json', values: { oversize: 'x'.repeat(8193) } },
  }), null);
}

const file = (actions: unknown[]) => JSON.stringify({ format: 'lumina-action', version: 1, actions });
const stepContent = ({ kind, params, enabled }: AutoActionStep) => ({ kind, params, enabled });

function checkFiles(): void {
  const builtin = BUILTIN_AUTO_ACTIONS[0];
  const original = setAutoActionStepEnabled(builtin, builtin.steps[1].id, false);
  const text = serializeAutoActionFile([original]);
  const serialized = JSON.parse(text);
  assert.deepEqual(Object.keys(serialized.actions[0]), ['name', 'steps']);
  assert.deepEqual(Object.keys(serialized.actions[0].steps[0]), ['kind', 'params', 'enabled']);
  assert.match(text, /\n {2}"format"/);
  const { actions: [restored], warnings } = parseAutoActionFile(text);
  assert.deepEqual(warnings, []);
  assert.equal(restored.name, original.name);
  assert.deepEqual(restored.steps.map(stepContent), original.steps.map(stepContent));
  assert.notEqual(restored.id, original.id);
  assert.equal(restored.builtinKey, undefined);
  for (let index = 0; index < restored.steps.length; index++) {
    assert.notEqual(restored.steps[index].id, original.steps[index].id);
  }
  assert.equal(new Set(restored.steps.map((item) => item.id)).size, restored.steps.length);

  const badFiles = [
    ['too_large', '光'.repeat(180_000)],
    ['not_json', '{"format"'],
    ['wrong_format', '{"__proto__":{"format":"lumina-action","version":1}}'],
    ['unsupported_version', '{"format":"lumina-action","version":2}'],
    ['empty', file([])],
  ] as const;
  for (const [code, bad] of badFiles) {
    assert.throws(() => parseAutoActionFile(bad), (error) => error instanceof AutoActionFileError && error.code === code);
  }
  const imported = parseAutoActionFile(JSON.stringify({
    format: 'lumina-action', version: 1, id: 'incoming', builtinKey: 'softGlow', name: ' 單一動作\u0000 ',
    steps: [
      { kind: 'future' },
      { kind: 'layer.set_blend', params: { blendMode: 'invalid' } },
      { kind: 'selection.invert', id: 'incoming-step', enabled: false },
    ],
  }));
  assert.deepEqual(imported.warnings, [
    { code: 'unknown_kind', action: 0, step: 0 },
    { code: 'invalid_params', action: 0, step: 1 },
  ]);
  const [item] = imported.actions;
  assert.equal(item.name, '單一動作');
  assert.notEqual(item.id, 'incoming');
  assert.equal(item.builtinKey, undefined);
  assert.deepEqual(item.steps.map(stepContent), [{ kind: 'selection.invert', params: {}, enabled: false }]);
  assert.notEqual(item.steps[0].id, 'incoming-step');

  const limited = parseAutoActionFile(file(Array.from({ length: 51 }, (_, index) => ({
    name: `Action ${index}`,
    steps: index ? [] : Array.from({ length: 201 }, () => ({ kind: 'selection.clear' })),
  }))));
  assert.equal(limited.actions.length, 50);
  assert.equal(limited.actions[0].steps.length, 200);
  assert.deepEqual(limited.warnings, [{ code: 'truncated', action: 0, step: 200 }, { code: 'truncated', action: 50 }]);
}

function checkEditsAndStore(): void {
  const original = BUILTIN_AUTO_ACTIONS[0];
  const [duplicate, filter, , opacity] = original.steps;
  const renamed = renameAutoAction(original, ' 新名稱\u0000 ');
  assert.equal(renamed.name, '新名稱');
  assert.equal(renamed.steps, original.steps);
  assert.ok(renamed.updatedAt > original.updatedAt);

  const moved = moveAutoActionStep(original, 0, 2);
  assert.equal(moved.steps[2], duplicate);
  assert.equal(moved.steps[0], filter);
  assert.equal(original.steps[0], duplicate);
  assert.equal(moveAutoActionStep(original, -1, 0), original);
  const disabled = setAutoActionStepEnabled(moved, filter.id, false);
  assert.equal(disabled.steps[0].enabled, false);
  assert.equal(moved.steps[0].enabled, true);
  const removed = removeAutoActionStep(disabled, filter.id);
  assert.equal(removed.steps.length, 3);
  assert.equal(disabled.steps.length, 4);
  const updated = updateAutoActionStepParams(removed, opacity.id, { opacity: 1.6 });
  assert.deepEqual(updated.steps[2].params, { opacity: 1 });
  assert.deepEqual(removed.steps[2].params, { opacity: 0.4 });
  assert.equal(updated.steps[2].id, opacity.id);
  assert.equal(updateAutoActionStepParams(updated, opacity.id, { opacity: 'bad' }), updated);
  for (const [older, newer] of [[original, moved], [moved, disabled], [disabled, removed], [removed, updated]]) {
    assert.ok(newer.updatedAt > older.updatedAt);
    assert.equal(newer.createdAt, older.createdAt);
  }
  const copied = duplicateAutoAction(original, '複本');
  assert.equal(copied.name, '複本');
  assert.notEqual(copied.id, original.id);
  assert.equal(copied.builtinKey, undefined);
  assert.deepEqual(copied.steps.map(stepContent), original.steps.map(stepContent));
  assert.notEqual(copied.steps[1].id, filter.id);
  assert.notEqual(copied.steps[1].params, filter.params);

  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
  const key = 'atelier_auto_actions_v1';
  const store = createAutoActionStore(storage);
  const initial = store.getSnapshot();
  assert.deepEqual(store.list(), BUILTIN_AUTO_ACTIONS);
  assert.equal(store.getSnapshot(), initial);
  assert.equal(store.save(original), false);
  assert.equal(store.getSnapshot(), initial);
  assert.equal(data.has(key), false);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  assert.equal(store.save(copied), true);
  assert.equal(notifications, 1);
  const saved = store.getSnapshot();
  assert.notEqual(saved, initial);
  assert.equal(store.getSnapshot(), saved);
  assert.deepEqual(store.listUser(), [copied]);
  assert.deepEqual(JSON.parse(data.get(key)!), [copied]);
  assert.deepEqual(createAutoActionStore(storage).list(), [...BUILTIN_AUTO_ACTIONS, copied]);
  const renamedCopy = renameAutoAction(copied, '更新');
  assert.equal(store.save(renamedCopy), true);
  assert.deepEqual(store.listUser(), [renamedCopy]);
  assert.equal(store.remove(original.id), false);
  unsubscribe();
  assert.equal(store.remove(renamedCopy.id), true);
  assert.equal(notifications, 2);
  data.set(key, '{broken');
  assert.deepEqual(createAutoActionStore(storage).listUser(), []);
  assert.deepEqual(createAutoActionStore(storage).list(), BUILTIN_AUTO_ACTIONS);

  const limited = createAutoActionStore(storage, 'limited');
  for (let index = 0; index < 100; index++) assert.equal(limited.save(createAutoAction(`Action ${index}`, [])), true);
  assert.equal(limited.save(copied), false);
  assert.equal(limited.listUser().length, 100);
  assert.equal(limited.save(renameAutoAction(limited.listUser()[0], '保留')), true);
  const unavailable = createAutoActionStore({
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
  });
  assert.equal(unavailable.save(copied), false);
  assert.deepEqual(unavailable.listUser(), []);
}

function checkPresets(): void {
  assert.equal(BUILTIN_AUTO_ACTIONS.length, 7);
  assert.deepEqual(BUILTIN_AUTO_ACTIONS.map((action) => action.builtinKey), [...BUILTIN_AUTO_ACTION_KEYS]);
  for (const action of BUILTIN_AUTO_ACTIONS) {
    for (const item of action.steps) {
      assert.deepEqual(normalizeAutoActionStep(item), item);
      if (item.kind !== 'filter.apply') continue;
      const def = BUILTIN_FILTERS.find((filter) => filter.id === item.params.filterId);
      assert.ok(def && !def.tool);
      assert.deepEqual(item.params.values, normalizeFilterValues(def, item.params.values));
    }
  }
  const softGlow = BUILTIN_AUTO_ACTIONS.find((action) => action.builtinKey === 'softGlow');
  assert.ok(softGlow);
  assert.deepEqual(softGlow.steps.map(stepContent), [
    { kind: 'layer.duplicate', params: {}, enabled: true },
    { kind: 'filter.apply', params: { filterId: 'gaussian', values: { radius: 12 } }, enabled: true },
    { kind: 'layer.set_blend', params: { blendMode: 'screen' }, enabled: true },
    { kind: 'layer.set_opacity', params: { opacity: 0.4 }, enabled: true },
  ]);
}

function undoOp(opId: string, extra: Partial<ScopedUndoOp> = {}): ScopedUndoOp {
  return { opId, userId: 'artist', layerId: 'layer', opType: 'TEST', beforeTiles: [], afterTiles: [], timestamp: 0, ...extra };
}

function createHost(recorder: ActionRecorder, afterExecute?: (index: number) => void | Promise<void>) {
  const undo = new ScopedUndoManager();
  const events: string[] = [];
  const rolledBack: ScopedUndoOp[] = [];
  const expectSuppressed = () => assert.equal(recorder.record({ kind: 'selection.clear' }), false);
  const host: AutoActionHost = {
    beginUndoGroup(groupId) {
      events.push('begin');
      expectSuppressed();
      undo.beginGroup(groupId);
    },
    endUndoGroup() {
      events.push('end');
      expectSuppressed();
      undo.endGroup();
    },
    async rollbackUndoGroup(groupId) {
      events.push('rollback');
      expectSuppressed();
      assert.equal(undo.getActiveGroup(), null);
      if (undo.countGroupOps(groupId)) rolledBack.push(...undo.undoGroup('artist'));
      assert.ok(rolledBack.every((op) => op.groupId === groupId));
    },
    async execute(item, { index }) {
      events.push(`step:${index}`);
      expectSuppressed();
      const op = undoOp(String(index), { groupId: 'would-have-been-a-separate-group' });
      switch (item.kind) {
        case 'layer.duplicate':
          op.layerCreated = { model: { id: op.layerId } };
          break;
        case 'filter.apply': {
          const tile = { col: 0, row: 0, width: 1, height: 1, compression: 'raw' } as const;
          op.beforeTiles = [{ ...tile, data: Uint8Array.of(0, 0, 0, 0) }];
          op.afterTiles = [{ ...tile, data: Uint8Array.of(1, 1, 1, 1) }];
          break;
        }
        case 'layer.set_blend':
          op.propsBefore = { blendMode: 'normal' };
          op.propsAfter = { blendMode: item.params.blendMode };
          break;
        case 'layer.set_opacity':
          op.propsBefore = { opacity: 1 };
          op.propsAfter = { opacity: item.params.opacity };
          break;
      }
      undo.push(op);
      await afterExecute?.(index);
    },
  };
  return { host, undo, events, rolledBack };
}

function checkGroupCapture(): void {
  const undo = new ScopedUndoManager();
  assert.equal(undo.getActiveGroup(), null);
  undo.endGroup();
  undo.beginGroup('outer');
  undo.beginGroup('nested');
  assert.equal(undo.getActiveGroup(), 'outer');
  const first = undoOp('1', { groupId: 'plugin' });
  undo.push(first);
  undo.endGroup();
  assert.equal(undo.getActiveGroup(), 'outer');
  const second = undoOp('2');
  undo.push(second);
  assert.equal(undo.countGroupOps('outer'), 2);
  assert.equal(undo.countGroupOps('plugin'), 0);
  undo.endGroup();
  assert.equal(undo.getActiveGroup(), null);
  assert.deepEqual(undo.undoGroup('artist'), [second, first]);
  assert.equal(undo.countGroupOps('outer'), 0);
  const separate = undoOp('3', { groupId: 'explicit' });
  undo.push(separate);
  assert.equal(separate.groupId, 'explicit');
}

async function checkPlayback(): Promise<void> {
  const recorder = new ActionRecorder();
  recorder.start();
  const snapshot = recorder.getSnapshot();
  const opts = { recorder };
  const action = BUILTIN_AUTO_ACTIONS[0];
  const sparse = setAutoActionStepEnabled(action, action.steps[2].id, false);

  const completed = createHost(recorder);
  const progress: Array<[number, number, AutoActionStepKind]> = [];
  const result = await playAutoAction(sparse, completed.host, {
    ...opts,
    onProgress(index, total, item) {
      assert.equal(recorder.isCapturing(), false);
      progress.push([index, total, item.kind]);
    },
  });
  assert.ok(result.ok && result.groupId);
  assert.match(result.groupId, /^auto_action_\d+_[a-z0-9]+$/);
  assert.equal(result.executed, 3);
  assert.deepEqual(completed.events, ['begin', 'step:0', 'step:1', 'step:3', 'end']);
  assert.deepEqual(progress, [[0, 3, 'layer.duplicate'], [1, 3, 'filter.apply'], [2, 3, 'layer.set_opacity']]);
  assert.equal(completed.undo.getUndoCount(), 1);
  assert.equal(completed.undo.countGroupOps(result.groupId), 3);
  const undone = completed.undo.undoGroup('artist');
  assert.deepEqual(undone.map((op) => op.opId), ['3', '1', '0']);
  assert.ok(undone.every((op) => op.groupId === result.groupId));
  assert.deepEqual(undone[0].propsAfter, { opacity: 0.4 });
  assert.equal(undone[1].afterTiles.length, 1);
  assert.ok(undone[2].layerCreated);
  assert.deepEqual(completed.undo.undoGroup('artist'), []);

  const empty = createHost(recorder);
  const disabled = { ...action, steps: action.steps.map((item) => ({ ...item, enabled: false })) };
  assert.deepEqual(await playAutoAction(disabled, empty.host, opts), { ok: true, groupId: null, executed: 0 });
  assert.deepEqual(empty.events, []);

  const failing = createHost(recorder, (index) => {
    if (index === 1) throw new AutoActionStepError('filter_failed', 'test failure');
  });
  failing.undo.push(undoOp('prior'));
  const failed = await playAutoAction(action, failing.host, opts);
  assert.ok(!failed.ok && failed.groupId);
  assert.equal(failed.code, 'filter_failed');
  assert.equal(failed.message, 'test failure');
  assert.equal(failed.failedIndex, 1);
  assert.deepEqual(failing.events, ['begin', 'step:0', 'step:1', 'end', 'rollback']);
  assert.deepEqual(failing.rolledBack.map((op) => op.opId), ['1', '0']);
  assert.equal(failing.undo.countGroupOps(failed.groupId), 0);
  assert.deepEqual(failing.undo.inspect().undo.map((op) => op.opId), ['prior']);

  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const pending = createHost(recorder, () => hold);
  const play = playAutoAction(action, pending.host, opts);
  assert.equal(isAutoActionPlaying(), true);
  assert.deepEqual(await playAutoAction(action, empty.host, opts), {
    ok: false, groupId: null, failedIndex: -1, code: 'busy',
  });
  release();
  const played = await play;
  assert.ok(played.ok);
  assert.deepEqual(pending.undo.inspect().undo[2].propsAfter, { blendMode: 'screen' });
  assert.equal(isAutoActionPlaying(), false);

  const controller = new AbortController();
  const cancelling = createHost(recorder);
  const cancelled = await playAutoAction(sparse, cancelling.host, {
    ...opts, signal: controller.signal,
    onProgress: (index) => { if (index === 2) controller.abort(); },
  });
  assert.ok(!cancelled.ok);
  assert.equal(cancelled.code, 'cancelled');
  assert.equal(cancelled.failedIndex, 3);
  assert.deepEqual(cancelling.events, ['begin', 'step:0', 'step:1', 'end', 'rollback']);
  assert.equal(cancelling.rolledBack.length, 2);

  const inFlight = new AbortController();
  const interrupted = createHost(recorder, () => {
    inFlight.abort();
    throw new Error('aborted during execution');
  });
  const lastStep = createAutoAction('Last step', [step('layer.duplicate')]);
  const aborted = await playAutoAction(lastStep, interrupted.host, { ...opts, signal: inFlight.signal });
  assert.ok(!aborted.ok);
  assert.equal(aborted.code, 'cancelled');
  assert.equal(interrupted.rolledBack.length, 1);

  const extended = createHost(recorder);
  for (let i = 0; i < ONLINE_UNDO_LIMIT; i++) extended.undo.push(undoOp(`old-${i}`));
  const longAction = createAutoAction('Long action', Array.from({ length: 36 }, () => step('selection.clear')));
  const longResult = await playAutoAction(longAction, extended.host, opts);
  assert.ok(longResult.ok && longResult.groupId);
  assert.equal(extended.undo.getUndoCount(), ONLINE_UNDO_LIMIT);
  assert.equal(extended.undo.countGroupOps(longResult.groupId), 36);
  assert.equal(extended.undo.undoGroup('artist').length, 36);
  assert.equal(extended.undo.getUndoCount(), ONLINE_UNDO_LIMIT - 1);
  assert.equal(extended.undo.redoGroup('artist').length, 36);
  assert.equal(recorder.getSnapshot(), snapshot);
  assert.equal(recorder.isCapturing(), true);
}

export async function runPhase7AutoActionChecks(): Promise<void> {
  await checkRecorder();
  checkNormalization();
  checkFiles();
  checkEditsAndStore();
  checkPresets();
  checkGroupCapture();
  await checkPlayback();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase7AutoActionChecks().then(() => console.log('ok'), (e) => { console.error(e); process.exit(1); });
}

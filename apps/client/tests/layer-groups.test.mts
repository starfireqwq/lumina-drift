import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canUserPerformLayerAction,
  computeGroupedAscendingNonMaskIds,
  computeTidiedAscendingNonMaskIds,
  filterTopLevelSelectedLayers,
  findTopAnchorForParent,
  orderLayersForReparenting,
  selectLayerRange,
  tidyLayerModels,
  type LayerModel,
} from '@atelier/shared';
import { LayerManager } from '../src/engine/LayerManager.ts';
import type { Renderer } from 'pixi.js';

function mkLayer(overrides: Partial<LayerModel> & { id: string; sortOrder: number }): LayerModel {
  return {
    canvasId: 'c1',
    parentId: null,
    ownerId: 'u1',
    name: overrides.id,
    layerType: 'raster',
    blendMode: 'normal',
    opacity: 1,
    isVisible: true,
    isLocked: false,
    alphaLocked: false,
    clipToBelow: false,
    aclMode: 'owner_only',
    isPublic: true,
    createdAt: overrides.sortOrder,
    updatedAt: overrides.sortOrder,
    ...overrides,
  };
}

function verifySequentialReparenting(
  initial: LayerModel[],
  roots: LayerModel[],
  target: string | null,
  ascendingIds: string[],
  expectedMembers: string[],
): LayerModel[] {
  let layers = tidyLayerModels(initial).layers;
  const memberIds = () => layers.filter((l) => l.layerType !== 'mask' && l.parentId === target).map((l) => l.id);
  for (const { id } of orderLayersForReparenting(initial, roots, target)) {
    // Each parent update normalizes the whole tree in the offline store and multiplayer server.
    layers = tidyLayerModels(layers.map((l) => l.id === id ? { ...l, parentId: target } : l)).layers;
    const members = memberIds();
    assert.ok(members.includes(id));
    assert.deepEqual(members, expectedMembers.filter((member) => members.includes(member)), `after moving ${id}`);
  }
  assert.deepEqual(memberIds(), expectedMembers);

  const order = new Map(ascendingIds.map((id, i) => [id, (i + 1) * 10]));
  layers = tidyLayerModels(layers.map((l) => ({ ...l, sortOrder: order.get(l.id) ?? l.sortOrder }))).layers;
  assert.deepEqual(memberIds(), expectedMembers, 'after final reorder');
  assert.deepEqual(layers.filter((l) => l.layerType !== 'mask').map((l) => l.id), ascendingIds);
  return layers;
}

test('folders retain management permissions and reject pixel operations even for admins', () => {
  const folder = { id: 'folder', layerType: 'group', ownerId: 'admin', isLocked: false } as LayerModel;
  const context = { user: { id: 'admin', serverRole: 'admin' as const }, layer: folder };
  for (const action of ['draw', 'erase', 'filter'] as const) {
    assert.equal(canUserPerformLayerAction(context, action).allowed, false);
  }
  assert.equal(canUserPerformLayerAction(context, 'modify_props').allowed, true);
  assert.equal(canUserPerformLayerAction({ ...context, layer: { ...folder, layerType: 'raster' } }, 'draw').allowed, true);
});

test('duplicate layer responses cannot create duplicate Pixi children or folder textures', () => {
  const manager = new LayerManager({ render() {} } as Renderer, 64, 64);
  const raster = { id: 'a', name: 'A', sortOrder: 10, layerType: 'raster', opacity: 1, isVisible: true, blendMode: 'normal' } as LayerModel;
  const folder = { ...raster, id: 'folder', layerType: 'group' as const, sortOrder: 20, opacity: 0.5 };
  const child = { ...raster, id: 'b', sortOrder: 30, parentId: folder.id };
  try {
    manager.syncLayers([raster, folder, child, child]);
    assert.equal(manager.layersContainer.children.length, 2);
    assert.equal(manager.getLayerItem(folder.id), undefined);
    assert.equal(manager.getLayerItem(child.id)?.display.alpha, 0.5);
  } finally {
    manager.destroy();
  }
});

test('non-contiguous layers grouped together move directly underneath their new group in display order', () => {
  // Bottom-to-top initial stack: L2(10), SF_bottom(20), SF_pick(30), 9-5(40), L5(50), L6(60), L7_pick(70)
  const initial: LayerModel[] = [
    mkLayer({ id: 'L2', sortOrder: 10 }),
    mkLayer({ id: 'SF_bottom', sortOrder: 20 }),
    mkLayer({ id: 'SF_pick', sortOrder: 30 }),
    mkLayer({ id: '9-5', sortOrder: 40 }),
    mkLayer({ id: 'L5', sortOrder: 50 }),
    mkLayer({ id: 'L6', sortOrder: 60 }),
    mkLayer({ id: 'L7_pick', sortOrder: 70 }),
  ];

  const selected = filterTopLevelSelectedLayers(initial, ['L7_pick', 'SF_pick']);
  assert.deepEqual(selected.map((l) => l.id), ['SF_pick', 'L7_pick']);

  const top = selected[selected.length - 1];
  const anchor = findTopAnchorForParent(initial, top, null);
  assert.equal(anchor.id, 'L7_pick');

  const group = mkLayer({ id: 'G1', layerType: 'group', sortOrder: anchor.sortOrder + 5 });
  const ascending = computeGroupedAscendingNonMaskIds(initial, group, anchor.id, null, new Set(['SF_pick', 'L7_pick']));
  const descending = [...ascending].reverse();
  // Display order (top-to-bottom): G1 -> L7_pick -> SF_pick -> L6 -> L5 -> 9-5 -> SF_bottom -> L2
  assert.deepEqual(descending, ['G1', 'L7_pick', 'SF_pick', 'L6', 'L5', '9-5', 'SF_bottom', 'L2']);

  // Verify masks stay attached to their moved owners
  const mask = mkLayer({ id: 'M_SF', layerType: 'mask', parentId: 'SF_pick', sortOrder: 35 });
  const withMask = verifySequentialReparenting([...initial, group, mask], selected, group.id, ascending, ['SF_pick', 'L7_pick']);
  const sfIdx = withMask.findIndex((l) => l.id === 'SF_pick');
  assert.equal(withMask[sfIdx + 1]?.id, 'M_SF');
});

for (const { count, selectedIds, expected } of [
  { count: 7, selectedIds: ['L1', 'L4', 'L7'], expected: ['L2', 'L3', 'L5', 'L6', 'L1', 'L4', 'L7', 'G1'] },
  { count: 5, selectedIds: ['L1', 'L3'], expected: ['L2', 'L1', 'L3', 'G1', 'L4', 'L5'] },
]) {
  test(`grouping ${selectedIds.join(', ')} preserves the order and respects the anchor`, () => {
    const initial = Array.from({ length: count }, (_, i) => mkLayer({ id: `L${i + 1}`, sortOrder: (i + 1) * 10 }));
    const roots = filterTopLevelSelectedLayers(initial, selectedIds);
    const anchor = findTopAnchorForParent(initial, roots.at(-1)!, null);
    const group = mkLayer({ id: 'G1', layerType: 'group', sortOrder: anchor.sortOrder + 5 });
    const staleGroup = { ...group, sortOrder: 1000 };
    const ascendingIds = computeGroupedAscendingNonMaskIds([...initial, staleGroup], staleGroup, anchor.id, null, new Set(selectedIds));
    assert.deepEqual(ascendingIds, expected);
    verifySequentialReparenting([...initial, group], roots, group.id, ascendingIds, selectedIds);
  });
}

for (const { label, stack, target, members } of [
  { label: 'a group above', stack: ['L1', 'keep', 'L2', 'L3', 'G'], target: 'G', members: ['L1', 'L2', 'L3'] },
  { label: 'a group above with children', stack: ['L1', 'keep', 'L2', 'L3', 'C1', 'C2', 'G'], target: 'G', members: ['L1', 'L2', 'L3', 'C1', 'C2'] },
  { label: 'a group below', stack: ['G', 'L1', 'keep', 'L2', 'L3'], target: 'G', members: ['L1', 'L2', 'L3'] },
  { label: 'a group between the selected layers', stack: ['L1', 'C1', 'C2', 'G', 'L2', 'keep', 'L3'], target: 'G', members: ['L1', 'C1', 'C2', 'L2', 'L3'] },
  { label: 'the root stack', stack: ['keep', 'L1', 'C1', 'L2', 'L3', 'G'], target: null, members: ['keep', 'L1', 'L2', 'L3', 'G'] },
]) {
  test(`moving layers to ${label} keeps their order after every update`, () => {
    const selected = new Set(['L1', 'L2', 'L3']);
    const initial = stack.map((id, i) => mkLayer({
      id,
      sortOrder: (i + 1) * 10,
      layerType: id === 'G' ? 'group' : 'raster',
      parentId: id.startsWith('C') || (target === null && selected.has(id)) ? 'G' : null,
    }));
    const roots = filterTopLevelSelectedLayers(initial, selected);
    const patched = initial.map((l) => selected.has(l.id) ? { ...l, parentId: target } : l);
    const ascendingIds = computeTidiedAscendingNonMaskIds(patched);
    verifySequentialReparenting(initial, roots, target, ascendingIds, members);
  });
}

test('grouping a nested folder along with its child keeps the child inside the inner folder', () => {
  const layers: LayerModel[] = [
    mkLayer({ id: 'inner_child', parentId: 'inner_group', sortOrder: 10 }),
    mkLayer({ id: 'inner_group', layerType: 'group', sortOrder: 20 }),
    mkLayer({ id: 'outer_layer', sortOrder: 30 }),
  ];
  const roots = filterTopLevelSelectedLayers(layers, ['inner_group', 'inner_child', 'outer_layer']);
  assert.deepEqual(roots.map((l) => l.id), ['inner_group', 'outer_layer']);
});

test('selectLayerRange supports Shift+click and Shift+drag sweep (forward, backward, and additive)', () => {
  const visible = ['L7', 'L6', 'L5', 'L4', 'L3', 'L2'];
  // Sweep downward from L6 to L3
  assert.deepEqual([...selectLayerRange(visible, 'L6', 'L3')], ['L6', 'L5', 'L4', 'L3']);
  // Sweep upward from L3 to L6
  assert.deepEqual([...selectLayerRange(visible, 'L3', 'L6')], ['L6', 'L5', 'L4', 'L3']);
  // Shrink sweep back to L5
  assert.deepEqual([...selectLayerRange(visible, 'L6', 'L5')], ['L6', 'L5']);
  // Additive range (Ctrl+Shift) preserves previous selection
  const existing = new Set(['L2']);
  assert.deepEqual([...selectLayerRange(visible, 'L7', 'L6', true, existing)], ['L2', 'L7', 'L6']);
});
